export interface RepositoryProfileInputEvidence {
  expectedCommitId: string;
  actualCommitId: string;
  inventoryComplete: boolean;
  expectedSourceFiles: number;
  actualSourceFiles: number;
  expectedSourceBytes: number;
  actualSourceBytes: number;
  sourceCoverageComplete: boolean;
  analysisComplete: boolean;
  contextComplete: boolean;
}

export function assertRepositoryProfileInputs(
  evidence: RepositoryProfileInputEvidence,
): void {
  if (
    evidence.actualCommitId !== evidence.expectedCommitId ||
    !evidence.inventoryComplete ||
    evidence.actualSourceFiles !== evidence.expectedSourceFiles ||
    evidence.actualSourceBytes !== evidence.expectedSourceBytes ||
    !evidence.sourceCoverageComplete ||
    !evidence.analysisComplete ||
    !evidence.contextComplete
  )
    throw new Error('Repository profile benchmark did not complete its inputs');
}

export function assertRepositoryProfileCall<T>(
  relation: T | undefined,
): asserts relation is T {
  if (!relation)
    throw new Error(
      'Repository profile benchmark direct call did not resolve exactly',
    );
}

export interface RepositoryProfileQueryEvidence {
  projectMode?: string | undefined;
  fileTotal?: number | undefined;
  expectedFileTotal: number;
  catalogTotal?: number | undefined;
  expectedSnapshotId: string;
  sessionSnapshotId?: string | undefined;
  symbolTotal?: number | undefined;
  graphRelationCount?: number | undefined;
  evidenceStatus?: string | undefined;
  followRequiresChoice?: boolean | undefined;
}

export function assertRepositoryProfileQueries(
  evidence: RepositoryProfileQueryEvidence,
): void {
  if (
    evidence.projectMode !== 'repository' ||
    evidence.fileTotal !== evidence.expectedFileTotal ||
    (evidence.catalogTotal ?? 0) < 1 ||
    evidence.sessionSnapshotId !== evidence.expectedSnapshotId ||
    evidence.symbolTotal !== 1 ||
    evidence.graphRelationCount !== 1 ||
    evidence.evidenceStatus !== 'available' ||
    evidence.followRequiresChoice !== false
  )
    throw new Error(
      'Repository profile query smoke returned incomplete results',
    );
}
