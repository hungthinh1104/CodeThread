import {
  backendApiErrorResponseSchema,
  backendApiResponseSchemas,
} from '@codethread/contracts';
import {
  DEFAULT_BACKEND_ORIGIN,
  isTimeoutError,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  REQUEST_TIMEOUT_MS,
  WorkspaceBffError,
} from './bff-types.ts';

export function backendOrigin(): string {
  let origin: URL;
  try {
    origin = new URL(
      process.env.CODETHREAD_API_ORIGIN ?? DEFAULT_BACKEND_ORIGIN,
    );
  } catch {
    throw new WorkspaceBffError(
      503,
      'BACKEND_NOT_CONFIGURED',
      'The local CodeThread backend address is invalid.',
    );
  }
  if (
    origin.protocol !== 'http:' ||
    origin.hostname !== '127.0.0.1' ||
    !/^\d{1,5}$/.test(origin.port) ||
    Number(origin.port) < 1 ||
    Number(origin.port) > 65535 ||
    origin.pathname !== '/' ||
    origin.search !== '' ||
    origin.hash !== '' ||
    origin.username !== '' ||
    origin.password !== ''
  )
    throw new WorkspaceBffError(
      503,
      'BACKEND_NOT_CONFIGURED',
      'The local CodeThread backend address must use IPv4 loopback.',
    );
  return origin.origin;
}

export async function parseRequestJson(request: Request): Promise<unknown> {
  const contentType = request.headers
    .get('content-type')
    ?.split(';')[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== 'application/json')
    throw new WorkspaceBffError(
      415,
      'INVALID_MEDIA_TYPE',
      'JSON request body required.',
    );
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > MAX_REQUEST_BYTES)
    throw new WorkspaceBffError(
      413,
      'REQUEST_TOO_LARGE',
      'Request exceeds the local workspace limit.',
    );
  const reader = request.body?.getReader();
  if (!reader)
    throw new WorkspaceBffError(
      400,
      'INVALID_REQUEST',
      'JSON request body required.',
    );
  const chunks: Uint8Array[] = [];
  let used = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      used += value.byteLength;
      if (used > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new WorkspaceBffError(
          413,
          'REQUEST_TOO_LARGE',
          'Request exceeds the local workspace limit.',
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (used === 0)
    throw new WorkspaceBffError(
      400,
      'INVALID_REQUEST',
      'JSON request body required.',
    );
  const bytes = new Uint8Array(used);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new WorkspaceBffError(400, 'INVALID_JSON', 'Malformed JSON body.');
  }
}

export async function boundedJson(
  response: Response,
  maxBytes = MAX_RESPONSE_BYTES,
): Promise<unknown> {
  const mediaType = response.headers
    .get('content-type')
    ?.split(';')[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== 'application/json') {
    await response.body?.cancel();
    throw new WorkspaceBffError(
      502,
      'UPSTREAM_INVALID_RESPONSE',
      'Local service returned an invalid response.',
    );
  }
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > maxBytes) {
    await response.body?.cancel();
    throw new WorkspaceBffError(
      502,
      'UPSTREAM_RESPONSE_TOO_LARGE',
      'Local service response exceeds the workspace limit.',
    );
  }
  const reader = response.body?.getReader();
  if (!reader)
    throw new WorkspaceBffError(
      502,
      'UPSTREAM_INVALID_RESPONSE',
      'Local service returned an empty response.',
    );
  const chunks: Uint8Array[] = [];
  let used = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      used += value.byteLength;
      if (used > maxBytes) {
        await reader.cancel();
        throw new WorkspaceBffError(
          502,
          'UPSTREAM_RESPONSE_TOO_LARGE',
          'Local service response exceeds the workspace limit.',
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(used);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new WorkspaceBffError(
      502,
      'UPSTREAM_INVALID_RESPONSE',
      'Local service returned malformed data.',
    );
  }
}

export async function backendRequest(
  route: keyof typeof backendApiResponseSchemas,
  path: string,
  method: 'GET' | 'POST',
  options?: {
    body?: unknown;
    timeoutMs?: number;
    maxResponseBytes?: number;
    timeoutCode?: string;
  },
): Promise<unknown> {
  const token = process.env.CODETHREAD_API_TOKEN;
  if (!token)
    throw new WorkspaceBffError(
      503,
      'BACKEND_NOT_CONFIGURED',
      'The local CodeThread backend is not configured.',
    );
  const origin = backendOrigin();
  const headers: Record<string, string> = {
    accept: 'application/json',
    authorization: `Bearer ${token}`,
  };
  let serializedBody: string | undefined;
  if (options?.body !== undefined) {
    headers['content-type'] = 'application/json';
    serializedBody = JSON.stringify(options.body);
  }
  let response: Response;
  try {
    response = await fetch(`${origin}${path}`, {
      method,
      headers,
      ...(serializedBody !== undefined ? { body: serializedBody } : {}),
      redirect: 'manual',
      signal: AbortSignal.timeout(options?.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (isTimeoutError(error))
      throw new WorkspaceBffError(
        504,
        options?.timeoutCode ?? 'BACKEND_TIMEOUT',
        'The local CodeThread backend timed out.',
      );
    throw new WorkspaceBffError(
      503,
      'BACKEND_UNAVAILABLE',
      'The local CodeThread backend is unavailable.',
    );
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new WorkspaceBffError(
      502,
      'UPSTREAM_REDIRECT_REJECTED',
      'The local backend returned an unexpected redirect.',
    );
  }
  const value = await boundedJson(response, options?.maxResponseBytes);
  if (!response.ok) {
    const error = backendApiErrorResponseSchema.safeParse(value);
    throw new WorkspaceBffError(
      response.status,
      error.success ? error.data.error.code : 'BACKEND_REQUEST_FAILED',
      'The local backend could not complete this request.',
    );
  }
  try {
    return backendApiResponseSchemas[route].parse(value);
  } catch {
    throw new WorkspaceBffError(
      502,
      'UPSTREAM_CONTRACT_MISMATCH',
      'The local backend response failed contract validation.',
    );
  }
}

export function parseViewerAddress(urlValue: string, expiresAt: string) {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw new WorkspaceBffError(
      502,
      'VIEWER_ADDRESS_REJECTED',
      'The local viewer returned an invalid address.',
    );
  }
  const token = url.hash.slice(1);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !/^\d{1,5}$/.test(url.port) ||
    Number(url.port) < 1 ||
    Number(url.port) > 65535 ||
    url.pathname !== '/' ||
    url.search !== '' ||
    !/^[a-f0-9]{64}$/.test(token) ||
    url.username !== '' ||
    url.password !== ''
  )
    throw new WorkspaceBffError(
      502,
      'VIEWER_ADDRESS_REJECTED',
      'The local viewer returned an unsafe address.',
    );
  const expiry = Date.parse(expiresAt);
  const now = Date.now();
  if (!Number.isFinite(expiry) || expiry <= now || expiry > now + 31 * 60_000)
    throw new WorkspaceBffError(
      502,
      'VIEWER_EXPIRY_REJECTED',
      'The local viewer returned an invalid expiry.',
    );
  url.hash = '';
  return { viewerOrigin: url.origin, viewerToken: token, expiresAt: expiry };
}
