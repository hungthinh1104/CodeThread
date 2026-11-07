import type {
  AnalysisFacts,
  CodeRelation,
  CodeSymbol,
  Diagnostic,
  SourceEvidence,
  VerifiedSourceReader,
} from '@codethread/code-model';
import { TraceError } from './fact-integrity.js';
import { validateFacts } from './validation.js';

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

/** Owns one verified immutable snapshot and its source-ordered adjacency indexes. */
export function createContext(
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
    relationKinds: ReadonlySet<CodeRelation['kind']>,
  ): CodeRelation[] {
    if (direction === 'outgoing')
      return (outgoing.get(id) ?? []).filter((relation) =>
        relationKinds.has(relation.kind),
      );
    if (direction === 'incoming')
      return (incoming.get(id) ?? []).filter((relation) =>
        relationKinds.has(relation.kind),
      );
    const distinct = new Map<string, CodeRelation>();
    for (const relation of [
      ...(outgoing.get(id) ?? []),
      ...(incoming.get(id) ?? []),
    ])
      if (relationKinds.has(relation.kind)) distinct.set(relation.id, relation);
    return [...distinct.values()].sort(compareRelation);
  }

  return {
    facts,
    retained,
    readEvidence,
    files,
    symbols,
    relations,
    evidence,
    diagnostics,
    compareEvidence,
    compareRelation,
    compareSymbol,
    compareDiagnostic,
    outgoing,
    scope,
    requiredSymbol,
    adjacent,
  };
}
export type InvestigationContext = ReturnType<typeof createContext>;
