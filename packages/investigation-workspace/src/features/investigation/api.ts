import type {
  ApiErrorBody,
  RepositoryItem,
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

function post<T>(path: string, body: unknown, scanId?: string): Promise<T> {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (scanId) headers.set('x-codethread-scan-id', scanId);
  return requestJson<T>(path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

export function readRepositories() {
  return requestJson<{ items: RepositoryItem[] }>('/api/repositories', {
    method: 'GET',
  });
}

export function openScan(scanId: string) {
  return post<{ workspace: WorkspaceMetadata }>('/api/workspace/open', {
    scanId,
  });
}

export function readRememberedWorkspaceScan(): string | null {
  try {
    return sessionStorage.getItem(scanStorageKey);
  } catch {
    return null;
  }
}

export function readWorkspaceMetadata() {
  const scanId = readRememberedWorkspaceScan();
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
