import type { CodeRelation, CodeSymbol } from '@codethread/code-model';
import type { GraphNeighborsResponse } from '@codethread/contracts';
import type { AnalysisSnapshot } from '@codethread/symbol-indexer';
import { createInvestigation } from '@codethread/trace-engine';
import type { RepositoryCorpus } from './repository-corpus.ts';
import type { RepositoryGoldAnchor } from './repository-gold.ts';
import {
  equalGoldRange,
  goldSiteKey,
  pinnedSourceExcerpt,
} from './repository-gold-source.ts';

export type GoldIssue = {
  code:
    | 'wrong_owner'
    | 'wrong_kind'
    | 'wrong_direction'
    | 'wrong_target'
    | 'evidence_mismatch'
    | 'identity_mismatch'
    | 'wrong_status'
    | 'missing_occurrence'
    | 'duplicate_occurrence'
    | 'unexpected_exact'
    | 'invalid_projection';
  message: string;
};

export function repositoryGoldContext(snapshot: AnalysisSnapshot) {
  let queries: ReturnType<typeof createInvestigation> | undefined;
  const evidence = new Map(
    snapshot.facts.evidenceRefs.map((item) => [item.id, item]),
  );
  const files = new Map(snapshot.facts.files.map((item) => [item.id, item]));
  return {
    snapshot,
    // Diagnose raw claims even if the trace engine refuses to load them.
    get queries() {
      return (queries ??= createInvestigation(snapshot.facts, snapshot.source, {
        resourceProfile: 'repository',
      }));
    },
    evidence,
    files,
    occurrenceKey(evidenceId: string) {
      const site = evidence.get(evidenceId);
      const file = site && files.get(site.fileId);
      return site && file ? goldSiteKey(file.path, site.range) : undefined;
    },
  };
}
export type RepositoryGoldContext = ReturnType<typeof repositoryGoldContext>;

export function matchesEvidence(
  context: RepositoryGoldContext,
  id: string,
  expected: RepositoryGoldAnchor,
) {
  const evidence = context.evidence.get(id);
  const file = evidence && context.files.get(evidence.fileId);
  const snapshot = context.snapshot.facts.snapshotId;
  return Boolean(
    evidence &&
    file &&
    file.path === expected.file &&
    file.snapshotId === snapshot &&
    evidence.snapshotId === snapshot &&
    file.contentHash === expected.sourceSha256 &&
    evidence.contentHash === expected.sourceSha256 &&
    equalGoldRange(evidence.range, expected),
  );
}

export class TraceGoldIssue extends Error {
  constructor(
    readonly code: GoldIssue['code'],
    message: string,
  ) {
    super(message);
  }
}
function requireTrace(
  condition: unknown,
  code: GoldIssue['code'],
  message: string,
): asserts condition {
  if (!condition) throw new TraceGoldIssue(code, message);
}

export function directScopeAvailable(
  meta: GraphNeighborsResponse['meta'],
): boolean {
  // A depth limit omits subsequent hops. Check every expected direct row below.
  return (
    meta.truncationReasons.every((reason) => reason === 'depth_limit') &&
    meta.truncated === meta.truncationReasons.length > 0
  );
}

export function checkProjection(
  context: RepositoryGoldContext,
  graph: GraphNeighborsResponse,
  relation: CodeRelation,
  root: CodeSymbol,
) {
  requireTrace(
    directScopeAvailable(graph.meta),
    'invalid_projection',
    'Gold trace projection exceeded the direct-scope budget',
  );
  requireTrace(
    graph.meta.snapshotId === context.snapshot.facts.snapshotId,
    'identity_mismatch',
    'Gold trace projection belongs to another snapshot',
  );
  requireTrace(
    graph.rootSymbolId === root.id,
    'wrong_direction',
    'Gold trace projection is rooted at the wrong endpoint',
  );
  checkProjectedClaim(context, graph, relation);
}

function checkProjectedClaim(
  context: RepositoryGoldContext,
  graph: Pick<GraphNeighborsResponse, 'relations' | 'evidenceRefs' | 'symbols'>,
  relation: CodeRelation,
) {
  const row = graph.relations.find((item) => item.id === relation.id);
  requireTrace(
    row,
    'wrong_direction',
    'Gold edge is absent from its directional projection',
  );
  requireTrace(
    row.sourceSymbolId === relation.sourceSymbolId,
    'wrong_owner',
    'Gold projected lexical owner differs',
  );
  requireTrace(
    row.kind === relation.kind,
    'wrong_kind',
    'Gold projected relation kind differs',
  );
  requireTrace(
    row.resolution.status === relation.resolution.status,
    'wrong_status',
    'Gold projected resolution status differs',
  );
  requireTrace(
    row.resolution.targetId === relation.resolution.targetId,
    'wrong_target',
    'Outgoing or incoming graph selected a different exact target',
  );
  requireTrace(
    row.snapshotId === relation.snapshotId,
    'identity_mismatch',
    'Gold projected relation changed snapshot',
  );
  requireTrace(
    row.siteEvidenceId === relation.siteEvidenceId &&
      JSON.stringify(row.resolution.evidenceIds) ===
        JSON.stringify(relation.resolution.evidenceIds),
    'evidence_mismatch',
    'Gold projected relation changed evidence identity',
  );
  for (const id of [relation.sourceSymbolId, relation.resolution.targetId]) {
    if (id === null) continue;
    const expected = context.snapshot.facts.symbols.find(
      (symbol) => symbol.id === id,
    );
    const observed = graph.symbols.find((symbol) => symbol.id === id);
    requireTrace(
      expected &&
        observed &&
        expected.fileId === observed.fileId &&
        expected.filePath === observed.filePath &&
        expected.kind === observed.kind &&
        expected.snapshotId === observed.snapshotId &&
        equalGoldRange(expected.range, observed.range) &&
        expected.declarationEvidenceId === observed.declarationEvidenceId,
      'identity_mismatch',
      'Gold projected declaration changed source or snapshot identity',
    );
  }
  for (const id of relation.resolution.evidenceIds) {
    const expected = context.evidence.get(id);
    const observed = graph.evidenceRefs.find((entry) => entry.id === id);
    requireTrace(
      expected &&
        observed &&
        expected.fileId === observed.fileId &&
        expected.contentHash === observed.contentHash &&
        expected.snapshotId === observed.snapshotId &&
        expected.kind === observed.kind &&
        expected.extractor.name === observed.extractor.name &&
        expected.extractor.version === observed.extractor.version &&
        equalGoldRange(expected.range, observed.range),
      'evidence_mismatch',
      'Gold projected evidence changed the original anchor',
    );
  }
}

export function checkTrace(
  context: RepositoryGoldContext,
  relation: CodeRelation,
  owner: CodeSymbol,
  target: CodeSymbol | undefined,
  corpus: RepositoryCorpus,
) {
  const snapshotId = context.snapshot.facts.snapshotId;
  const request = {
    snapshotId,
    relationKinds: [relation.kind],
    depth: 1,
    nodeLimit: 200,
  };
  checkProjection(
    context,
    context.queries.neighbors({
      ...request,
      symbolId: owner.id,
      direction: 'outgoing',
    }),
    relation,
    owner,
  );
  if (target) {
    checkProjection(
      context,
      context.queries.neighbors({
        ...request,
        symbolId: target.id,
        direction: 'incoming',
      }),
      relation,
      target,
    );
    // A same-root path query returns the trivial path. The neighbors prove the self-edge.
    if (owner.id !== target.id) {
      const paths = context.queries.paths({
        ...request,
        fromSymbolId: owner.id,
        toSymbolId: target.id,
        pathLimit: 20,
      });
      requireTrace(
        directScopeAvailable(paths.meta),
        'invalid_projection',
        'Gold direct path projection exceeded its budget',
      );
      requireTrace(
        paths.meta.snapshotId === snapshotId,
        'identity_mismatch',
        'Gold direct path belongs to another snapshot',
      );
      const direct = paths.paths.find(
        (path) =>
          path.relationIds.length === 1 && path.relationIds[0] === relation.id,
      );
      requireTrace(
        paths.fromSymbolId === owner.id &&
          paths.toSymbolId === target.id &&
          direct &&
          direct.symbolIds.length === 2 &&
          direct.symbolIds[0] === owner.id &&
          direct.symbolIds[1] === target.id,
        'wrong_direction',
        'Gold direct path is absent or reversed',
      );
      checkProjectedClaim(context, paths, relation);
    }
  }
  for (const id of relation.resolution.evidenceIds) {
    const evidence = context.evidence.get(id);
    const file = evidence && context.files.get(evidence.fileId);
    requireTrace(
      file && evidence,
      'evidence_mismatch',
      'Gold support evidence is missing',
    );
    const result = context.queries.sourceEvidence({
      snapshotId,
      evidenceIds: [id],
    });
    requireTrace(
      result.meta.snapshotId === snapshotId,
      'identity_mismatch',
      'Gold evidence response belongs to another snapshot',
    );
    const item = result.items[0];
    const text = pinnedSourceExcerpt(corpus, {
      file: file.path,
      sourceSha256: evidence.contentHash,
      ...evidence.range,
    });
    requireTrace(
      item?.status === 'available' &&
        item.filePath === file.path &&
        item.evidence.id === id &&
        matchesEvidence(context, id, {
          file: item.filePath,
          sourceSha256: item.evidence.contentHash,
          ...item.evidence.range,
        }) &&
        item.evidence.fileId === file.id &&
        item.evidence.snapshotId === snapshotId &&
        item.text === text,
      'evidence_mismatch',
      'Gold evidence is unavailable or differs from the original source',
    );
  }
}
