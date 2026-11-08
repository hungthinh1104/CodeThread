/** Application source adapter; semantic extraction and traversal stay in their existing packages. */
export { GitSourceError } from './git-source/types.ts';
export type {
  GitSourceErrorCode,
  GitSelectionStatus,
  GitSourceRequest,
  GitSourceProvenance,
  AcquiredGitSources,
} from './git-source/types.ts';
export { acquireGitSources } from './git-source/acquire.ts';
export { summarizeSelection } from './git-source/selection.ts';
export { discoverGitFiles, openGitInventory } from './git-source/inventory.ts';
export { GIT_INVENTORY_LIMITS } from './git-source/inventory-types.ts';
export type {
  GitSourceDiscoveryRequest,
  GitDiscoveryTruncationReason,
  GitDiscoveredFile,
  GitFileInventory,
  GitInventoryLimits,
  GitInventoryQuery,
  GitInventoryPage,
  GitPathLookup,
  GitSelectionPlan,
  GitInventorySession,
  UnsupportedGitPath,
} from './git-source/inventory-types.ts';
export type { GitOperationCounts } from './git-source/objects.ts';
