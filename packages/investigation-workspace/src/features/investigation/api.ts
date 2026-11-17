import type {
  ApiErrorBody,
  RepositoryItem,
  WorkspaceMetadata,
} from './types.ts';

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

function post<T>(path: string, body: unknown): Promise<T> {
  return requestJson<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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

export function readWorkspaceMetadata() {
  return post<{ workspace: WorkspaceMetadata }>('/api/workspace/meta', {});
}

export function readViewer<T>(operation: string, body: unknown): Promise<T> {
  return post<T>(`/api/workspace/${operation}`, body);
}
