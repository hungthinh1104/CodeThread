import type {
  AnalysisFacts,
  CodeSymbol,
  SourceReadResult,
} from '@codethread/code-model';
import type { AnalysisSnapshot } from '@codethread/symbol-indexer';
import type { createInvestigation } from '@codethread/trace-engine';
import { CliError } from './commands.ts';
import { escapeTerminal, quoted } from './terminal.ts';
import { displaySelector } from './selectors.ts';
import type { Direction, RelationKind } from './selectors.ts';
import { fileHashes, renderEvidence } from './render-common.ts';
import { evidenceMap, getAvailableEvidence } from './render-evidence.ts';

const MAX_RELATION_ROWS = 20;
const MAX_UNKNOWN_ROWS = 10;
const ORDER = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

type Investigation = ReturnType<typeof createInvestigation>;
type NeighborGraph = ReturnType<Investigation['neighbors']>;
type Observation = AnalysisFacts['observations'][number];

interface InspectionData {
  facts: AnalysisFacts;
  graph: NeighborGraph;
  symbols: Map<string, CodeSymbol>;
  hashes: Map<string, string>;
  displayedRelations: NeighborGraph['relations'];
  orphanObservations: Observation[];
  evidence: Map<string, SourceReadResult>;
}

function loadInspectionData(
  snapshot: AnalysisSnapshot,
  investigation: Investigation,
  selected: CodeSymbol,
  kinds: RelationKind[],
  direction: Direction,
): InspectionData {
  const { facts } = snapshot;
  const graph = investigation.neighbors({
    snapshotId: facts.snapshotId,
    symbolId: selected.id,
    direction,
    relationKinds: kinds,
    depth: 1,
    nodeLimit: 50,
  });
  const symbols = new Map(facts.symbols.map((symbol) => [symbol.id, symbol]));
  const hashes = fileHashes(facts);
  const displayedRelations = graph.relations.slice(0, MAX_RELATION_ROWS);
  const orphanObservations = facts.observations
    .filter(
      (observation) =>
        observation.ownerId === selected.id &&
        observation.status !== 'exact' &&
        observation.relationId === null,
    )
    .slice(0, MAX_UNKNOWN_ROWS);
  const evidenceIds = [selected.declarationEvidenceId];
  for (const relation of displayedRelations) {
    evidenceIds.push(relation.siteEvidenceId);
    const source = symbols.get(relation.sourceSymbolId);
    if (source) evidenceIds.push(source.declarationEvidenceId);
    if (relation.resolution.status === 'exact') {
      const target = symbols.get(relation.resolution.targetId);
      if (target) evidenceIds.push(target.declarationEvidenceId);
    }
  }
  for (const observation of orphanObservations)
    evidenceIds.push(observation.evidenceId);
  const evidence = evidenceMap(investigation, facts.snapshotId, evidenceIds);
  return {
    facts,
    graph,
    symbols,
    hashes,
    displayedRelations,
    orphanObservations,
    evidence,
  };
}

function appendSummary(
  blocks: string[],
  facts: AnalysisFacts,
  selected: CodeSymbol,
  hashes: ReadonlyMap<string, string>,
  evidence: ReadonlyMap<string, SourceReadResult>,
): void {
  const declaration = getAvailableEvidence(
    evidence,
    selected.declarationEvidenceId,
  );
  if (!declaration || declaration.status !== 'available')
    throw new CliError(
      declaration?.status === 'unavailable'
        ? declaration.code
        : 'EVIDENCE_NOT_FOUND',
      `Selected declaration evidence is unavailable for ${displaySelector(selected)}.`,
    );
  blocks.push(
    `${selected.kind} ${quoted(selected.name)} — ${displaySelector(selected)}`,
    'STATIC RELATIONSHIPS ONLY. A reference is not a call or runtime dispatch.',
    ...renderEvidence(declaration, hashes),
  );
  const owned = facts.observations.filter(
    (observation) => observation.ownerId === selected.id,
  );
  if (owned.length > 0) {
    const counts = new Map<string, number>();
    for (const observation of owned)
      counts.set(observation.status, (counts.get(observation.status) ?? 0) + 1);
    blocks.push(
      `Owned call-site observations: ${[...counts]
        .sort(([left], [right]) => ORDER(left, right))
        .map(([status, count]) => `${status}=${count}`)
        .join(', ')}.`,
    );
  }
  const sourceDiagnostics = facts.diagnostics.filter(
    (item) => item.filePath === selected.filePath,
  );
  blocks.push(
    `Snapshot coverage: ${Object.entries(facts.coverageByCapability)
      .sort(([left], [right]) => ORDER(left, right))
      .map(([name, status]) => `${name}=${status}`)
      .join(', ')}`,
    `Diagnostics in this source file: ${sourceDiagnostics.length}.`,
  );
}

function appendRelations(
  blocks: string[],
  data: InspectionData,
  selected: CodeSymbol,
  targets: Map<number, CodeSymbol>,
  kinds: RelationKind[],
  direction: Direction,
): void {
  const { displayedRelations, graph } = data;
  targets.clear();
  if (graph.relations.length === 0)
    blocks.push(
      `No ${kinds.join(', ')} relationships were returned in the ${direction} one-hop view. Partial or unsupported coverage means this is not proof that no relationship exists.`,
    );
  for (const relation of displayedRelations) {
    appendRelation(blocks, relation, data, selected, targets);
  }
  if (graph.relations.length > displayedRelations.length)
    blocks.push(
      `CLI display omitted ${graph.relations.length - displayedRelations.length} of ${graph.relations.length} returned relationship occurrences; narrow the source or direction.`,
    );
}

function appendRelation(
  blocks: string[],
  relation: NeighborGraph['relations'][number],
  data: InspectionData,
  selected: CodeSymbol,
  targets: Map<number, CodeSymbol>,
): void {
  const { evidence, graph, hashes, symbols } = data;
  const isOutgoing = relation.sourceSymbolId === selected.id;
  const counterpartId = isOutgoing
    ? relation.resolution.status === 'exact'
      ? relation.resolution.targetId
      : null
    : relation.sourceSymbolId;
  const counterpart = counterpartId ? symbols.get(counterpartId) : undefined;
  const site = getAvailableEvidence(evidence, relation.siteEvidenceId);
  const diagnosticText =
    relation.resolution.status === 'exact'
      ? ''
      : relation.resolution.diagnosticIds
          .map((id) => graph.diagnostics.find((item) => item.id === id))
          .filter((item) => item !== undefined)
          .map((item) => `${item.code}: ${escapeTerminal(item.message)}`)
          .join('; ');
  const heading = `[${relation.kind.toUpperCase()} ${relation.resolution.status}] ${isOutgoing ? 'outgoing →' : 'incoming ←'}`;
  if (relation.resolution.status !== 'exact') {
    blocks.push(
      [
        `${heading} — target unknown (${relation.resolution.status})`,
        diagnosticText
          ? `  Diagnostic: ${diagnosticText}`
          : '  No exact target was inferred.',
        ...renderEvidence(site, hashes),
      ].join('\n'),
    );
    return;
  }
  if (
    !counterpart ||
    !relation.resolution.evidenceIds.includes(counterpart.declarationEvidenceId)
  )
    throw new CliError(
      'INVALID_FACTS',
      'Exact relationship is missing its target declaration evidence.',
    );
  const targetEvidence = getAvailableEvidence(
    evidence,
    counterpart.declarationEvidenceId,
  );
  if (
    !site ||
    site.status !== 'available' ||
    !targetEvidence ||
    targetEvidence.status !== 'available'
  ) {
    const unavailable = [site, targetEvidence]
      .filter((item) => item?.status === 'unavailable')
      .map((item) => (item?.status === 'unavailable' ? item.code : ''));
    blocks.push(
      `${heading} omitted: verified site/declaration evidence unavailable (${unavailable.join(', ') || 'EVIDENCE_NOT_FOUND'}).`,
    );
    return;
  }
  const rowIndex = blocks.length;
  targets.set(rowIndex, counterpart);
  blocks.push(
    [
      `${heading} ${quoted(counterpart.name)} (${counterpart.kind}) — ${displaySelector(counterpart)}`,
      `  ${relation.kind === 'calls' ? 'Call' : 'Reference'} occurrence:`,
      ...renderEvidence(site, hashes),
      '  Target declaration:',
      ...renderEvidence(targetEvidence, hashes),
    ].join('\n'),
  );
}

function appendTruncation(blocks: string[], graph: NeighborGraph): void {
  if (graph.meta.truncated)
    blocks.push(
      `Query truncated: ${graph.meta.truncationReasons.join(', ')}; applied depth=${graph.meta.appliedLimits.depth}, nodes=${graph.meta.appliedLimits.nodes}, relationships=${graph.meta.appliedLimits.relationships}.`,
    );
  else
    blocks.push(
      `Applied query limits: depth=${graph.meta.appliedLimits.depth}, nodes=${graph.meta.appliedLimits.nodes}, relationships=${graph.meta.appliedLimits.relationships}.`,
      'Query truncation: none reported by the trace engine.',
    );
}

function appendOrphanObservations(
  blocks: string[],
  data: InspectionData,
  selected: CodeSymbol,
): void {
  const { evidence, facts, hashes, orphanObservations } = data;
  if (orphanObservations.length === 0) return;
  const fullCount = facts.observations.filter(
    (item) =>
      item.ownerId === selected.id &&
      item.status !== 'exact' &&
      item.relationId === null,
  ).length;
  blocks.push(
    `Unsupported/unresolved call sites without graph edges (${orphanObservations.length}${fullCount > orphanObservations.length ? '+' : ''}):`,
  );
  for (const observation of orphanObservations) {
    const diagnostic = observation.diagnosticId
      ? facts.diagnostics.find((item) => item.id === observation.diagnosticId)
      : undefined;
    const item = getAvailableEvidence(evidence, observation.evidenceId);
    blocks.push(
      [
        `${observation.status}${diagnostic ? ` — ${diagnostic.code}: ${escapeTerminal(diagnostic.message)}` : ''}`,
        ...renderEvidence(item, hashes),
      ].join('\n'),
    );
  }
}

export function inspectBlocks(
  snapshot: AnalysisSnapshot,
  investigation: Investigation,
  selected: CodeSymbol,
  kinds: RelationKind[],
  direction: Direction,
  targets: Map<number, CodeSymbol>,
): string[] {
  const data = loadInspectionData(
    snapshot,
    investigation,
    selected,
    kinds,
    direction,
  );
  const blocks: string[] = [];
  appendSummary(blocks, data.facts, selected, data.hashes, data.evidence);
  appendRelations(blocks, data, selected, targets, kinds, direction);
  appendTruncation(blocks, data.graph);
  appendOrphanObservations(blocks, data, selected);
  return blocks;
}
