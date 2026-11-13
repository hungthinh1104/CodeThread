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
import type { PersistentViewerManager } from './viewer-adapter.ts';

const MAX_BODY = 64 * 1024;
const MAX_RESPONSE = 1024 * 1024;
const queryInventory = z.strictObject({
  offset: z.number().int().min(0).max(1000).default(0),
});
export function makeApi(
  db: Database,
  service: ScanService,
  secret: string,
  port: number,
  viewers?: PersistentViewerManager,
) {
  const queries = new BackendQueryService(db, service);
  const server = createServer(async (req, res) => {
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
      const p = url.pathname.split('/').filter(Boolean);
      const is = (method: string, ...components: string[]) =>
        req.method === method &&
        p.length === components.length &&
        p.every((part, i) => components[i] === '*' || part === components[i]);
      let result: unknown;
      let responseStatus = 200;
      if (is('GET', 'v1', 'health')) {
        let database: 'ready' | 'unavailable' = 'ready';
        try {
          await db`SELECT 1`;
        } catch {
          database = 'unavailable';
        }
        const worker = service.workerReady ? 'ready' : 'unavailable',
          ready = database === 'ready' && worker === 'ready';
        result = { api: 'ready', database, worker, ready };
        if (!ready) responseStatus = 503;
      } else if (is('POST', 'v1', 'repositories')) {
        const input = registerRepository.parse(await readJson(req));
        result = await service.register(input.locator);
      } else if (is('GET', 'v1', 'repositories'))
        result = await service.repositories();
      else if (is('GET', 'v1', 'repositories', '*'))
        result = await service.repository(uuid.parse(p[2]));
      else if (is('POST', 'v1', 'repositories', '*', 'scans')) {
        const input = requestScan.parse(await readJson(req));
        result = await service.accept(
          uuid.parse(p[2]),
          input.revision,
          input.idempotencyKey,
        );
      } else if (is('GET', 'v1', 'scans', '*'))
        result = await service.job(uuid.parse(p[2]));
      else if (is('POST', 'v1', 'scans', '*', 'viewer')) {
        if (!viewers)
          throw new ServiceError(
            503,
            'VIEWER_UNAVAILABLE',
            'Persistent viewer adapter is not configured.',
          );
        result = await viewers.open(uuid.parse(p[2]));
      } else if (is('POST', 'v1', 'scans', '*', 'cancel'))
        result = await service.cancel(uuid.parse(p[2]));
      else if (is('GET', 'v1', 'scans', '*', 'projects'))
        result = await service.projects(uuid.parse(p[2]));
      else if (is('GET', 'v1', 'scans', '*', 'files')) {
        const offset = Number(url.searchParams.get('offset') ?? 0);
        result = await service.files(
          uuid.parse(p[2]),
          queryInventory.parse({ offset }).offset,
        );
      } else if (
        p.length === 6 &&
        p[0] === 'v1' &&
        p[1] === 'scans' &&
        p[3] === 'projects' &&
        req.method === 'GET' &&
        p[5] === 'symbols'
      ) {
        result = await queries.symbols(uuid.parse(p[2]), p[4]!, {
          query: url.searchParams.get('query') ?? '',
          offset: Number(url.searchParams.get('offset') ?? 0),
        });
      } else if (
        p.length === 6 &&
        p[0] === 'v1' &&
        p[1] === 'scans' &&
        p[3] === 'projects' &&
        req.method === 'POST' &&
        ['neighbors', 'paths', 'evidence'].includes(p[5]!)
      ) {
        result = await queries.project(
          uuid.parse(p[2]),
          p[4]!,
          p[5] as 'neighbors' | 'paths' | 'evidence',
          await readJson(req),
        );
      } else throw new ServiceError(404, 'NOT_FOUND', 'Endpoint not found');
      send(res, responseStatus, result);
    } catch (e) {
      if (e instanceof ZodError)
        send(res, 400, {
          error: {
            code: 'INVALID_REQUEST',
            message: 'Invalid request payload',
          },
        });
      else if (e instanceof ServiceError)
        send(res, e.status, { error: { code: e.code, message: e.message } });
      else {
        console.error('API error', e);
        send(res, 500, {
          error: { code: 'INTERNAL_ERROR', message: 'Request failed' },
        });
      }
    }
  });
  return server;
}
async function readJson(req: IncomingMessage): Promise<unknown> {
  const media = req.headers['content-type']
    ?.split(';')[0]
    ?.trim()
    .toLowerCase();
  if (media !== 'application/json')
    throw new ServiceError(415, 'INVALID_MEDIA_TYPE', 'JSON body required');
  const n = Number(req.headers['content-length'] ?? 0);
  if (n > MAX_BODY)
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
    if (used > MAX_BODY)
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
function send(res: ServerResponse, status: number, data: unknown) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  let bytes = Buffer.from(JSON.stringify(data));
  if (bytes.length > MAX_RESPONSE) {
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
