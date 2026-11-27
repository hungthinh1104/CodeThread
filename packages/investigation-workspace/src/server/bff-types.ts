import { z } from 'zod';

export const DEFAULT_BACKEND_ORIGIN = 'http://127.0.0.1:8765';
export const MAX_REQUEST_BYTES = 64 * 1024;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
export const MAX_AI_RESPONSE_BYTES = 64 * 1024;
export const REQUEST_TIMEOUT_MS = 5_000;
export const AI_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_SESSIONS = 4;
export const SESSION_REUSE_MARGIN_MS = 5_000;

export const workspaceScanIdSchema = z
  .uuid()
  .transform((id) => id.toLowerCase());

export const workspaceRepositoryIdSchema = z
  .uuid()
  .transform((id) => id.toLowerCase());

export type WorkspaceMetadata = {
  repositoryId: string;
  scanId: string;
  commitId: string;
  treeId?: string | null;
  revision: string;
  generation?: string;
  attempt?: number;
  activationResult?: 'activated' | 'stale' | 'not_eligible' | null;
  createdAt?: string;
  updatedAt?: string;
  expiresAt: string;
};

export type WorkspaceSession = {
  viewerOrigin: string;
  viewerToken: string;
  expiresAt: number;
  metadata: WorkspaceMetadata;
};

export class WorkspaceBffError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  );
}

export function isStaleViewerError(error: unknown): boolean {
  if (!(error instanceof WorkspaceBffError)) return false;
  return (
    error.code === 'VIEWER_UNAVAILABLE' ||
    error.code === 'UPSTREAM_INVALID_RESPONSE' ||
    error.status === 401 ||
    error.status === 403 ||
    error.status === 404
  );
}
