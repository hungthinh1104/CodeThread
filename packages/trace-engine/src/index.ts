import {
  findSymbolPathsRequestSchema,
  getSourceEvidenceRequestSchema,
  graphNeighborsRequestSchema,
  parseFindSymbolPathsResult,
  parseGetSourceEvidenceResult,
  parseGraphNeighborsResult,
} from '@codethread/contracts';
import { summarizeCoverage } from '@codethread/code-model';
import type {
  AnalysisFacts,
  CodeRelation,
  CodeSymbol,
  Diagnostic,
  SourceEvidence,
  VerifiedSourceReader,
} from '@codethread/code-model';
import { sameRange, TraceError, validateFacts } from './validation.js';
export { TraceError } from './validation.js';

type Reason = 'result_limit' | 'depth_limit' | 'search_budget';
const textOrder = (left: string, right: string): number => {
  const a = new TextEncoder().encode(left),
    b = new TextEncoder().encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index++)
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  return a.length - b.length;
};
function freeze(value: unknown): void {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
}

export function createInvestigation(
  input: AnalysisFacts,
  source: VerifiedSourceReader,
) {
  let facts: AnalysisFacts;
  try {
    facts = structuredClone(input);
  } catch {
    throw new TraceError('INVALID_FACTS', 'Invalid semantic facts');
  }
  const retained = validateFacts(facts, source);
  freeze(facts);
  const readEvidence = source.readEvidence.bind(source);
  const files = new Map(facts.files.map((item) => [item.id, item]));
  const symbols = new Map(facts.symbols.map((item) => [item.id, item]));
  const relations = new Map(facts.relations.map((item) => [item.id, item]));
  const evidence = new Map(facts.evidenceRefs.map((item) => [item.id, item]));
  const diagnostics = new Map(facts.diagnostics.map((item) => [item.id, item]));
  const compareEvidence = (a: SourceEvidence, b: SourceEvidence) =>
    textOrder(files.get(a.fileId)!.path, files.get(b.fileId)!.path) ||
    a.range.start.offset - b.range.start.offset ||
    a.range.end.offset - b.range.end.offset ||
    textOrder(a.id, b.id);
  const compareRelation = (a: CodeRelation, b: CodeRelation) =>
    compareEvidence(
      evidence.get(a.siteEvidenceId)!,
      evidence.get(b.siteEvidenceId)!,
    ) || textOrder(a.key, b.key);
  const compareSymbol = (a: CodeSymbol, b: CodeSymbol) =>
    textOrder(a.filePath, b.filePath) ||
    a.range.start.offset - b.range.start.offset ||
    textOrder(a.key, b.key);
  const compareDiagnostic = (a: Diagnostic, b: Diagnostic) =>
    textOrder(a.filePath ?? '', b.filePath ?? '') ||
    (a.range?.start.offset ?? 0) - (b.range?.start.offset ?? 0) ||
    textOrder(a.id, b.id);
  const outgoing = new Map<string, CodeRelation[]>(),
    incoming = new Map<string, CodeRelation[]>();
  const add = (
    map: Map<string, CodeRelation[]>,
    id: string,
    relation: CodeRelation,
  ) => {
    const rows = map.get(id);
    if (rows) rows.push(relation);
    else map.set(id, [relation]);
  };
  for (const relation of [...facts.relations].sort(compareRelation)) {
    add(outgoing, relation.sourceSymbolId, relation);
    if (relation.resolution.status === 'exact')
      add(incoming, relation.resolution.targetId, relation);
  }
  function scope(snapshotId: string): void {
    if (snapshotId !== facts.snapshotId)
      throw new TraceError(
        'SNAPSHOT_NOT_FOUND',
        'Snapshot does not match the investigation',
      );
  }
  function requiredSymbol(id: string): CodeSymbol {
    const value = symbols.get(id);
    if (!value) throw new TraceError('ENTITY_NOT_FOUND', 'Symbol not found');
    return value;
  }
  function adjacent(
    id: string,
    direction: 'outgoing' | 'incoming' | 'both',
  ): CodeRelation[] {
    if (direction === 'outgoing') return outgoing.get(id) ?? [];
    if (direction === 'incoming') return incoming.get(id) ?? [];
    const distinct = new Map<string, CodeRelation>();
    for (const relation of [
      ...(outgoing.get(id) ?? []),
      ...(incoming.get(id) ?? []),
    ])
      distinct.set(relation.id, relation);
    return [...distinct.values()].sort(compareRelation);
  }
  function metadata(limits: Record<string, number>, reasons: Set<Reason>) {
    const order: Reason[] = ['result_limit', 'depth_limit', 'search_budget'];
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
  function builder(nodeLimit: number) {
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
  function neighbors(requestInput: unknown) {
    const request = graphNeighborsRequestSchema.parse(requestInput);
    scope(request.snapshotId);
    requiredSymbol(request.symbolId);
    const graph = builder(request.nodeLimit),
      reasons = new Set<Reason>();
    if (!graph.include([request.symbolId], []))
      throw new TraceError(
        'RESOURCE_LIMIT',
        'Root evidence exceeds the graph budget',
      );
    const distances = new Map([[request.symbolId, 0]]),
      queue = [request.symbolId];
    let examined = 0,
      stop = false;
    for (let index = 0; index < queue.length && !stop; index++) {
      const current = queue[index]!,
        depth = distances.get(current)!;
      for (const relation of adjacent(current, request.direction)) {
        if (++examined > 10000) {
          reasons.add('search_budget');
          stop = true;
          break;
        }
        if (graph.selectedRelations.has(relation.id)) continue;
        if (depth >= request.depth) {
          reasons.add('depth_limit');
          continue;
        }
        const other =
          relation.resolution.status === 'exact'
            ? relation.sourceSymbolId === current
              ? relation.resolution.targetId
              : relation.sourceSymbolId
            : null;
        if (!graph.include(other ? [other] : [], [relation.id])) {
          reasons.add('result_limit');
          continue;
        }
        if (other && !distances.has(other)) {
          distances.set(other, depth + 1);
          queue.push(other);
        }
      }
    }
    return parseGraphNeighborsResult(request, {
      meta: metadata(
        {
          depth: request.depth,
          nodes: request.nodeLimit,
          relationships: 1000,
          evidence: 5000,
          diagnostics: 200,
          expansions: 10000,
        },
        reasons,
      ),
      rootSymbolId: request.symbolId,
      ...graph.result(),
    });
  }
  function paths(requestInput: unknown) {
    const request = findSymbolPathsRequestSchema.parse(requestInput);
    scope(request.snapshotId);
    requiredSymbol(request.fromSymbolId);
    requiredSymbol(request.toSymbolId);
    const graph = builder(request.nodeLimit),
      reasons = new Set<Reason>();
    const rootIds = [...new Set([request.fromSymbolId, request.toSymbolId])];
    if (!graph.include(rootIds, []))
      throw new TraceError(
        'RESOURCE_LIMIT',
        'Path roots exceed the graph budget',
      );
    type Path = { symbolIds: string[]; relationIds: string[] };
    const returned: Path[] = [];
    const visited = new Set(rootIds);
    const queue: Path[] = [
      { symbolIds: [request.fromSymbolId], relationIds: [] },
    ];
    let examined = 0,
      stop = false;
    if (request.fromSymbolId === request.toSymbolId) returned.push(queue[0]!);
    else
      for (let index = 0; index < queue.length && !stop; index++) {
        const path = queue[index]!,
          current = path.symbolIds.at(-1)!;
        for (const relation of outgoing.get(current) ?? []) {
          if (++examined > 10000) {
            reasons.add('search_budget');
            stop = true;
            break;
          }
          if (
            relation.resolution.status !== 'exact' ||
            path.symbolIds.includes(relation.resolution.targetId)
          )
            continue;
          if (path.relationIds.length >= request.depth) {
            reasons.add('depth_limit');
            continue;
          }
          const target = relation.resolution.targetId;
          if (!visited.has(target) && visited.size >= request.nodeLimit) {
            reasons.add('result_limit');
            continue;
          }
          visited.add(target);
          const next = {
            symbolIds: [...path.symbolIds, target],
            relationIds: [...path.relationIds, relation.id],
          };
          if (target === request.toSymbolId) {
            if (returned.length >= request.pathLimit) {
              reasons.add('result_limit');
              stop = true;
              break;
            }
            if (!graph.include(next.symbolIds, next.relationIds)) {
              reasons.add('result_limit');
              continue;
            }
            returned.push(next);
          } else queue.push(next);
        }
      }
    return parseFindSymbolPathsResult(request, {
      meta: metadata(
        {
          depth: request.depth,
          nodes: request.nodeLimit,
          paths: request.pathLimit,
          relationships: 1000,
          evidence: 5000,
          diagnostics: 200,
          expansions: 10000,
        },
        reasons,
      ),
      fromSymbolId: request.fromSymbolId,
      toSymbolId: request.toSymbolId,
      ...graph.result(),
      paths: returned,
    });
  }
  function sourceEvidence(requestInput: unknown) {
    const request = getSourceEvidenceRequestSchema.parse(requestInput);
    scope(request.snapshotId);
    const items = request.evidenceIds.map((id) => {
      const unavailable = (
        code:
          'EVIDENCE_NOT_FOUND' | 'EVIDENCE_TOO_LARGE' | 'SOURCE_UNAVAILABLE',
      ) => ({
        status: 'unavailable' as const,
        snapshotId: facts.snapshotId,
        evidenceId: id,
        code,
      });
      const expected = evidence.get(id);
      if (!expected) return unavailable('EVIDENCE_NOT_FOUND');
      if (expected.range.end.offset - expected.range.start.offset > 65536)
        return unavailable('EVIDENCE_TOO_LARGE');
      const file = files.get(expected.fileId)!,
        original = retained.get(file.id)!;
      const text = original.text.slice(
        expected.range.start.offset,
        expected.range.end.offset,
      );
      let result: ReturnType<VerifiedSourceReader['readEvidence']>;
      try {
        result = readEvidence(id);
      } catch {
        return unavailable('SOURCE_UNAVAILABLE');
      }
      if (result.status !== 'available')
        return result.snapshotId === facts.snapshotId &&
          result.evidenceId === id
          ? result
          : unavailable('SOURCE_UNAVAILABLE');
      const actual = result.evidence;
      if (
        actual.id !== expected.id ||
        actual.snapshotId !== expected.snapshotId ||
        actual.fileId !== expected.fileId ||
        actual.contentHash !== expected.contentHash ||
        actual.kind !== expected.kind ||
        actual.extractor.name !== expected.extractor.name ||
        actual.extractor.version !== expected.extractor.version ||
        !sameRange(actual.range, expected.range) ||
        result.filePath !== file.path ||
        result.text !== text
      )
        return unavailable('SOURCE_UNAVAILABLE');
      return {
        status: 'available' as const,
        evidence: expected,
        filePath: file.path,
        text,
      };
    });
    return parseGetSourceEvidenceResult(request, {
      meta: metadata({ evidence: 100 }, new Set()),
      items,
    });
  }
  return Object.freeze({ neighbors, paths, sourceEvidence });
}
