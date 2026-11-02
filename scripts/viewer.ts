import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  coverageSchema,
  diagnosticSchema,
  idSchema,
  summarizeCoverage,
  snapshotIdentitySchema,
  symbolSchema,
} from '@codethread/code-model';
import type { CodeSymbol } from '@codethread/code-model';
import {
  getSourceEvidenceRequestSchema,
  graphNeighborsRequestSchema,
  graphNeighborsResponseSchema,
  parseGetSourceEvidenceResult,
  parseGraphNeighborsResult,
} from '@codethread/contracts';
import type { AnalysisSnapshot } from '@codethread/symbol-indexer';
import { createInvestigation, TraceError } from '@codethread/trace-engine';
import { z, ZodError } from 'zod';

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_SYMBOLS_PER_PAGE = 50;
const MAX_GRAPH_DEPTH = 2;
const MAX_GRAPH_NODES = 50;
const MAX_UNKNOWN_ROWS = 50;
const ORDER = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left), Buffer.from(right));

const analysisCountsSchema = z.strictObject({
  files: z.number().int().nonnegative(),
  declarations: z.number().int().nonnegative(),
  callSites: z.number().int().nonnegative(),
  exact: z.number().int().nonnegative(),
  unresolved: z.number().int().nonnegative(),
  ambiguous: z.number().int().nonnegative(),
  unsupported: z.number().int().nonnegative(),
  notAnalyzedInputs: z.number().int().nonnegative(),
});
const sessionResponseSchema = z.strictObject({
  snapshotId: idSchema,
  identity: snapshotIdentitySchema,
  counts: analysisCountsSchema,
  coverage: coverageSchema,
  coverageByCapability: z.record(z.string(), coverageSchema),
});
const symbolSearchRequestSchema = z.strictObject({
  query: z.string().max(256).default(''),
  offset: z.number().int().min(0).max(2000).default(0),
});
const symbolSearchResponseSchema = z.strictObject({
  snapshotId: idSchema,
  query: z.string().max(256),
  offset: z.number().int().min(0).max(2000),
  limit: z.literal(MAX_SYMBOLS_PER_PAGE),
  total: z.number().int().nonnegative(),
  nextOffset: z.number().int().min(0).max(2000).nullable(),
  items: z.array(symbolSchema).max(MAX_SYMBOLS_PER_PAGE),
});
const unsupportedObservationSchema = z.strictObject({
  evidenceId: idSchema,
  status: z.enum(['ambiguous', 'unresolved', 'unsupported']),
  diagnostic: diagnosticSchema.nullable(),
});
const viewerGraphResponseSchema = z.strictObject({
  graph: graphNeighborsResponseSchema,
  unknowns: z.strictObject({
    total: z.number().int().nonnegative(),
    items: z.array(unsupportedObservationSchema).max(MAX_UNKNOWN_ROWS),
  }),
});
const apiErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
    message: z.string().min(1).max(256),
  }),
});

type ViewerFailureCode =
  | 'INVALID_FACTS'
  | 'SOURCE_UNAVAILABLE'
  | 'HASH_MISMATCH'
  | 'SNAPSHOT_NOT_FOUND'
  | 'ENTITY_NOT_FOUND'
  | 'RESOURCE_LIMIT'
  | 'INVALID_REQUEST'
  | 'REQUEST_TOO_LARGE'
  | 'RESPONSE_TOO_LARGE'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'METHOD_NOT_ALLOWED'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'INTERNAL_ERROR';

class ViewerFailure extends Error {
  readonly code: ViewerFailureCode;
  readonly status: number;

  constructor(code: ViewerFailureCode, message: string, status: number) {
    super(message);
    this.name = 'ViewerFailure';
    this.code = code;
    this.status = status;
  }
}

export interface ViewerHandle {
  readonly origin: string;
  readonly url: string;
  close(): Promise<void>;
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  const body = Buffer.from(JSON.stringify(value));
  if (body.byteLength > MAX_RESPONSE_BYTES) {
    sendError(
      response,
      new ViewerFailure(
        'RESPONSE_TOO_LARGE',
        'The result exceeds the viewer response limit.',
        413,
      ),
    );
    return;
  }
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.byteLength,
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function sendError(response: ServerResponse, error: ViewerFailure): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const body = apiErrorSchema.parse({
    error: { code: error.code, message: error.message },
  });
  json(response, body, error.status);
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
  );
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('X-Frame-Options', 'DENY');
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers['content-type']
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== 'application/json')
    throw new ViewerFailure(
      'UNSUPPORTED_MEDIA_TYPE',
      'Requests must use application/json.',
      415,
    );
  const declaredLength = Number(request.headers['content-length'] ?? 0);
  if (declaredLength > MAX_REQUEST_BYTES)
    throw new ViewerFailure(
      'REQUEST_TOO_LARGE',
      'The request exceeds the viewer limit.',
      413,
    );
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > MAX_REQUEST_BYTES)
      throw new ViewerFailure(
        'REQUEST_TOO_LARGE',
        'The request exceeds the viewer limit.',
        413,
      );
    chunks.push(buffer);
  }
  if (byteLength === 0)
    throw new ViewerFailure('INVALID_REQUEST', 'A JSON body is required.', 400);
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks),
    );
    return JSON.parse(text) as unknown;
  } catch {
    throw new ViewerFailure('INVALID_REQUEST', 'Invalid JSON body.', 400);
  }
}

function compareSymbols(left: CodeSymbol, right: CodeSymbol): number {
  return (
    ORDER(left.filePath, right.filePath) ||
    left.range.start.offset - right.range.start.offset ||
    ORDER(left.key, right.key)
  );
}

function traceFailure(error: TraceError): ViewerFailure {
  if (error.code === 'RESOURCE_LIMIT')
    return new ViewerFailure(error.code, error.message, 413);
  if (error.code === 'ENTITY_NOT_FOUND' || error.code === 'SNAPSHOT_NOT_FOUND')
    return new ViewerFailure(error.code, error.message, 404);
  return new ViewerFailure(error.code, error.message, 400);
}

export async function createViewer(
  snapshot: AnalysisSnapshot,
): Promise<ViewerHandle> {
  const investigation = createInvestigation(snapshot.facts, snapshot.source);
  const token = randomBytes(32).toString('hex');
  const page = await readFile(
    fileURLToPath(new URL('./viewer.html', import.meta.url)),
  );
  const script = await readFile(
    fileURLToPath(new URL('./viewer.js', import.meta.url)),
  );
  const styles = await readFile(
    fileURLToPath(new URL('./viewer.css', import.meta.url)),
  );
  let origin = '';

  const server = createServer((request, response) => {
    setSecurityHeaders(response);
    void handleRequest(request, response).catch((error: unknown) => {
      if (error instanceof ViewerFailure) {
        sendError(response, error);
        return;
      }
      if (error instanceof ZodError) {
        sendError(
          response,
          new ViewerFailure(
            'INVALID_REQUEST',
            'Request validation failed.',
            400,
          ),
        );
        return;
      }
      if (error instanceof TraceError) {
        sendError(response, traceFailure(error));
        return;
      }
      sendError(
        response,
        new ViewerFailure('INTERNAL_ERROR', 'Viewer request failed.', 500),
      );
    });
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 5000;
  server.maxConnections = 20;

  async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new ViewerFailure('INTERNAL_ERROR', 'Viewer is unavailable.', 500);
    const expectedHost = `127.0.0.1:${address.port}`;
    if (
      request.headers.host !== expectedHost ||
      request.socket.remoteAddress !== '127.0.0.1'
    )
      throw new ViewerFailure(
        'FORBIDDEN',
        'Local viewer access required.',
        403,
      );

    const pathname = new URL(request.url ?? '/', `http://${expectedHost}`)
      .pathname;
    if (request.method === 'GET' && pathname === '/') {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': page.byteLength,
        'Cache-Control': 'no-store',
      });
      response.end(page);
      return;
    }
    if (request.method === 'GET' && pathname === '/viewer.js') {
      response.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Content-Length': script.byteLength,
        'Cache-Control': 'no-store',
      });
      response.end(script);
      return;
    }
    if (request.method === 'GET' && pathname === '/viewer.css') {
      response.writeHead(200, {
        'Content-Type': 'text/css; charset=utf-8',
        'Content-Length': styles.byteLength,
        'Cache-Control': 'no-store',
      });
      response.end(styles);
      return;
    }
    if (!pathname.startsWith('/api/'))
      throw new ViewerFailure('NOT_FOUND', 'Resource not found.', 404);
    if (request.socket.remoteAddress !== '127.0.0.1')
      throw new ViewerFailure(
        'FORBIDDEN',
        'Local viewer access required.',
        403,
      );
    if (request.headers.origin !== origin)
      throw new ViewerFailure(
        'FORBIDDEN',
        'Same-origin request required.',
        403,
      );
    const suppliedToken = request.headers['x-codethread-token'];
    if (
      typeof suppliedToken !== 'string' ||
      suppliedToken.length !== token.length ||
      !timingSafeEqual(Buffer.from(suppliedToken), Buffer.from(token))
    )
      throw new ViewerFailure(
        'FORBIDDEN',
        'Viewer session token is invalid.',
        403,
      );

    if (request.method === 'POST' && pathname === '/api/session') {
      const body = await readJson(request);
      if (
        body === null ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).length !== 0
      )
        throw new ViewerFailure(
          'INVALID_REQUEST',
          'Session requests take an empty JSON object.',
          400,
        );
      const result = sessionResponseSchema.parse({
        snapshotId: snapshot.facts.snapshotId,
        identity: snapshot.facts.identity,
        counts: snapshot.facts.counts,
        coverage: summarizeCoverage(snapshot.facts.coverageByCapability),
        coverageByCapability: snapshot.facts.coverageByCapability,
      });
      json(response, result);
      return;
    }
    if (request.method !== 'POST')
      throw new ViewerFailure(
        'METHOD_NOT_ALLOWED',
        'Use the documented viewer request method.',
        405,
      );
    const body = await readJson(request);
    if (pathname === '/api/symbols') {
      const query = symbolSearchRequestSchema.parse(body);
      const normalized = query.query.toLowerCase();
      const matches = [...snapshot.facts.symbols]
        .sort(compareSymbols)
        .filter(
          (symbol) =>
            normalized.length === 0 ||
            symbol.name.toLowerCase().includes(normalized) ||
            symbol.filePath.toLowerCase().includes(normalized),
        );
      const items = matches.slice(
        query.offset,
        query.offset + MAX_SYMBOLS_PER_PAGE,
      );
      const next = query.offset + items.length;
      const result = symbolSearchResponseSchema.parse({
        snapshotId: snapshot.facts.snapshotId,
        query: query.query,
        offset: query.offset,
        limit: MAX_SYMBOLS_PER_PAGE,
        total: matches.length,
        nextOffset: next < matches.length ? next : null,
        items,
      });
      json(response, result);
      return;
    }
    if (pathname === '/api/neighbors') {
      const request = graphNeighborsRequestSchema.parse(body);
      if (
        request.depth > MAX_GRAPH_DEPTH ||
        request.nodeLimit > MAX_GRAPH_NODES ||
        request.relationKinds.some(
          (kind) => kind !== 'calls' && kind !== 'references',
        )
      )
        throw new ViewerFailure(
          'INVALID_REQUEST',
          'Graph request exceeds the visual investigation profile.',
          400,
        );
      const graph = parseGraphNeighborsResult(
        request,
        investigation.neighbors(request),
      );
      const owned = snapshot.facts.observations.filter(
        (item) =>
          item.ownerId === request.symbolId &&
          item.status !== 'exact' &&
          item.relationId === null,
      );
      const diagnostics = new Map(
        snapshot.facts.diagnostics.map((item) => [item.id, item]),
      );
      const unknowns = {
        total: owned.length,
        items: owned.slice(0, MAX_UNKNOWN_ROWS).map((item) => ({
          evidenceId: item.evidenceId,
          status: item.status,
          diagnostic: item.diagnosticId
            ? (diagnostics.get(item.diagnosticId) ?? null)
            : null,
        })),
      };
      const result = viewerGraphResponseSchema.parse({ graph, unknowns });
      json(response, result);
      return;
    }
    if (pathname === '/api/evidence') {
      const evidenceRequest = getSourceEvidenceRequestSchema.parse(body);
      const result = parseGetSourceEvidenceResult(
        evidenceRequest,
        investigation.sourceEvidence(evidenceRequest),
      );
      json(response, result);
      return;
    }
    throw new ViewerFailure('NOT_FOUND', 'Resource not found.', 404);
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('Viewer failed to bind an ephemeral loopback port.');
  }
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    url: `${origin}/#${token}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export async function runViewer(snapshot: AnalysisSnapshot): Promise<void> {
  const viewer = await createViewer(snapshot);
  process.stdout.write(
    `CodeThread local visual investigation: ${viewer.url}\nPress Ctrl+C to stop.\n`,
  );
  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      void viewer.close().then(resolve, resolve);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
