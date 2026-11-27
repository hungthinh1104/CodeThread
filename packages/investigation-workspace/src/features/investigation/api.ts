import type {
  AcceptedScan,
  AiStatusResponse,
  AiSynthesisResponse,
  AiSynthesizeApiRequest,
  ApiErrorBody,
  BackendHealth,
  EvidenceProjection,
  FindSymbolPathsRequest,
  FindSymbolPathsResponse,
  GetSourceEvidenceRequest,
  GraphNeighborsRequest,
  GraphProjection,
  ListSymbolsResponse,
  RepositoryItem,
  ScanManifestPage,
  ScanProjectSummary,
  ScanStatusRecord,
  WorkspaceMetadata,
} from './types.ts';

const scanStorageKey = 'codethread-workspace-scan';

export class ApiFailure extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, body: ApiErrorBody | undefined) {
    super(body?.error.message ?? 'The local workspace request failed.');
    this.name = 'ApiFailure';
    this.status = status;
    this.code = body?.error.code ?? 'INVALID_RESPONSE';
  }
}

async function requestJson<T>(input: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(input, {
      ...init,
      cache: 'no-store',
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiFailure(0, {
      error: {
        code: 'WORKSPACE_UNAVAILABLE',
        message: 'The local workspace is unavailable.',
      },
    });
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new ApiFailure(response.status, undefined);
  }
  if (!response.ok) {
    const body =
      typeof value === 'object' &&
      value !== null &&
      'error' in value &&
      typeof value.error === 'object' &&
      value.error !== null &&
      'code' in value.error &&
      'message' in value.error
        ? (value as ApiErrorBody)
        : undefined;
    throw new ApiFailure(response.status, body);
  }
  return value as T;
}

function get<T>(path: string): Promise<T> {
  return requestJson<T>(path, { method: 'GET' });
}

function post<T>(path: string, body: unknown, scanId?: string): Promise<T> {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (scanId) headers.set('x-codethread-scan-id', scanId);
  return requestJson<T>(path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

export function readSystemHealth() {
  return get<{ health: BackendHealth; ai: AiStatusResponse }>('/api/health');
}

export function readRepositories() {
  return get<{ items: RepositoryItem[] }>('/api/repositories');
}

export function readRepositoryById(repositoryId: string) {
  return get<{ repository: RepositoryItem }>(
    `/api/repositories/${encodeURIComponent(repositoryId)}`,
  );
}

export function registerRepository(locator: string) {
  return post<{ repository: RepositoryItem }>('/api/repositories', { locator });
}

export function requestRepositoryScan(
  repositoryId: string,
  revision: string,
  idempotencyKey: string,
) {
  return post<{ scan: AcceptedScan }>(
    `/api/repositories/${encodeURIComponent(repositoryId)}/scans`,
    { revision, idempotencyKey },
  );
}

export function readScanStatus(scanId: string) {
  return get<{ scan: ScanStatusRecord }>(
    `/api/scans/${encodeURIComponent(scanId)}`,
  );
}

export function cancelScan(scanId: string) {
  return post<{ scan: { id: string; state: 'cancelled' } }>(
    `/api/scans/${encodeURIComponent(scanId)}/cancel`,
    {},
  );
}

export function readScanProjects(scanId: string) {
  return get<{ scanId: string; items: ScanProjectSummary[] }>(
    `/api/scans/${encodeURIComponent(scanId)}/projects`,
  );
}

export function readScanManifestFiles(scanId: string, offset = 0) {
  const suffix = offset > 0 ? `?offset=${offset}` : '';
  return get<ScanManifestPage>(
    `/api/scans/${encodeURIComponent(scanId)}/files${suffix}`,
  );
}

export function openScan(scanId: string) {
  return post<{ workspace: WorkspaceMetadata }>('/api/workspace/open', {
    scanId,
  });
}

export function readWorkspaceMetadata() {
  let scanId: string | null;
  try {
    scanId = sessionStorage.getItem(scanStorageKey);
  } catch {
    return null;
  }
  return scanId
    ? post<{ workspace: WorkspaceMetadata }>('/api/workspace/meta', {}, scanId)
    : null;
}

export function rememberWorkspaceScan(scanId: string | null): void {
  try {
    if (scanId) sessionStorage.setItem(scanStorageKey, scanId);
    else sessionStorage.removeItem(scanStorageKey);
  } catch {
    // The active workspace still works when browser storage is unavailable.
  }
}

export function readViewer<T>(
  scanId: string,
  operation: string,
  body: unknown,
): Promise<T> {
  return post<T>(`/api/workspace/${operation}`, body, scanId);
}

export function readDeepNeighbors(
  scanId: string,
  projectId: string,
  request: GraphNeighborsRequest,
): Promise<{ projectId: string; result: GraphProjection }> {
  return post<{ projectId: string; result: GraphProjection }>(
    '/api/workspace/neighbors-deep',
    { projectId, request },
    scanId,
  );
}

export function readDirectEvidence(
  scanId: string,
  projectId: string,
  request: GetSourceEvidenceRequest,
): Promise<{ projectId: string; result: EvidenceProjection }> {
  return post<{ projectId: string; result: EvidenceProjection }>(
    '/api/workspace/evidence-direct',
    { projectId, request },
    scanId,
  );
}

export function readBackendSymbols(
  scanId: string,
  projectId: string,
  query: string,
  offset: number,
): Promise<{ projectId: string; result: ListSymbolsResponse }> {
  return post<{ projectId: string; result: ListSymbolsResponse }>(
    '/api/workspace/symbols-meta',
    { projectId, request: { query, offset } },
    scanId,
  );
}

export function findWorkspacePaths(
  scanId: string,
  projectId: string,
  request: FindSymbolPathsRequest,
): Promise<{ projectId: string; result: FindSymbolPathsResponse }> {
  return post<{ projectId: string; result: FindSymbolPathsResponse }>(
    '/api/workspace/paths',
    { projectId, request },
    scanId,
  );
}

export function synthesizeAiNotes(
  scanId: string,
  projectId: string,
  request: AiSynthesizeApiRequest,
): Promise<AiSynthesisResponse> {
  return post<AiSynthesisResponse>(
    '/api/workspace/ai',
    { projectId, request },
    scanId,
  );
}
