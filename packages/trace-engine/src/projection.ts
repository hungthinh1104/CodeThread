import { summarizeCoverage } from '@codethread/code-model';
import type { InvestigationContext } from './context.js';

export type TruncationReason = 'result_limit' | 'depth_limit' | 'search_budget';

export function createMetadata(
  context: InvestigationContext,
  limits: Record<string, number>,
  reasons: Set<TruncationReason>,
) {
  const { facts } = context;
  const order: TruncationReason[] = [
    'result_limit',
    'depth_limit',
    'search_budget',
  ];
  const truncationReasons = order.filter((reason) => reasons.has(reason));
  return {
    snapshotId: facts.snapshotId,
    evidenceBasis: 'static' as const,
    coverage: summarizeCoverage(facts.coverageByCapability),
    coverageByCapability: { ...facts.coverageByCapability },
    truncated: truncationReasons.length > 0,
    truncationReasons,
    appliedLimits: limits,
  };
}
export function createProjection(
  context: InvestigationContext,
  nodeLimit: number,
) {
  const {
    requiredSymbol,
    relations,
    symbols,
    evidence,
    diagnostics,
    compareSymbol,
    compareRelation,
    compareEvidence,
    compareDiagnostic,
  } = context;
  const selectedSymbols = new Set<string>(),
    selectedRelations = new Set<string>(),
    selectedEvidence = new Set<string>(),
    selectedDiagnostics = new Set<string>();
  function include(
    symbolIds: readonly string[],
    relationIds: readonly string[],
  ): boolean {
    const newSymbols = new Set(
      symbolIds.filter((id) => !selectedSymbols.has(id)),
    );
    const newRelations = new Set(
      relationIds.filter((id) => !selectedRelations.has(id)),
    );
    const newEvidence = new Set<string>(),
      newDiagnostics = new Set<string>();
    for (const id of newSymbols)
      for (const evidenceId of requiredSymbol(id).evidenceIds)
        if (!selectedEvidence.has(evidenceId)) newEvidence.add(evidenceId);
    for (const id of newRelations) {
      const relation = relations.get(id)!;
      for (const evidenceId of relation.resolution.evidenceIds)
        if (!selectedEvidence.has(evidenceId)) newEvidence.add(evidenceId);
      if (relation.resolution.status !== 'exact')
        for (const diagnosticId of relation.resolution.diagnosticIds)
          if (!selectedDiagnostics.has(diagnosticId))
            newDiagnostics.add(diagnosticId);
    }
    if (
      selectedSymbols.size + newSymbols.size > nodeLimit ||
      selectedRelations.size + newRelations.size > 1000 ||
      selectedEvidence.size + newEvidence.size > 5000 ||
      selectedDiagnostics.size + newDiagnostics.size > 200
    )
      return false;
    for (const id of newSymbols) selectedSymbols.add(id);
    for (const id of newRelations) selectedRelations.add(id);
    for (const id of newEvidence) selectedEvidence.add(id);
    for (const id of newDiagnostics) selectedDiagnostics.add(id);
    return true;
  }
  return {
    include,
    selectedRelations,
    selectedSymbols,
    result() {
      return {
        symbols: [...selectedSymbols]
          .map((id) => symbols.get(id)!)
          .sort(compareSymbol),
        relations: [...selectedRelations]
          .map((id) => relations.get(id)!)
          .sort(compareRelation),
        evidenceRefs: [...selectedEvidence]
          .map((id) => evidence.get(id)!)
          .sort(compareEvidence),
        diagnostics: [...selectedDiagnostics]
          .map((id) => diagnostics.get(id)!)
          .sort(compareDiagnostic),
      };
    },
  };
}
