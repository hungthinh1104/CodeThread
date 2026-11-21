import { randomBytes } from 'node:crypto';
import {
  backendApiErrorResponseSchema,
  backendApiResponseSchemas,
  viewerApiRepositoryRequestSchemas,
  viewerApiResponseSchemas,
} from '@codethread/contracts';
import { z } from 'zod';

const DEFAULT_BACKEND_ORIGIN = 'http://127.0.0.1:8765';
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 5000;
const MAX_SESSIONS = 4;
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

async function boundedJson(response: Response): Promise<unknown> {
  const mediaType = response.headers
    .get('content-type')
    ?.split(';')[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== 'application/json')
    throw new WorkspaceBffError(
      502,
      'UPSTREAM_INVALID_RESPONSE',
      'Local service returned an invalid response.',
    );
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

async function backendRequest(
  route: keyof typeof backendApiResponseSchemas,
  path: string,
  method: 'GET' | 'POST',
): Promise<unknown> {
  const token = process.env.CODETHREAD_API_TOKEN;
  if (!token)
    throw new WorkspaceBffError(
      503,
      'BACKEND_NOT_CONFIGURED',
      'The local CodeThread backend is not configured.',
    );
  const origin = backendOrigin();
  let response: Response;
  try {
    response = await fetch(`${origin}${path}`, {
      method,
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new WorkspaceBffError(
      503,
      'BACKEND_UNAVAILABLE',
      'The local CodeThread backend is unavailable.',
    );
  }
  if (response.status >= 300 && response.status < 400)
    throw new WorkspaceBffError(
      502,
      'UPSTREAM_REDIRECT_REJECTED',
      'The local backend returned an unexpected redirect.',
    );
  const value = await boundedJson(response);
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
      try {
        await forwardViewerOperation(existingSessionId, scanId, 'projects', {});
        return { sessionId: existingSessionId, metadata: existing.metadata };
      } catch (error) {
        if (
          !(error instanceof WorkspaceBffError) ||
          error.code !== 'VIEWER_UNAVAILABLE'
        )
          throw error;
        sessions.delete(existingSessionId);
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
    if (
      error instanceof WorkspaceBffError &&
      error.code === 'VIEWER_UNAVAILABLE'
    ) {
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
  } catch {
    throw new WorkspaceBffError(
      503,
      'VIEWER_UNAVAILABLE',
      'The local snapshot viewer is unavailable.',
    );
  }
  if (response.status >= 300 && response.status < 400)
    throw new WorkspaceBffError(
      502,
      'UPSTREAM_REDIRECT_REJECTED',
      'The local viewer returned an unexpected redirect.',
    );
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
