import { randomBytes } from 'node:crypto';
import {
  aiStatusResponseSchema,
  aiSynthesisResponseSchema,
  aiSynthesizeApiRequestSchema,
  backendApiErrorResponseSchema,
  backendApiResponseSchemas,
  findSymbolPathsRequestSchema,
  getSourceEvidenceRequestSchema,
  graphNeighborsRequestSchema,
  parseFindSymbolPathsResult,
  parseGetSourceEvidenceResult,
  parseGraphNeighborsResult,
  viewerApiRepositoryRequestSchemas,
  viewerApiResponseSchemas,
} from '@codethread/contracts';
import type {
  AiStatusResponse,
  AiSynthesisResponse,
  FindSymbolPathsResponse,
  GetSourceEvidenceResponse,
  GraphNeighborsResponse,
  ListSymbolsResponse,
} from '@codethread/contracts';
import { z } from 'zod';
import {
  AI_REQUEST_TIMEOUT_MS,
  isStaleViewerError,
  isTimeoutError,
  MAX_AI_RESPONSE_BYTES,
  MAX_SESSIONS,
  REQUEST_TIMEOUT_MS,
  SESSION_REUSE_MARGIN_MS,
  WorkspaceBffError,
  workspaceScanIdSchema,
} from './bff-types.ts';
import type { WorkspaceMetadata, WorkspaceSession } from './bff-types.ts';
import { listRepositories } from './scan-admin-bff.ts';
import {
  backendRequest,
  boundedJson,
  parseRequestJson,
  parseViewerAddress,
} from './upstream.ts';

export {
  listRepositories,
  parseRequestJson,
  WorkspaceBffError,
  workspaceScanIdSchema,
};
export type { WorkspaceMetadata };

const openWorkspaceRequestSchema = z.strictObject({
  scanId: workspaceScanIdSchema,
});
const sessionIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
const workspaceAiRequestSchema = z.strictObject({
  projectId: z.string().min(1).max(256),
  request: aiSynthesizeApiRequestSchema,
});
const workspacePathsRequestSchema = z.strictObject({
  projectId: z.string().min(1).max(256),
  request: findSymbolPathsRequestSchema,
});
const workspaceDeepNeighborsRequestSchema = z.strictObject({
  projectId: z.string().min(1).max(256),
  request: graphNeighborsRequestSchema,
});
const workspaceDirectEvidenceRequestSchema = z.strictObject({
  projectId: z.string().min(1).max(256),
  request: getSourceEvidenceRequestSchema,
});
const workspaceSymbolsMetaRequestSchema = z.strictObject({
  projectId: z.string().min(1).max(256),
  request: z.strictObject({
    query: z.string().max(256).default(''),
    offset: z.number().int().min(0).max(20000).default(0),
  }),
});

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
    treeId: scan.git_tree_oid,
    revision: scan.revision_selector,
    generation: scan.generation,
    attempt: scan.attempt,
    activationResult: scan.activation_result,
    createdAt: scan.created_at,
    updatedAt: scan.updated_at,
    expiresAt: viewer.expiresAt,
  };
  sessions.set(sessionId, { ...address, metadata });
  return { sessionId, metadata };
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

export async function queryWorkspacePaths(
  sessionId: string | undefined,
  scanId: string,
  value: unknown,
): Promise<{ projectId: string; result: FindSymbolPathsResponse }> {
  requireWorkspaceSession(sessionId, scanId);
  const parsed = workspacePathsRequestSchema.safeParse(value);
  if (!parsed.success)
    throw new WorkspaceBffError(
      400,
      'INVALID_REQUEST',
      'Workspace symbol-path request failed contract validation.',
    );
  const rawResult = await backendRequest(
    'POST /v1/scans/:id/projects/:projectId/paths',
    `/v1/scans/${scanId}/projects/${encodeURIComponent(parsed.data.projectId)}/paths`,
    'POST',
    { body: parsed.data.request },
  );
  try {
    const result = parseFindSymbolPathsResult(parsed.data.request, rawResult);
    return { projectId: parsed.data.projectId, result };
  } catch {
    throw new WorkspaceBffError(
      502,
      'UPSTREAM_CONTRACT_MISMATCH',
      'The local backend returned an invalid symbol-path projection.',
    );
  }
}

export async function queryWorkspaceDeepNeighbors(
  sessionId: string | undefined,
  scanId: string,
  value: unknown,
): Promise<{
  projectId: string;
  result: {
    graph: GraphNeighborsResponse;
    unknowns: { total: number; items: [] };
  };
}> {
  requireWorkspaceSession(sessionId, scanId);
  const parsed = workspaceDeepNeighborsRequestSchema.safeParse(value);
  if (!parsed.success)
    throw new WorkspaceBffError(
      400,
      'INVALID_REQUEST',
      'Workspace neighbor-graph request failed contract validation.',
    );
  const rawResult = await backendRequest(
    'POST /v1/scans/:id/projects/:projectId/neighbors',
    `/v1/scans/${scanId}/projects/${encodeURIComponent(parsed.data.projectId)}/neighbors`,
    'POST',
    { body: parsed.data.request },
  );
  try {
    const graph = parseGraphNeighborsResult(parsed.data.request, rawResult);
    return {
      projectId: parsed.data.projectId,
      result: { graph, unknowns: { total: 0, items: [] } },
    };
  } catch {
    throw new WorkspaceBffError(
      502,
      'UPSTREAM_CONTRACT_MISMATCH',
      'The local backend returned an invalid neighbor-graph projection.',
    );
  }
}

export async function queryWorkspaceDirectEvidence(
  sessionId: string | undefined,
  scanId: string,
  value: unknown,
): Promise<{ projectId: string; result: GetSourceEvidenceResponse }> {
  requireWorkspaceSession(sessionId, scanId);
  const parsed = workspaceDirectEvidenceRequestSchema.safeParse(value);
  if (!parsed.success)
    throw new WorkspaceBffError(
      400,
      'INVALID_REQUEST',
      'Workspace evidence request failed contract validation.',
    );
  const rawResult = await backendRequest(
    'POST /v1/scans/:id/projects/:projectId/evidence',
    `/v1/scans/${scanId}/projects/${encodeURIComponent(parsed.data.projectId)}/evidence`,
    'POST',
    { body: parsed.data.request },
  );
  try {
    const result = parseGetSourceEvidenceResult(parsed.data.request, rawResult);
    return { projectId: parsed.data.projectId, result };
  } catch {
    throw new WorkspaceBffError(
      502,
      'UPSTREAM_CONTRACT_MISMATCH',
      'The local backend returned an invalid source-evidence projection.',
    );
  }
}

export async function queryWorkspaceBackendSymbols(
  sessionId: string | undefined,
  scanId: string,
  value: unknown,
): Promise<{ projectId: string; result: ListSymbolsResponse }> {
  requireWorkspaceSession(sessionId, scanId);
  const parsed = workspaceSymbolsMetaRequestSchema.safeParse(value);
  if (!parsed.success)
    throw new WorkspaceBffError(
      400,
      'INVALID_REQUEST',
      'Workspace symbol-search request failed contract validation.',
    );
  const query = encodeURIComponent(parsed.data.request.query);
  const offset = parsed.data.request.offset;
  const rawResult = await backendRequest(
    'GET /v1/scans/:id/projects/:projectId/symbols',
    `/v1/scans/${scanId}/projects/${encodeURIComponent(parsed.data.projectId)}/symbols?query=${query}&offset=${offset}`,
    'GET',
  );
  return {
    projectId: parsed.data.projectId,
    result: rawResult as ListSymbolsResponse,
  };
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
