import type { AcquiredGitSources, GitSelectionStatus } from './types.ts';
import type { GitOperationCounts } from './objects.ts';
import type { GitRepository } from './repository.ts';
import {
  GIT_DEADLINE_MS,
  MAX_DISCOVERY_FILES,
  MAX_METADATA_BYTES,
  MAX_OBJECT_BYTES,
  MAX_PATH_COMPONENTS,
  MAX_TREE_ENTRIES,
  MAX_TREE_VISITS,
  MAX_VISITED_TREES,
} from './types.ts';

export interface GitInventoryLimits {
  files: number;
  trees: number;
  treeVisits: number;
  treeEntries: number;
  pathComponents: number;
  objectBytes: number;
  metadataBytes: number;
  deadlineMs: number;
}
export const GIT_INVENTORY_LIMITS: Readonly<GitInventoryLimits> = Object.freeze(
  {
    files: MAX_DISCOVERY_FILES,
    trees: MAX_VISITED_TREES,
    treeVisits: MAX_TREE_VISITS,
    treeEntries: MAX_TREE_ENTRIES,
    pathComponents: MAX_PATH_COMPONENTS,
    objectBytes: MAX_OBJECT_BYTES,
    metadataBytes: MAX_METADATA_BYTES,
    deadlineMs: GIT_DEADLINE_MS,
  },
);
export interface GitSourceDiscoveryRequest {
  repositoryPath: string;
  repositoryId: string;
  revision: string;
  signal?: AbortSignal;
  /** Limits may only lower the declared inventory safety bounds. */
  limits?: Partial<GitInventoryLimits>;
}
export type GitDiscoveryTruncationReason =
  | 'file_limit'
  | 'tree_limit'
  | 'tree_visit_limit'
  | 'entry_limit'
  | 'path_limit'
  | 'unsupported_paths';
export interface GitDiscoveredFile {
  path: string;
  mode: '100644' | '100755' | '120000' | '160000';
}
export interface UnsupportedGitPath {
  directory: string;
  nameBytesHex: string;
  nameBytesTruncated: boolean;
  reason: 'invalid_utf8' | 'unsupported_path' | 'path_limit';
}
export interface GitFileInventory {
  inventoryId: string;
  repositoryId: string;
  commitId: string;
  rootTreeId: string;
  objectFormat: 'sha1' | 'sha256';
  files: readonly GitDiscoveredFile[];
  unsupportedPaths: readonly UnsupportedGitPath[];
  counts: Readonly<{
    files: number;
    uniqueTrees: number;
    treeVisits: number;
    treeEntries: number;
    unsupportedPaths: number;
    unsupportedReportsTruncated: boolean;
    nonregularEntries: number;
  }>;
  truncated: boolean;
  truncationReasons: readonly GitDiscoveryTruncationReason[];
  appliedLimits: Readonly<GitInventoryLimits>;
}
export interface GitInventoryQuery {
  text?: string;
  prefix?: string;
  exactPath?: string;
  limit?: number;
  cursor?: string;
}
export interface GitInventoryPage {
  inventoryId: string;
  commitId: string;
  items: readonly GitDiscoveredFile[];
  nextCursor: string | null;
  knownMatches: number;
  inventoryComplete: boolean;
  searchComplete: boolean;
  endOfVerifiedResults: boolean;
  appliedLimits: Readonly<GitInventoryLimits & { pageSize: number }>;
  truncationReasons: readonly GitDiscoveryTruncationReason[];
}
export type GitPathLookup =
  | { status: 'found'; file: GitDiscoveredFile }
  | {
      status: 'unsupported';
      code: 'INVALID_SELECTION' | 'UNSUPPORTED_FILE_MODE';
    }
  | { status: 'not_found' }
  | { status: 'not_verified'; code: 'INCOMPLETE_INVENTORY' };
export interface GitSelectionPlan {
  inventoryId: string;
  commitId: string;
  selectionId: string;
  paths: readonly string[];
  directories: readonly string[];
  selection: readonly GitSelectionStatus[];
}
export interface GitInventorySession {
  readonly inventory: GitFileInventory;
  query(input?: unknown): GitInventoryPage;
  lookup(path: unknown): GitPathLookup;
  select(input: unknown): GitSelectionPlan;
  acquire(plan: unknown, signal?: AbortSignal): Promise<AcquiredGitSources>;
  statistics(): Readonly<GitOperationCounts>;
}

/** Private handoff between inventory, query and selection owners; never returned to callers. */
export interface InventoryContext {
  inventory: GitFileInventory;
  repository: GitRepository;
  files: ReadonlyMap<string, { file: GitDiscoveredFile; oid: string }>;
  blockedPaths: ReadonlySet<string>;
}
