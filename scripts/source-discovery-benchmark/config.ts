export const repositoryId = '00000000-0000-4000-8000-000000000022';
export const entryCounts = [100, 1_000, 10_000] as const;
export const shapes = ['flat', 'deep', 'wide'] as const;
export const deepDirectoryDepth = 8;
export const wideDirectoryLimit = 64;
export const repeats = 3;
export const queryRepeats = 100;
export const sourceText = 'export function leaf() {}\n';
export const stdoutLimit = 64 * 1024;
export const deadlineMs = 30_000;

export type BenchmarkShape = (typeof shapes)[number];

export interface StageMeasurement {
  samplesMs: number[];
  medianMs: number;
  operationsPerSample: number;
  meanMsPerOperation: number;
  peakRssDeltaMiB: number;
}
export interface BenchmarkResult {
  shape: BenchmarkShape;
  requestedTreeEntries: number;
  generatedTreeEntries: number;
  verifiedTreeEntries: number;
  committedFiles: number;
  pinnedCommitId: string;
  inventory: {
    knownFiles: number;
    complete: boolean;
    truncationReasons: readonly string[];
    uniqueTrees: number;
    treeVisits: number;
    identityStableAcrossSamples: boolean;
    omittedPathLookup: 'not_applicable' | 'not_verified';
  };
  stages: Record<string, StageMeasurement>;
  gitReads: import('../git-source/objects.ts').GitOperationCounts & {
    inventorySubprocesses: number;
    inventoryObjectReads: number;
    acquisitionSubprocesses: number;
    sourceBlobReads: number;
    sourceBlobBytes: number;
  };
  selection: {
    exactFiles: number;
    directoryFiles: number | null;
    oversizedDirectoryRejected: boolean;
  };
  analysis: { snapshotId: string; declarations: number; files: number };
  deterministicInventorySha256: string;
}
