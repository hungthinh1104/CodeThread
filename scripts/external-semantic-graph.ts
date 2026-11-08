import type {
  AnalysisFacts,
  CodeRelation,
  CodeSymbol,
  VerifiedSourceReader,
} from '@codethread/code-model';
import type {
  FindSymbolPathsResponse,
  GetSourceEvidenceResponse,
  GraphNeighborsResponse,
} from '@codethread/contracts';
import { createInvestigation } from '@codethread/trace-engine';
import type { ExternalGold } from './external-semantic-corpus.ts';
import {
  expectedEvidenceForGraph,
  verifyEvidenceItems,
  verifyExternalSourcePins,
  verifyGraphEvidenceRefs,
  type PinnedSourceFile,
} from './external-semantic-graph-evidence.ts';
import {
  externalGraphExpectations,
  type CorpusName,
  type ExternalGraphExpectation,
  type PositionAnchor,
  type SymbolAnchor,
} from './external-semantic-graph-gold.ts';
export { externalGraphExpectations } from './external-semantic-graph-gold.ts';

export type ExternalGraphResult = {
  root: string;
  target: string;
  neighbors: GraphNeighborsResponse;
  incoming: GraphNeighborsResponse;
  paths: FindSymbolPathsResponse;
  excerpts: GetSourceEvidenceResponse;
};

const nodeLimit = 20;
const relationLimit = 1000;
const evidenceLimit = 5000;
const diagnosticLimit = 200;
const expansionLimit = 10000;
const pathLimit = 20;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error('External graph oracle: ' + message);
}

function matchesPosition(
  actual: { line: number; column: number },
  expected: PositionAnchor,
): boolean {
  return actual.line === expected.line && actual.column === expected.column;
}

function matchesAnchor(symbol: CodeSymbol, expected: SymbolAnchor): boolean {
  return (
    symbol.filePath === expected.file &&
    symbol.name === expected.name &&
    matchesPosition(symbol.range.start, expected.range.start) &&
    matchesPosition(symbol.range.end, expected.range.end)
  );
}

function anchoredSymbol(
  symbols: readonly CodeSymbol[],
  expected: SymbolAnchor,
  label: string,
): CodeSymbol {
  const matches = symbols.filter((symbol) => matchesAnchor(symbol, expected));
  assert(
    matches.length === 1,
    label + ' did not resolve to one source anchor.',
  );
  return matches[0]!;
}

function factSymbol(
  facts: AnalysisFacts,
  expected: SymbolAnchor,
  label: string,
): CodeSymbol {
  return anchoredSymbol(facts.symbols, expected, label);
}

export function collectExternalGraph(
  name: CorpusName,
  facts: AnalysisFacts,
  source: VerifiedSourceReader,
): ExternalGraphResult {
  const expected = externalGraphExpectations[name];
  const root = factSymbol(facts, expected.root, name + ' root'),
    target = factSymbol(facts, expected.target, name + ' target'),
    investigation = createInvestigation(facts, source),
    neighbors = investigation.neighbors({
      snapshotId: facts.snapshotId,
      symbolId: root.id,
      direction: 'outgoing',
      relationKinds: ['calls'],
      depth: 2,
      nodeLimit,
    }),
    incoming = investigation.neighbors({
      snapshotId: facts.snapshotId,
      symbolId: target.id,
      direction: 'incoming',
      relationKinds: ['calls'],
      depth: 1,
      nodeLimit,
    }),
    paths = investigation.paths({
      snapshotId: facts.snapshotId,
      fromSymbolId: root.id,
      toSymbolId: target.id,
      relationKinds: ['calls'],
      depth: 2,
      nodeLimit,
      pathLimit,
    }),
    evidenceIds = [
      ...new Set([
        ...paths.relations.map((relation) => relation.siteEvidenceId),
        root.declarationEvidenceId,
        target.declarationEvidenceId,
      ]),
    ],
    excerpts = investigation.sourceEvidence({
      snapshotId: facts.snapshotId,
      evidenceIds,
    });
  return {
    root: root.name,
    target: target.name,
    neighbors,
    incoming,
    paths,
    excerpts,
  };
}

type GraphMeta =
  GraphNeighborsResponse['meta'] | FindSymbolPathsResponse['meta'];
type GraphResponse = GraphNeighborsResponse | FindSymbolPathsResponse;

function verifyMeta(
  meta: GraphMeta,
  snapshotId: string,
  depth: number,
  includesPaths: boolean,
): void {
  const applied = meta.appliedLimits;
  assert(meta.snapshotId === snapshotId, 'result belongs to another snapshot.');
  assert(
    meta.evidenceBasis === 'static',
    'graph evidence is not labeled static.',
  );
  assert(
    !meta.truncated && meta.truncationReasons.length === 0,
    'unexpected truncation.',
  );
  assert(applied.depth === depth, 'reported depth differs from request.');
  assert(
    applied.nodes === nodeLimit,
    'reported node limit differs from request.',
  );
  assert(
    applied.relationships === relationLimit,
    'relationship bound is missing.',
  );
  assert(
    applied.evidence === evidenceLimit,
    'graph evidence bound is missing.',
  );
  assert(
    applied.diagnostics === diagnosticLimit,
    'diagnostic bound is missing.',
  );
  assert(applied.expansions === expansionLimit, 'expansion bound is missing.');
  if (includesPaths)
    assert(
      applied.paths === pathLimit,
      'reported path limit differs from request.',
    );
}

function verifyGraphBounds(
  graph: GraphResponse,
  rootId: string,
  targetId: string,
  label: string,
): void {
  const symbolIds = graph.symbols.map((symbol) => symbol.id).sort();
  assert(
    JSON.stringify(symbolIds) === JSON.stringify([rootId, targetId].sort()),
    label + ' contains missing or unexpected symbols.',
  );
  assert(
    graph.symbols.length <= nodeLimit,
    label + ' exceeded its node limit.',
  );
  assert(
    graph.relations.length <= relationLimit,
    label + ' exceeded its relation limit.',
  );
  assert(
    graph.evidenceRefs.length <= evidenceLimit,
    label + ' exceeded its evidence limit.',
  );
  assert(
    graph.diagnostics.length <= diagnosticLimit,
    label + ' exceeded its diagnostic limit.',
  );
  for (const relation of graph.relations)
    if (relation.resolution.status !== 'exact')
      assert(
        relation.resolution.targetId === null,
        label + ' fabricated an uncertain target.',
      );
}

function exactEdge(
  response: GraphResponse,
  rootId: string,
  targetId: string,
  kind: ExternalGraphExpectation['edge']['kind'],
  label: string,
): CodeRelation {
  const exact = response.relations.filter(
    (relation) => relation.resolution.status === 'exact',
  );
  assert(exact.length === 1, label + ' has missing or fabricated exact edges.');
  const relation = exact[0]!;
  assert(
    relation.sourceSymbolId === rootId &&
      relation.kind === kind &&
      relation.resolution.status === 'exact' &&
      relation.resolution.targetId === targetId &&
      relation.resolution.evidenceIds.includes(relation.siteEvidenceId),
    label + ' edge has the wrong source, target, kind, or evidence.',
  );
  return relation;
}

function verifyRelationEvidenceIds(
  relations: readonly CodeRelation[],
  relationId: string,
  expectedEvidenceIds: readonly string[],
  label: string,
): void {
  const matches = relations.filter((relation) => relation.id === relationId);
  assert(matches.length === 1, label + ' relation is missing or duplicated.');
  const relation = matches[0]!;
  assert(
    relation.resolution.status === 'exact' &&
      JSON.stringify(relation.resolution.evidenceIds) ===
        JSON.stringify(expectedEvidenceIds),
    label +
      ' resolution evidence IDs do not match the anchored source path.',
  );
}

function verifyGraphAnchors(
  name: CorpusName,
  expectation: ExternalGraphExpectation,
  facts: AnalysisFacts,
  result: ExternalGraphResult,
) {
  const root = factSymbol(facts, expectation.root, name + ' root'),
    target = factSymbol(facts, expectation.target, name + ' target');
  assert(
    result.root === expectation.root.name,
    name + ' report names the wrong root.',
  );
  assert(
    result.target === expectation.target.name,
    name + ' report names the wrong target.',
  );
  const outgoingRoot = anchoredSymbol(
      result.neighbors.symbols,
      expectation.root,
      'outgoing root',
    ),
    outgoingTarget = anchoredSymbol(
      result.neighbors.symbols,
      expectation.target,
      'outgoing target',
    ),
    incomingRoot = anchoredSymbol(
      result.incoming.symbols,
      expectation.root,
      'incoming source',
    ),
    incomingTarget = anchoredSymbol(
      result.incoming.symbols,
      expectation.target,
      'incoming root',
    ),
    pathRoot = anchoredSymbol(
      result.paths.symbols,
      expectation.root,
      'path source',
    ),
    pathTarget = anchoredSymbol(
      result.paths.symbols,
      expectation.target,
      'path target',
    );
  assert(
    outgoingRoot.id === root.id &&
      outgoingTarget.id === target.id &&
      incomingRoot.id === root.id &&
      incomingTarget.id === target.id &&
      pathRoot.id === root.id &&
      pathTarget.id === target.id,
    'graph responses changed source-anchored identity.',
  );
  assert(
    result.neighbors.rootSymbolId === root.id,
    'outgoing graph root is incorrect.',
  );
  assert(
    result.incoming.rootSymbolId === target.id,
    'incoming graph root is incorrect.',
  );
  assert(
    result.paths.fromSymbolId === root.id &&
      result.paths.toSymbolId === target.id,
    'path query endpoints are incorrect.',
  );
  return { root, target };
}

function verifyExpectedPath(
  result: ExternalGraphResult,
  rootId: string,
  targetId: string,
  kind: ExternalGraphExpectation['edge']['kind'],
): CodeRelation {
  const outgoing = exactEdge(
      result.neighbors,
      rootId,
      targetId,
      kind,
      'outgoing',
    ),
    incoming = exactEdge(result.incoming, rootId, targetId, kind, 'incoming'),
    pathEdge = exactEdge(result.paths, rootId, targetId, kind, 'path');
  assert(
    outgoing.id === incoming.id &&
      outgoing.id === pathEdge.id &&
      outgoing.siteEvidenceId === incoming.siteEvidenceId &&
      outgoing.siteEvidenceId === pathEdge.siteEvidenceId,
    'graph directions do not preserve the same source occurrence.',
  );
  assert(result.paths.paths.length === 1, 'expected one source-pinned path.');
  const path = result.paths.paths[0]!;
  assert(
    JSON.stringify(path.symbolIds) === JSON.stringify([rootId, targetId]) &&
      JSON.stringify(path.relationIds) === JSON.stringify([outgoing.id]),
    'path is missing, reversed, or disconnected from its relations.',
  );
  const relation = result.paths.relations.find(
    (item) => item.id === path.relationIds[0],
  );
  assert(
    relation?.sourceSymbolId === rootId &&
      relation.resolution.status === 'exact' &&
      relation.resolution.targetId === targetId,
    'path relation does not connect its source and target.',
  );
  return outgoing;
}

function verifyGraphShape(
  name: CorpusName,
  expected: ExternalGraphExpectation,
  facts: AnalysisFacts,
  result: ExternalGraphResult,
): { root: CodeSymbol; target: CodeSymbol; edge: CodeRelation } {
  const { root, target } = verifyGraphAnchors(name, expected, facts, result);
  verifyMeta(result.neighbors.meta, facts.snapshotId, 2, false);
  verifyMeta(result.incoming.meta, facts.snapshotId, 1, false);
  verifyMeta(result.paths.meta, facts.snapshotId, 2, true);
  verifyGraphBounds(result.neighbors, root.id, target.id, 'outgoing graph');
  verifyGraphBounds(result.incoming, root.id, target.id, 'incoming graph');
  verifyGraphBounds(result.paths, root.id, target.id, 'path graph');
  const edge = verifyExpectedPath(
    result,
    root.id,
    target.id,
    expected.edge.kind,
  );
  return { root, target, edge };
}

export function validateExternalGraph(
  name: CorpusName,
  gold: ExternalGold,
  files: readonly PinnedSourceFile[],
  facts: AnalysisFacts,
  result: ExternalGraphResult,
): void {
  const expectation = externalGraphExpectations[name],
    pinnedFiles = verifyExternalSourcePins(name, gold, files),
    { root, target, edge } = verifyGraphShape(name, expectation, facts, result),
    evidence = expectedEvidenceForGraph(
      expectation,
      pinnedFiles,
      facts,
      edge.siteEvidenceId,
      root.declarationEvidenceId,
      target.declarationEvidenceId,
    );
  const expectedEvidenceIds = evidence.map((item) => item.id);
  verifyRelationEvidenceIds(
    result.neighbors.relations,
    edge.id,
    expectedEvidenceIds,
    'outgoing',
  );
  verifyRelationEvidenceIds(
    result.incoming.relations,
    edge.id,
    expectedEvidenceIds,
    'incoming',
  );
  verifyRelationEvidenceIds(
    result.paths.relations,
    edge.id,
    expectedEvidenceIds,
    'paths',
  );
  verifyGraphEvidenceRefs(
    result.neighbors.evidenceRefs,
    evidence,
    facts.snapshotId,
    'outgoing',
  );
  verifyGraphEvidenceRefs(
    result.incoming.evidenceRefs,
    evidence,
    facts.snapshotId,
    'incoming',
  );
  verifyGraphEvidenceRefs(
    result.paths.evidenceRefs,
    evidence,
    facts.snapshotId,
    'paths',
  );
  verifyEvidenceItems(result.excerpts, evidence, facts.snapshotId);
}
