import { ApiFailure } from '../investigation/api.ts';
import type { ApiErrorBody, RepositoryItem } from '../investigation/types.ts';

export type HealthStatus = {
  api: 'ready';
  database: 'ready' | 'unavailable';
  worker: 'ready' | 'unavailable';
  ready: boolean;
};

export type ScanState =
  'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type ActivationResult = 'activated' | 'stale' | 'not_eligible' | null;

export type ScanRecord = {
  id: string;
  repository_id: string;
  generation: string;
  state: ScanState;
  attempt: number;
  revision_selector: string;
  git_commit_oid: string | null;
  git_tree_oid: string | null;
  activation_result: ActivationResult;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

export type AcceptedScan = {
  id: string;
  repositoryId: string;
  state: ScanState;
  reused: boolean;
};

export type ScanProjectStatus =
  'ready' | 'solution' | 'invalid' | 'unsupported' | 'failed' | 'not_analyzed';

export type ScanProjectRecord = {
  project_id: string;
  project_label: string;
  status: ScanProjectStatus;
  snapshot_id: string | null;
  diagnostics: Array<{ code: string; message: string; path?: string }>;
};

export type ScanFilesPage = {
  items: Array<{
    path: string;
    content_hash: string;
    git_blob_oid: string;
    git_mode: '100644' | '100755';
  }>;
  total: number;
  nextOffset: number | null;
};

async function requestAdminJson<T>(
  input: string,
  init: RequestInit,
  acceptStatus: number[] = [],
): Promise<T> {
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
  const ok = response.ok || acceptStatus.includes(response.status);
  if (!ok) {
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

export function readHealth(): Promise<HealthStatus> {
  return requestAdminJson<HealthStatus>(
    '/api/health',
    { method: 'GET' },
    [503],
  );
}

export function listAdminRepositories(): Promise<{ items: RepositoryItem[] }> {
  return requestAdminJson<{ items: RepositoryItem[] }>('/api/repositories', {
    method: 'GET',
  });
}

export function registerAdminRepository(
  locator: string,
): Promise<{ repository: { id: string; label: string } }> {
  return requestAdminJson<{ repository: { id: string; label: string } }>(
    '/api/repositories',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ locator }),
    },
  );
}

export function readRepositoryScans(
  repositoryId: string,
): Promise<{ items: ScanRecord[] }> {
  return requestAdminJson<{ items: ScanRecord[] }>(
    `/api/repositories/${encodeURIComponent(repositoryId)}/scans`,
    { method: 'GET' },
  );
}

export function triggerRepositoryScan(
  repositoryId: string,
  revision: string,
  idempotencyKey: string,
): Promise<{ scan: AcceptedScan }> {
  return requestAdminJson<{ scan: AcceptedScan }>(
    `/api/repositories/${encodeURIComponent(repositoryId)}/scans`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ revision, idempotencyKey }),
    },
  );
}

export function readScanDetail(scanId: string): Promise<{ scan: ScanRecord }> {
  return requestAdminJson<{ scan: ScanRecord }>(
    `/api/scans/${encodeURIComponent(scanId)}`,
    { method: 'GET' },
  );
}

export function cancelScanJob(
  scanId: string,
): Promise<{ scan: { id: string; state: 'cancelled' } }> {
  return requestAdminJson<{ scan: { id: string; state: 'cancelled' } }>(
    `/api/scans/${encodeURIComponent(scanId)}/cancel`,
    { method: 'POST' },
  );
}

export function readScanProjects(
  scanId: string,
): Promise<{ items: ScanProjectRecord[] }> {
  return requestAdminJson<{ items: ScanProjectRecord[] }>(
    `/api/scans/${encodeURIComponent(scanId)}/projects`,
    { method: 'GET' },
  );
}

export function readScanFiles(
  scanId: string,
  offset: number,
): Promise<ScanFilesPage> {
  return requestAdminJson<ScanFilesPage>(
    `/api/scans/${encodeURIComponent(scanId)}/files?offset=${offset}`,
    { method: 'GET' },
  );
}
