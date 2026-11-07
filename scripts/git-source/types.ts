import type { AnalysisInput } from '@codethread/symbol-indexer';

export type GitSourceErrorCode =
  | 'INVALID_REPOSITORY'
  | 'INVALID_REPOSITORY_ID'
  | 'UNSUPPORTED_REPOSITORY_LAYOUT'
  | 'INVALID_REVISION'
  | 'INVALID_SELECTION'
  | 'INVALID_DISCOVERY_REQUEST'
  | 'INVALID_QUERY'
  | 'INVALID_CURSOR'
  | 'INCOMPLETE_INVENTORY'
  | 'SOURCE_INVENTORY_INCOMPLETE'
  | 'INVENTORY_MISMATCH'
  | 'FILE_NOT_FOUND'
  | 'UNSUPPORTED_FILE_MODE'
  | 'MISSING_OBJECT'
  | 'CORRUPT_OBJECT'
  | 'RESOURCE_LIMIT'
  | 'GIT_TIMEOUT'
  | 'CANCELLED'
  | 'GIT_UNAVAILABLE'
  | 'GIT_FAILED'
  | 'GIT_PROTOCOL';

export interface GitSelectionStatus {
  path: string;
  status: 'selected' | 'admitted' | 'rejected' | 'not-admitted';
}

export class GitSourceError extends Error {
  readonly code: GitSourceErrorCode;
  readonly selection: readonly GitSelectionStatus[];

  constructor(
    code: GitSourceErrorCode,
    message: string,
    selection: readonly GitSelectionStatus[] = [],
  ) {
    super(message);
    this.name = 'GitSourceError';
    this.code = code;
    this.selection = selection;
  }
}

export interface GitSourceRequest {
  repositoryPath: string;
  repositoryId: string;
  revision: string;
  selectedPaths: readonly string[];
  signal?: AbortSignal;
}

export interface GitSourceProvenance {
  commitId: string;
  objectFormat: 'sha1' | 'sha256';
  files: readonly {
    path: string;
    blobId: string;
    mode: '100644' | '100755';
    sha256: string;
  }[];
}

export interface AcquiredGitSources {
  input: AnalysisInput;
  provenance: GitSourceProvenance;
  selection: readonly GitSelectionStatus[];
}

export const GIT_DEADLINE_MS = 10_000;

export const MAX_OBJECT_BYTES = 1024 * 1024;

export const MAX_METADATA_BYTES = 4 * 1024 * 1024;

export const MAX_VISITED_TREES = 128;

export const MAX_TREE_VISITS = 4_096;

export const MAX_TREE_ENTRIES = 10_000;

export const MAX_DISCOVERY_FILES = 1_000;

export const MAX_PATH_COMPONENTS = 64;

export const MAX_STDERR_BYTES = 8 * 1024;
