import { z } from 'zod';
import {
  symbolSchema,
  codeRelationSchema,
  sourceEvidenceSchema,
  diagnosticSchema,
} from '@codethread/code-model';
import type { QueryMeta } from './query-common.js';
import {
  checkUnique,
  indexEvidence,
  checkDeclaration,
  checkSite,
} from './integrity.js';

export const graphFields = {
  symbols: z.array(symbolSchema).max(200),
  relations: z.array(codeRelationSchema).max(1000),
  evidenceRefs: z.array(sourceEvidenceSchema).max(5000),
  diagnostics: z.array(diagnosticSchema).max(200),
};

type Graph = {
  [K in keyof typeof graphFields]: z.infer<(typeof graphFields)[K]>;
};

export function graphIntegrity(
  graph: Graph & { meta: QueryMeta },
  context: z.RefinementCtx,
): void {
  for (const values of [graph.symbols, graph.relations, graph.diagnostics]) {
    checkUnique(values, context, []);
  }
  const symbolIds = new Set(graph.symbols.map((item) => item.id));
  const symbols = new Map(graph.symbols.map((item) => [item.id, item]));
  const evidence = indexEvidence(
    graph.evidenceRefs,
    graph.meta.snapshotId,
    context,
  );
  const evidenceIds = new Set(graph.evidenceRefs.map((item) => item.id));
  const diagnosticIds = new Set(graph.diagnostics.map((item) => item.id));
  for (const symbol of graph.symbols) {
    checkDeclaration(symbol, evidence, context, ['symbols', symbol.id]);
    if (symbol.evidenceIds.some((id) => !evidenceIds.has(id))) {
      context.addIssue({
        code: 'custom',
        message: 'Missing symbol evidence reference',
      });
    }
  }
  for (const relation of graph.relations) {
    const source = symbols.get(relation.sourceSymbolId);
    if (source)
      checkSite(
        relation.siteEvidenceId,
        source.declarationEvidenceId,
        evidence,
        context,
        ['relations', relation.id, 'siteEvidenceId'],
      );
    if (
      !symbolIds.has(relation.sourceSymbolId) ||
      (relation.resolution.status === 'exact' &&
        !symbolIds.has(relation.resolution.targetId))
    ) {
      context.addIssue({ code: 'custom', message: 'Dangling graph endpoint' });
    }
    checkResolutionReferences(
      relation.resolution,
      evidenceIds,
      diagnosticIds,
      context,
    );
  }
}

type ResolutionReferences = z.infer<typeof codeRelationSchema>['resolution'];

export function checkResolutionReferences(
  resolution: ResolutionReferences,
  evidence: Set<string>,
  diagnostics: Set<string>,
  context: z.RefinementCtx,
): void {
  if (
    resolution.evidenceIds.some((id) => !evidence.has(id)) ||
    (resolution.status !== 'exact' &&
      resolution.diagnosticIds.some((id) => !diagnostics.has(id)))
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Missing resolution evidence or diagnostic reference',
    });
  }
}
