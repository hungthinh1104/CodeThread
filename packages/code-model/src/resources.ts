export type AnalysisResourceProfile = 'selected' | 'repository';

/** Closed execution policies, shared by admission, extraction and both validators. */
export interface AnalysisResourceLimits {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxDeclarations: number;
  readonly maxCallSites: number;
  readonly maxReferenceSites: number;
  readonly maxRelations: number;
  readonly maxEvidence: number;
  readonly maxDiagnostics: number;
  readonly maxCompilerDiagnostics: number;
  readonly maxFullSemanticDiagnosticFiles: number;
  readonly maxUnsupportedSyntax: number;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly maxHeapMiB: number;
  readonly maxDeadlineMs: number;
}

const selected: AnalysisResourceLimits = Object.freeze({
  maxFiles: 20,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 2 * 1024 * 1024,
  maxDeclarations: 2000,
  maxCallSites: 5000,
  maxReferenceSites: 5000,
  maxRelations: 10000,
  maxEvidence: 17000,
  maxDiagnostics: 25000,
  maxCompilerDiagnostics: 10000,
  maxFullSemanticDiagnosticFiles: 20,
  maxUnsupportedSyntax: 10000,
  maxRequestBytes: 8 * 1024 * 1024,
  maxResponseBytes: 32 * 1024 * 1024,
  maxHeapMiB: 512,
  maxDeadlineMs: 10000,
});
const repository: AnalysisResourceLimits = Object.freeze({
  maxFiles: 1000,
  maxFileBytes: 32 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxDeclarations: 20000,
  maxCallSites: 50000,
  maxReferenceSites: 50000,
  maxRelations: 100000,
  maxEvidence: 220000,
  maxDiagnostics: 150000,
  maxCompilerDiagnostics: 20000,
  maxFullSemanticDiagnosticFiles: 64,
  maxUnsupportedSyntax: 20000,
  maxRequestBytes: 64 * 1024 * 1024,
  maxResponseBytes: 128 * 1024 * 1024,
  maxHeapMiB: 2048,
  maxDeadlineMs: 120000,
});

export function analysisResourceLimits(
  profile: AnalysisResourceProfile = 'selected',
): Readonly<AnalysisResourceLimits> {
  if (profile === 'selected') return selected;
  if (profile === 'repository') return repository;
  throw new Error('Unknown analysis resource profile');
}

export function withinAnalysisCollectionLimits(
  input: unknown,
  limits: AnalysisResourceLimits,
): boolean {
  if (!input || typeof input !== 'object') return false;
  const facts = input as Record<string, unknown>;
  return (
    [
      ['files', limits.maxFiles],
      ['symbols', limits.maxDeclarations],
      ['relations', limits.maxRelations],
      ['evidenceRefs', limits.maxEvidence],
      ['diagnostics', limits.maxDiagnostics],
      ['observations', limits.maxCallSites],
    ] as const
  ).every(([name, maximum]) => {
    const values = facts[name];
    return Array.isArray(values) && values.length <= maximum;
  });
}
