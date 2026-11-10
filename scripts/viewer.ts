import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AnalysisSnapshot } from '@codethread/symbol-indexer';
import type { RepositoryInvestigationSession } from './investigation/repository-session.ts';
import { TraceError } from '@codethread/trace-engine';
import { z, ZodError } from 'zod';
import { createViewerDataset } from './viewer-dataset.ts';
import type { ViewerInput } from './viewer-dataset.ts';
import { queryViewer } from './viewer-api.ts';
import { ViewerFailure } from './viewer-errors.ts';

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const apiErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
    message: z.string().min(1).max(256),
  }),
});

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
  return createLocalViewer(snapshot);
}

export async function createRepositoryViewer(
  session: RepositoryInvestigationSession,
): Promise<ViewerHandle> {
  return createLocalViewer(session);
}

async function createLocalViewer(input: ViewerInput): Promise<ViewerHandle> {
  const dataset = createViewerDataset(input);
  const token = randomBytes(32).toString('hex');
  const assets = new Map<string, { bytes: Buffer; type: string }>();
  const paths = [
    '/',
    '/viewer.js',
    '/viewer.css',
    '/viewer-client/dom.js',
    '/viewer-client/projection.js',
    '/viewer-client/history.js',
    '/viewer-client/repository.js',
  ];
  const reads = await Promise.allSettled(
    paths.map(async (path) => {
      const file = path === '/' ? './viewer.html' : '.' + path;
      const bytes = await readFile(
        fileURLToPath(new URL(file, import.meta.url)),
      );
      const type =
        path === '/'
          ? 'text/html'
          : path.endsWith('.css')
            ? 'text/css'
            : 'text/javascript';
      assets.set(path, { bytes, type });
    }),
  );
  for (const result of reads)
    if (result.status === 'rejected') throw result.reason;
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
    const asset = assets.get(pathname);
    if (request.method === 'GET' && asset) {
      response.writeHead(200, {
        'Content-Type': asset.type + '; charset=utf-8',
        'Content-Length': asset.bytes.byteLength,
        'Cache-Control': 'no-store',
      });
      response.end(asset.bytes);
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

    if (request.method !== 'POST')
      throw new ViewerFailure(
        'METHOD_NOT_ALLOWED',
        'Use the documented viewer request method.',
        405,
      );
    const body = await readJson(request);
    json(response, queryViewer(dataset, pathname, body));
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
        server.closeAllConnections();
      }),
  };
}

export async function runViewer(snapshot: AnalysisSnapshot): Promise<void> {
  await waitForViewer(await createViewer(snapshot));
}

export async function runRepositoryViewer(
  session: RepositoryInvestigationSession,
): Promise<void> {
  await waitForViewer(await createRepositoryViewer(session));
}

async function waitForViewer(viewer: ViewerHandle): Promise<void> {
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
