import type { BenchmarkResult, BenchmarkShape } from './config.ts';
import {
  inventoryDigest,
  measureAcquisition,
  measureBrowseOperations,
  prepareInventory,
  verifyInventoryLimits,
} from './inventory-workload.ts';

export async function measureRepository(
  base: string,
  shape: BenchmarkShape,
  entries: number,
): Promise<BenchmarkResult> {
  const context = await prepareInventory(base, shape, entries);
  const stages = await measureBrowseOperations(context);
  const analysis = await measureAcquisition(context);
  stages.acquireAndAnalyze = analysis.stage;
  await verifyInventoryLimits(context);
  const stats = context.session.statistics();
  const result: BenchmarkResult = {
    shape,
    requestedTreeEntries: entries,
    generatedTreeEntries: context.repository.treeEntries,
    verifiedTreeEntries: context.inventory.counts.treeEntries,
    committedFiles: context.repository.paths.length,
    pinnedCommitId: context.inventory.commitId,
    inventory: {
      knownFiles: context.inventory.counts.files,
      complete: !context.inventory.truncated,
      truncationReasons: context.inventory.truncationReasons,
      uniqueTrees: context.inventory.counts.uniqueTrees,
      treeVisits: context.inventory.counts.treeVisits,
      identityStableAcrossSamples: true,
      omittedPathLookup: context.omittedPathLookup,
    },
    stages,
    gitReads: {
      ...stats,
      inventorySubprocesses: context.statsBeforeSources.subprocesses,
      inventoryObjectReads:
        context.statsBeforeSources.commitReads +
        context.statsBeforeSources.treeReads,
      acquisitionSubprocesses:
        stats.subprocesses - context.statsBeforeSources.subprocesses,
      sourceBlobReads: stats.blobReads,
      sourceBlobBytes: stats.blobBytes,
    },
    selection: {
      exactFiles: context.plan.selection.length,
      directoryFiles: context.directoryCount,
      oversizedDirectoryRejected: context.oversizedDirectoryRejected,
    },
    analysis: {
      snapshotId: analysis.snapshotId,
      declarations: analysis.declarations,
      files: analysis.files,
    },
    deterministicInventorySha256: inventoryDigest(context),
  };
  process.stderr.write(`Benchmark complete: ${shape}/${entries}.\n`);
  return result;
}
