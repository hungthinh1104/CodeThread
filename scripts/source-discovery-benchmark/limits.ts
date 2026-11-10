import { ANALYSIS_LIMITS } from '@codethread/symbol-indexer';
import { GIT_INVENTORY_LIMITS } from '../git-source/inventory-types.ts';

export const benchmarkLimits = Object.freeze({
  inventoryFiles: GIT_INVENTORY_LIMITS.files,
  uniqueTrees: GIT_INVENTORY_LIMITS.trees,
  treeVisits: GIT_INVENTORY_LIMITS.treeVisits,
  treeEntries: GIT_INVENTORY_LIMITS.treeEntries,
  metadataObjectBytes: GIT_INVENTORY_LIMITS.objectBytes,
  metadataBytes: GIT_INVENTORY_LIMITS.metadataBytes,
  sourceFiles: ANALYSIS_LIMITS.maxFiles,
  sourceBytesPerFile: ANALYSIS_LIMITS.maxFileBytes,
  sourceBytesTotal: ANALYSIS_LIMITS.maxTotalBytes,
});
