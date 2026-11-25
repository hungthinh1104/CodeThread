import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { URL } from 'node:url';
import { z, ZodError } from 'zod';
import { tokenMatch, registerRepository, requestScan, uuid } from './config.ts';
import type { Database } from './database.ts';
import { ScanService, ServiceError } from './service.ts';
import { BackendQueryService } from './query-service.ts';
import { BackendAiService } from './ai-service.ts';
import type { BackendAiServiceOptions } from './ai-service.ts';
import { loadAiConfig } from '../ai/index.ts';
import type { AiConfig } from '../ai/index.ts';
import type { PersistentViewerManager } from './viewer-adapter.ts';
import {
  parseBackendErrorResponse,
  parseBackendResponse,
} from './http-contracts.ts';
import type { BackendApiRoute } from './http-contracts.ts';

const MAX_BODY = 64 * 1024;
const MAX_AI_BODY = 4 * 1024;
const MAX_RESPONSE = 1024 * 1024;
const MAX_AI_RESPONSE = 64 * 1024;
const MAX_CONNECTIONS = 64;
const REQUEST_TIMEOUT_MS = 30_000;
const HEADERS_TIMEOUT_MS = 10_000;
const queryInventory = z.strictObject({
  offset: z.number().int().min(0).max(1256).default(0),
});

export type MakeApiAiInput =
  | AiConfig
  | BackendAiService
  | ({ config: AiConfig } & BackendAiServiceOptions);

function resolveAiService(
  queries: BackendQueryService,
  input?: MakeApiAiInput,
): BackendAiService {
  if (input instanceof BackendAiService) return input;
  if (input && 'config' in input) {
    const { config, ...options } = input;
    return new BackendAiService(queries, config, options);
  }
  return new BackendAiService(queries, input ?? loadAiConfig());
}

export function makeApi(
  db: Database,
  service: ScanService,
  secret: string,
  port: number,
  viewers?: PersistentViewerManager,
  ai?: MakeApiAiInput,
) {
  const queries = new BackendQueryService(db, service);
  const aiService = resolveAiService(queries, ai);
  const requestHandler = async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none'",
    );
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    try {
      if (!req.url || !req.method)
        throw new ServiceError(400, 'INVALID_REQUEST', 'Missing method or URL');
      if (req.headers.host !== '127.0.0.1:' + port)
        throw new ServiceError(
          403,
          'INVALID_HOST',
          'Localhost host header required',
        );
      if (
        req.headers.origin &&
        req.headers.origin !== 'http://127.0.0.1:' + port
      )
        throw new ServiceError(
          403,
          'INVALID_ORIGIN',
          'Cross-origin requests are disabled',
        );
      if (!tokenMatch(req.headers.authorization, secret))
        throw new ServiceError(401, 'UNAUTHORIZED', 'Bearer token required');
      const url = new URL(req.url, 'http://127.0.0.1:' + port);
      let p: string[];
      try {
        p = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      } catch {
        throw new ServiceError(
          400,
          'INVALID_REQUEST',
          'Invalid URL path encoding',
        );
      }
      const is = (method: string, ...components: string[]) =>
        req.method === method &&
        p.length === components.length &&
        p.every((part, i) => components[i] === '*' || part === components[i]);
      let result: unknown;
      let responseRoute: BackendApiRoute | undefined;
      let responseStatus = 200;
      if (is('GET', 'v1', 'health')) {
        assertQueryParameters(url);
        let database: 'ready' | 'unavailable' = 'ready';
        try {
          await db`SELECT 1`;
        } catch {
          database = 'unavailable';
        }
        const worker = service.workerReady ? 'ready' : 'unavailable',
          ready = database === 'ready' && worker === 'ready';
        result = { api: 'ready', database, worker, ready };
        responseRoute = 'GET /v1/health';
        if (!ready) responseStatus = 503;
      } else if (is('POST', 'v1', 'repositories')) {
        assertQueryParameters(url);
        const input = registerRepository.parse(await readJson(req));
        result = await service.register(input.locator);
        responseRoute = 'POST /v1/repositories';
      } else if (is('GET', 'v1', 'repositories')) {
        assertQueryParameters(url);
        result = await service.repositories();
        responseRoute = 'GET /v1/repositories';
      } else if (is('GET', 'v1', 'repositories', '*')) {
        assertQueryParameters(url);
        result = await service.repository(uuid.parse(p[2]));
        responseRoute = 'GET /v1/repositories/:id';
      } else if (is('POST', 'v1', 'repositories', '*', 'scans')) {
        assertQueryParameters(url);
        const input = requestScan.parse(await readJson(req));
        result = await service.accept(
          uuid.parse(p[2]),
          input.revision,
          input.idempotencyKey,
        );
        responseRoute = 'POST /v1/repositories/:id/scans';
      } else if (is('GET', 'v1', 'scans', '*')) {
        assertQueryParameters(url);
        result = await service.job(uuid.parse(p[2]));
        responseRoute = 'GET /v1/scans/:id';
      } else if (is('POST', 'v1', 'scans', '*', 'viewer')) {
        assertQueryParameters(url);
        await assertNoBody(req);
        if (!viewers)
          throw new ServiceError(
            503,
            'VIEWER_UNAVAILABLE',
            'Persistent viewer adapter is not configured.',
          );
        result = await viewers.open(uuid.parse(p[2]));
        responseRoute = 'POST /v1/scans/:id/viewer';
      } else if (is('POST', 'v1', 'scans', '*', 'cancel')) {
        assertQueryParameters(url);
        await assertNoBody(req);
        result = await service.cancel(uuid.parse(p[2]));
        responseRoute = 'POST /v1/scans/:id/cancel';
      } else if (is('GET', 'v1', 'scans', '*', 'projects')) {
        assertQueryParameters(url);
        result = await service.projects(uuid.parse(p[2]));
        responseRoute = 'GET /v1/scans/:id/projects';
      } else if (is('GET', 'v1', 'scans', '*', 'files')) {
        assertQueryParameters(url, ['offset']);
        const offset = queryOffset(url);
        result = await service.files(
          uuid.parse(p[2]),
          queryInventory.parse({ offset }).offset,
        );
        responseRoute = 'GET /v1/scans/:id/files';
      } else if (is('GET', 'v1', 'scans', '*', 'projects', '*', 'symbols')) {
        assertQueryParameters(url, ['query', 'offset']);
        result = await queries.symbols(uuid.parse(p[2]), p[4]!, {
          query: url.searchParams.get('query') ?? '',
          offset: queryOffset(url),
        });
        responseRoute = 'GET /v1/scans/:id/projects/:projectId/symbols';
      } else if (
        is('POST', 'v1', 'scans', '*', 'projects', '*', 'neighbors') ||
        is('POST', 'v1', 'scans', '*', 'projects', '*', 'paths') ||
        is('POST', 'v1', 'scans', '*', 'projects', '*', 'evidence')
      ) {
        assertQueryParameters(url);
        result = await queries.project(
          uuid.parse(p[2]),
          p[4]!,
          p[5] as 'neighbors' | 'paths' | 'evidence',
          await readJson(req),
        );
        responseRoute =
          p[5] === 'neighbors'
            ? 'POST /v1/scans/:id/projects/:projectId/neighbors'
            : p[5] === 'paths'
              ? 'POST /v1/scans/:id/projects/:projectId/paths'
              : 'POST /v1/scans/:id/projects/:projectId/evidence';
      } else if (is('GET', 'v1', 'ai', 'status')) {
        assertQueryParameters(url);
        result = aiService.status();
        responseRoute = 'GET /v1/ai/status';
      } else if (
        is('POST', 'v1', 'scans', '*', 'projects', '*', 'ai', 'synthesize')
      ) {
        assertQueryParameters(url);
        result = await aiService.synthesize(
          uuid.parse(p[2]),
          p[4]!,
          await readJson(req, MAX_AI_BODY),
        );
        responseRoute = 'POST /v1/scans/:id/projects/:projectId/ai/synthesize';
      } else throw new ServiceError(404, 'NOT_FOUND', 'Endpoint not found');
      if (!responseRoute)
        throw new Error('Matched route has no response contract');
      const maxResponseBytes =
        responseRoute === 'POST /v1/scans/:id/projects/:projectId/ai/synthesize'
          ? MAX_AI_RESPONSE
          : MAX_RESPONSE;
      send(
        res,
        responseStatus,
        parseBackendResponse(responseRoute, result),
        maxResponseBytes,
      );
    } catch (e) {
      if (e instanceof ZodError)
        send(
          res,
          400,
          parseBackendErrorResponse({
            error: {
              code: 'INVALID_REQUEST',
              message: 'Invalid request payload',
            },
          }),
        );
      else if (e instanceof ServiceError)
        send(
          res,
          e.status,
          parseBackendErrorResponse({
            error: { code: e.code, message: e.message },
          }),
        );
      else {
        console.error('API error', e);
        send(
          res,
          500,
          parseBackendErrorResponse({
            error: { code: 'INTERNAL_ERROR', message: 'Request failed' },
          }),
        );
      }
    }
  };
  const server = createServer(
    {
      requestTimeout: REQUEST_TIMEOUT_MS,
      headersTimeout: HEADERS_TIMEOUT_MS,
      connectionsCheckingInterval: 1_000,
      keepAliveTimeout: 5_000,
    },
    requestHandler,
  );
  server.maxConnections = MAX_CONNECTIONS;
  server.maxRequestsPerSocket = 100;
  return server;
}
async function readJson(
  req: IncomingMessage,
  maxBytes = MAX_BODY,
): Promise<unknown> {
  const media = req.headers['content-type']
    ?.split(';')[0]
    ?.trim()
    .toLowerCase();
  if (media !== 'application/json')
    throw new ServiceError(415, 'INVALID_MEDIA_TYPE', 'JSON body required');
  const n = Number(req.headers['content-length'] ?? 0);
  if (n > maxBytes)
    throw new ServiceError(
      413,
      'REQUEST_TOO_LARGE',
      'Request exceeds size limit',
    );
  const parts: Buffer[] = [];
  let used = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    used += bytes.length;
    if (used > maxBytes)
      throw new ServiceError(
        413,
        'REQUEST_TOO_LARGE',
        'Request exceeds size limit',
      );
    parts.push(bytes);
  }
  if (!used)
    throw new ServiceError(400, 'INVALID_REQUEST', 'JSON body required');
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)),
    );
  } catch {
    throw new ServiceError(400, 'INVALID_JSON', 'Malformed JSON');
  }
}

function assertQueryParameters(url: URL, allowed: readonly string[] = []) {
  const seen = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || seen.has(key))
      throw new ServiceError(
        400,
        'INVALID_REQUEST',
        'Unexpected or repeated query parameter',
      );
    seen.add(key);
  }
}

function queryOffset(url: URL): number {
  const value = url.searchParams.get('offset');
  if (value === null) return 0;
  if (!/^(0|[1-9][0-9]*)$/.test(value))
    throw new ServiceError(
      400,
      'INVALID_REQUEST',
      'Offset must be a base-10 integer',
    );
  return Number(value);
}

async function assertNoBody(req: IncomingMessage): Promise<void> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > MAX_BODY)
    throw new ServiceError(
      413,
      'REQUEST_TOO_LARGE',
      'Request exceeds size limit',
    );
  let used = 0;
  for await (const chunk of req) {
    used += Buffer.isBuffer(chunk)
      ? chunk.byteLength
      : Buffer.byteLength(chunk);
    if (used > MAX_BODY)
      throw new ServiceError(
        413,
        'REQUEST_TOO_LARGE',
        'Request exceeds size limit',
      );
  }
  if (used > 0)
    throw new ServiceError(
      400,
      'INVALID_REQUEST',
      'Request body is not accepted',
    );
}

function send(
  res: ServerResponse,
  status: number,
  data: unknown,
  maxBytes = MAX_RESPONSE,
) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  let bytes = Buffer.from(JSON.stringify(data));
  if (bytes.length > maxBytes) {
    status = 413;
    bytes = Buffer.from(
      JSON.stringify({
        error: {
          code: 'RESPONSE_TOO_LARGE',
          message: 'Result exceeds API response limit',
        },
      }),
    );
  }
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': bytes.length,
  });
  res.end(bytes);
}
