import {
  backendApiErrorResponseSchema,
  backendApiResponseSchemas,
  findSymbolPathsRequestSchema,
} from '@codethread/contracts';
import { z } from 'zod';
import { WorkspaceBffError, workspaceScanIdSchema } from './workspace-bff.ts';

const DEFAULT_BACKEND_ORIGIN = 'http://127.0.0.1:8765';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

export const registerRepositoryBodySchema = z.strictObject({
  locator: z.string().trim().min(1).max(4096),
});

export const triggerScanBodySchema = z.strictObject({
  revision: z.string().trim().min(1).max(1024),
  idempotencyKey: z.string().trim().min(1).max(128),
});

export const workspacePathsBodySchema = z.strictObject({
  projectId: z.string().min(1).max(256),
  request: findSymbolPathsRequestSchema,
});

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  );
}

function backendOrigin(): string {
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

export function sanitizeRepositoryLabel(locator: string): string {
  return (
    locator
      .split(/[\\/]/)
      .filter(Boolean)
      .at(-1)
      ?.replace(/[\p{Cc}\p{Cf}]/gu, '')
      .slice(0, 120) || 'Local repository'
  );
}

async function readBoundedJson(response: Response): Promise<unknown> {
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
  if (length > MAX_RESPONSE_BYTES) {
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
      if (used > MAX_RESPONSE_BYTES) {
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

async function callBackend<R extends keyof typeof backendApiResponseSchemas>(
  route: R,
  path: string,
  method: 'GET' | 'POST',
  options?: { body?: unknown; acceptStatus?: number[] },
): Promise<{
  status: number;
  data: z.infer<(typeof backendApiResponseSchemas)[R]>;
}> {
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
  let encodedBody: string | undefined;
  if (options?.body !== undefined) {
    headers['content-type'] = 'application/json';
    encodedBody = JSON.stringify(options.body);
  }
  let response: Response;
  try {
    response = await fetch(`${origin}${path}`, {
      method,
      headers,
      ...(encodedBody === undefined ? {} : { body: encodedBody }),
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (isTimeoutError(error))
      throw new WorkspaceBffError(
        504,
        'BACKEND_TIMEOUT',
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
  const value = await readBoundedJson(response);
  const accepted =
    response.ok || (options?.acceptStatus?.includes(response.status) ?? false);
  if (!accepted) {
    const parsedError = backendApiErrorResponseSchema.safeParse(value);
    throw new WorkspaceBffError(
      response.status,
      parsedError.success
        ? parsedError.data.error.code
        : 'BACKEND_REQUEST_FAILED',
      parsedError.success
        ? parsedError.data.error.message
        : 'The local backend could not complete this request.',
    );
  }
  try {
    const data = backendApiResponseSchemas[route].parse(value) as z.infer<
      (typeof backendApiResponseSchemas)[R]
    >;
    return { status: response.status, data };
  } catch {
    throw new WorkspaceBffError(
      502,
      'UPSTREAM_CONTRACT_MISMATCH',
      'The local backend response failed contract validation.',
    );
  }
}

export function parseUuidParam(raw: string, label = 'identifier'): string {
  const parsed = workspaceScanIdSchema.safeParse(raw);
  if (!parsed.success)
    throw new WorkspaceBffError(
      400,
      'INVALID_REQUEST',
      `A valid ${label} is required.`,
    );
  return parsed.data;
}

export async function readBackendHealth() {
  const { status, data } = await callBackend(
    'GET /v1/health',
    '/v1/health',
    'GET',
    { acceptStatus: [503] },
  );
  return { status, health: data };
}

export async function registerBackendRepository(rawBody: unknown) {
  const parsed = registerRepositoryBodySchema.safeParse(rawBody);
  if (!parsed.success)
    throw new WorkspaceBffError(
      400,
      'INVALID_REQUEST',
      'Provide a valid repository path inside the permitted root.',
    );
  const { data } = await callBackend(
    'POST /v1/repositories',
    '/v1/repositories',
    'POST',
    { body: parsed.data },
  );
  return {
    id: data.id,
    label: sanitizeRepositoryLabel(data.locator),
  };
}

export async function readBackendRepository(repositoryId: string) {
  const id = parseUuidParam(repositoryId, 'repository identity');
  const { data } = await callBackend(
    'GET /v1/repositories/:id',
    `/v1/repositories/${id}`,
    'GET',
  );
  return {
    id: data.id,
    label: sanitizeRepositoryLabel(data.locator),
    activeScanId: data.active_job_id,
    generation: data.desired_generation,
  };
}

export async function listBackendRepositoryScans(repositoryId: string) {
  const id = parseUuidParam(repositoryId, 'repository identity');
  const { data } = await callBackend(
    'GET /v1/repositories/:id/scans',
    `/v1/repositories/${id}/scans`,
    'GET',
  );
  return { items: data };
}

export async function submitBackendScan(
  repositoryId: string,
  rawBody: unknown,
) {
  const id = parseUuidParam(repositoryId, 'repository identity');
  const parsed = triggerScanBodySchema.safeParse(rawBody);
  if (!parsed.success)
    throw new WorkspaceBffError(
      400,
      'INVALID_REQUEST',
      'Provide a valid revision and idempotency key.',
    );
  const { data } = await callBackend(
    'POST /v1/repositories/:id/scans',
    `/v1/repositories/${id}/scans`,
    'POST',
    { body: parsed.data },
  );
  return data;
}

export async function readBackendScan(scanId: string) {
  const id = parseUuidParam(scanId, 'scan identity');
  const { data } = await callBackend(
    'GET /v1/scans/:id',
    `/v1/scans/${id}`,
    'GET',
  );
  return data;
}

export async function cancelBackendScan(scanId: string) {
  const id = parseUuidParam(scanId, 'scan identity');
  const { data } = await callBackend(
    'POST /v1/scans/:id/cancel',
    `/v1/scans/${id}/cancel`,
    'POST',
  );
  return data;
}

export async function readBackendScanProjects(scanId: string) {
  const id = parseUuidParam(scanId, 'scan identity');
  const { data } = await callBackend(
    'GET /v1/scans/:id/projects',
    `/v1/scans/${id}/projects`,
    'GET',
  );
  return { items: data };
}

export async function readBackendScanFiles(
  scanId: string,
  offsetRaw: string | null,
) {
  const id = parseUuidParam(scanId, 'scan identity');
  let offset = 0;
  if (offsetRaw !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(offsetRaw))
      throw new WorkspaceBffError(
        400,
        'INVALID_REQUEST',
        'Offset must be a non-negative integer.',
      );
    offset = Number(offsetRaw);
    if (offset > 1256)
      throw new WorkspaceBffError(
        400,
        'INVALID_REQUEST',
        'Offset exceeds the file inventory limit.',
      );
  }
  const { data } = await callBackend(
    'GET /v1/scans/:id/files',
    `/v1/scans/${id}/files?offset=${offset}`,
    'GET',
  );
  return data;
}

export async function queryBackendProjectPaths(
  scanId: string,
  rawBody: unknown,
) {
  const id = parseUuidParam(scanId, 'scan identity');
  const parsed = workspacePathsBodySchema.safeParse(rawBody);
  if (!parsed.success)
    throw new WorkspaceBffError(
      400,
      'INVALID_REQUEST',
      'Path query failed contract validation.',
    );
  const { projectId, request } = parsed.data;
  const { data } = await callBackend(
    'POST /v1/scans/:id/projects/:projectId/paths',
    `/v1/scans/${id}/projects/${encodeURIComponent(projectId)}/paths`,
    'POST',
    { body: request },
  );
  return { projectId, result: data };
}
