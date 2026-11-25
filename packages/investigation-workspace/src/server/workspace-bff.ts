import { randomBytes } from 'node:crypto';
import {
  aiStatusResponseSchema,
  aiSynthesisResponseSchema,
  aiSynthesizeApiRequestSchema,
  backendApiErrorResponseSchema,
  backendApiResponseSchemas,
  viewerApiRepositoryRequestSchemas,
  viewerApiResponseSchemas,
} from '@codethread/contracts';
import type {
  AiStatusResponse,
  AiSynthesisResponse,
} from '@codethread/contracts';
import { z } from 'zod';

const DEFAULT_BACKEND_ORIGIN = 'http://127.0.0.1:8765';
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_AI_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 5000;
const AI_REQUEST_TIMEOUT_MS = 30_000;
const MAX_SESSIONS = 4;
const SESSION_REUSE_MARGIN_MS = 5_000;
const workspaceAiRequestSchema = z.strictObject({
  projectId: z.string().min(1).max(256),
  request: aiSynthesizeApiRequestSchema,
});

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  );
}

function isStaleViewerError(error: unknown): boolean {
  if (!(error instanceof WorkspaceBffError)) return false;
  return (
    error.code === 'VIEWER_UNAVAILABLE' ||
    error.code === 'UPSTREAM_INVALID_RESPONSE' ||
    error.status === 401 ||
    error.status === 403 ||
    error.status === 404
  );
}
export const workspaceScanIdSchema = z
  .uuid()
  .transform((id) => id.toLowerCase());
const openWorkspaceRequestSchema = z.strictObject({
  scanId: workspaceScanIdSchema,
});
const sessionIdSchema = z.string().regex(/^[a-f0-9]{64}$/);

type WorkspaceSession = {
  viewerOrigin: string;
  viewerToken: string;
  expiresAt: number;
  metadata: WorkspaceMetadata;
};

export type WorkspaceMetadata = {
  repositoryId: string;
  scanId: string;
  commitId: string;
  revision: string;
  expiresAt: string;
};

type SessionRegistry = Map<string, WorkspaceSession>;
type ServerGlobal = typeof globalThis & {
  codethreadWorkspaceSessions?: SessionRegistry;
  codethreadWorkspacePendingOpens?: { count: number };
};

const serverGlobal = globalThis as ServerGlobal;
const sessions = (serverGlobal.codethreadWorkspaceSessions ??= new Map());
const pendingOpens = (serverGlobal.codethreadWorkspacePendingOpens ??= {
  count: 0,
});

export class WorkspaceBffError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
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

export async function listRepositories() {
  const rows = (await backendRequest(
    'GET /v1/repositories',
    '/v1/repositories',
    'GET',
  )) as z.infer<(typeof backendApiResponseSchemas)['GET /v1/repositories']>;
  return {
    items: rows.map((repository) => {
      const label =
        repository.locator
          .split(/[\\/]/)
          .filter(Boolean)
          .at(-1)
          ?.replace(/[\p{Cc}\p{Cf}]/gu, '�')
          .slice(0, 120) || 'Local repository';
      return {
        id: repository.id,
        label,
        activeScanId: repository.active_job_id,
        generation: repository.desired_generation,
      };
    }),
  };
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

async function boundedJson(
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

async function backendRequest(
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

function parseViewerAddress(urlValue: string, expiresAt: string) {
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

function cleanupSessions(now = Date.now()): void {
  for (const [id, session] of sessions)
    if (session.expiresAt <= now) sessions.delete(id);
}

export function parseOpenWorkspaceScan(value: unknown): string {
  const parsed = openWorkspaceRequestSchema.safeParse(value);
  if (!parsed.success)
    throw new WorkspaceBffError(
      400,
      'INVALID_REQUEST',
      'Choose a valid scan to open.',
    );
  return parsed.data.scanId;
}

export async function openWorkspace(
  scanId: string,
  existingSessionId?: string,
): Promise<{ sessionId: string; metadata: WorkspaceMetadata }> {
  cleanupSessions();
  if (existingSessionId) {
    const existing = sessions.get(existingSessionId);
    if (existing?.metadata.scanId === scanId) {
      if (existing.expiresAt - Date.now() < SESSION_REUSE_MARGIN_MS) {
        sessions.delete(existingSessionId);
      } else {
        try {
          await forwardViewerOperation(
            existingSessionId,
            scanId,
            'projects',
            {},
          );
          return { sessionId: existingSessionId, metadata: existing.metadata };
        } catch (error) {
          if (!isStaleViewerError(error)) throw error;
          sessions.delete(existingSessionId);
        }
      }
    }
  }
  if (sessions.size + pendingOpens.count >= MAX_SESSIONS)
    throw new WorkspaceBffError(
      429,
      'WORKSPACE_CAPACITY',
      'Too many local workspace sessions are active. Retry after a session expires.',
    );
  pendingOpens.count++;
  try {
    return await createWorkspaceSession(scanId);
  } finally {
    pendingOpens.count--;
  }
}

async function createWorkspaceSession(scanId: string) {
  const scan = (await backendRequest(
    'GET /v1/scans/:id',
    `/v1/scans/${scanId}`,
    'GET',
  )) as z.infer<(typeof backendApiResponseSchemas)['GET /v1/scans/:id']>;
  if (scan.id !== scanId)
    throw new WorkspaceBffError(
      502,
      'UPSTREAM_CONTRACT_MISMATCH',
      'The local backend returned a different scan.',
    );
  if (scan.state !== 'succeeded' || !scan.git_commit_oid)
    throw new WorkspaceBffError(
      409,
      'SCAN_NOT_READY',
      'Choose a scan with a published snapshot.',
    );
  const viewer = (await backendRequest(
    'POST /v1/scans/:id/viewer',
    `/v1/scans/${scanId}/viewer`,
    'POST',
  )) as z.infer<
    (typeof backendApiResponseSchemas)['POST /v1/scans/:id/viewer']
  >;
  const address = parseViewerAddress(viewer.url, viewer.expiresAt);
  const sessionId = randomBytes(32).toString('hex');
  const metadata: WorkspaceMetadata = {
    repositoryId: scan.repository_id,
    scanId: scan.id,
    commitId: scan.git_commit_oid,
    revision: scan.revision_selector,
    expiresAt: viewer.expiresAt,
  };
  sessions.set(sessionId, { ...address, metadata });
  return { sessionId, metadata };
}

function requireWorkspaceSession(
  sessionId: string | undefined,
  scanId: string,
) {
  cleanupSessions();
  const session =
    sessionId && sessionIdSchema.safeParse(sessionId).success
      ? sessions.get(sessionId)
      : undefined;
  if (!session)
    throw new WorkspaceBffError(
      401,
      'WORKSPACE_SESSION_EXPIRED',
      'Reopen a scan to continue this investigation.',
    );
  if (session.metadata.scanId !== scanId)
    throw new WorkspaceBffError(
      409,
      'WORKSPACE_SCAN_MISMATCH',
      'The local workspace session belongs to a different scan.',
    );
  return session;
}

export async function workspaceMetadata(
  sessionId: string | undefined,
  scanId: string,
) {
  const session = requireWorkspaceSession(sessionId, scanId);
  try {
    await forwardViewerOperation(sessionId, scanId, 'projects', {});
  } catch (error) {
    if (isStaleViewerError(error)) {
      if (sessionId) sessions.delete(sessionId);
      throw new WorkspaceBffError(
        401,
        'WORKSPACE_SESSION_EXPIRED',
        'Reopen a scan to continue this investigation.',
      );
    }
    throw error;
  }
  return session.metadata;
}

export async function forwardViewerOperation(
  sessionId: string | undefined,
  scanId: string,
  operation: string,
  value: unknown,
): Promise<unknown> {
  const session = requireWorkspaceSession(sessionId, scanId);
  const pathname = `/api/${operation}`;
  const requestSchema =
    viewerApiRepositoryRequestSchemas[
      pathname as keyof typeof viewerApiRepositoryRequestSchemas
    ];
  const responseSchema =
    viewerApiResponseSchemas[pathname as keyof typeof viewerApiResponseSchemas];
  if (!requestSchema || !responseSchema)
    throw new WorkspaceBffError(
      404,
      'WORKSPACE_OPERATION_NOT_FOUND',
      'The requested workspace operation is not available.',
    );
  let body: unknown;
  try {
    body = requestSchema.parse(value);
  } catch {
    throw new WorkspaceBffError(
      400,
      'INVALID_REQUEST',
      'Workspace request failed contract validation.',
    );
  }
  let response: Response;
  try {
    response = await fetch(`${session.viewerOrigin}${pathname}`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        origin: session.viewerOrigin,
        'x-codethread-token': session.viewerToken,
      },
      body: JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (isTimeoutError(error))
      throw new WorkspaceBffError(
        504,
        'VIEWER_TIMEOUT',
        'The local snapshot viewer timed out.',
      );
    throw new WorkspaceBffError(
      503,
      'VIEWER_UNAVAILABLE',
      'The local snapshot viewer is unavailable.',
    );
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new WorkspaceBffError(
      502,
      'UPSTREAM_REDIRECT_REJECTED',
      'The local viewer returned an unexpected redirect.',
    );
  }
  const result = await boundedJson(response);
  if (!response.ok) {
    const error = backendApiErrorResponseSchema.safeParse(result);
    throw new WorkspaceBffError(
      response.status,
      error.success ? error.data.error.code : 'VIEWER_REQUEST_FAILED',
      'The local snapshot viewer could not complete this request.',
    );
  }
  try {
    return responseSchema.parse(result);
  } catch {
    throw new WorkspaceBffError(
      502,
      'UPSTREAM_CONTRACT_MISMATCH',
      'The local viewer response failed contract validation.',
    );
  }
}

export async function aiStatus(): Promise<AiStatusResponse> {
  const value = await backendRequest(
    'GET /v1/ai/status',
    '/v1/ai/status',
    'GET',
  );
  return aiStatusResponseSchema.parse(value);
}

export async function synthesizeWorkspaceAi(
  sessionId: string | undefined,
  scanId: string,
  value: unknown,
): Promise<AiSynthesisResponse> {
  requireWorkspaceSession(sessionId, scanId);
  const parsed = workspaceAiRequestSchema.safeParse(value);
  if (!parsed.success)
    throw new WorkspaceBffError(
      400,
      'INVALID_REQUEST',
      'Workspace AI synthesis request failed contract validation.',
    );
  const rawResult = await backendRequest(
    'POST /v1/scans/:id/projects/:projectId/ai/synthesize',
    `/v1/scans/${scanId}/projects/${encodeURIComponent(parsed.data.projectId)}/ai/synthesize`,
    'POST',
    {
      body: parsed.data.request,
      timeoutMs: AI_REQUEST_TIMEOUT_MS,
      maxResponseBytes: MAX_AI_RESPONSE_BYTES,
      timeoutCode: 'AI_PROVIDER_TIMEOUT',
    },
  );
  const result = aiSynthesisResponseSchema.parse(rawResult);
  if (
    result.snapshotId !== parsed.data.request.neighbors.snapshotId ||
    result.rootSymbolId !== parsed.data.request.neighbors.symbolId ||
    result.task !== parsed.data.request.task
  ) {
    throw new WorkspaceBffError(
      502,
      'UPSTREAM_CONTRACT_MISMATCH',
      'The local backend returned AI notes for a different context.',
    );
  }
  return result;
}
