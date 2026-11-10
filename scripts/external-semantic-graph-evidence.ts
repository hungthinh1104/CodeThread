import { createHash } from 'node:crypto';
import type { AnalysisFacts, SourceEvidence } from '@codethread/code-model';
import type {
  FindSymbolPathsResponse,
  GetSourceEvidenceResponse,
  GraphNeighborsResponse,
} from '@codethread/contracts';
import type { ExternalGold } from './external-semantic-corpus.ts';
import {
  externalGraphExpectations,
  type CorpusName,
  type ExternalGraphExpectation,
  type PositionAnchor,
  type RangeAnchor,
} from './external-semantic-graph-gold.ts';

export type PinnedSourceFile = {
  path: string;
  sha256: string;
  bytes: Uint8Array;
};

export type AnchoredEvidence = {
  id: string;
  anchor: { file: string; range: RangeAnchor };
  file: PinnedSourceFile;
  fileId: string;
  text?: string;
};

type GraphEvidenceResponse = Pick<
  GraphNeighborsResponse | FindSymbolPathsResponse,
  'symbols' | 'relations'
>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error('External graph evidence: ' + message);
}

function decodeSource(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function matchesPosition(
  actual: { line: number; column: number },
  expected: PositionAnchor,
): boolean {
  return actual.line === expected.line && actual.column === expected.column;
}

function offsetAt(source: string, position: PositionAnchor): number {
  const lines = source.split(/\r\n|\r|\n|\u2028|\u2029/);
  assert(position.line <= lines.length, 'source line is outside pinned bytes.');
  const line = lines[position.line - 1]!;
  assert(
    position.column <= line.length + 1,
    'source column is outside pinned bytes.',
  );
  let offset = 0;
  for (let index = 0; index < position.line - 1; index++) {
    const separator = source.slice(offset).match(/\r\n|\r|\n|\u2028|\u2029/);
    assert(separator, 'pinned source line map is inconsistent.');
    offset += separator[0].length + separator.index!;
  }
  return offset + position.column - 1;
}

function rangeOffsets(source: string, range: RangeAnchor) {
  const start = offsetAt(source, range.start);
  const end = offsetAt(source, range.end);
  assert(end >= start, 'source anchor end precedes its start.');
  return { start, end };
}

export function verifyExternalSourcePins(
  name: CorpusName,
  gold: ExternalGold,
  files: readonly PinnedSourceFile[],
): Readonly<Record<string, PinnedSourceFile>> {
  const expected = externalGraphExpectations[name];
  assert(
    gold.repository === expected.repository,
    name + ' repository pin changed.',
  );
  assert(gold.revision === expected.revision, name + ' revision pin changed.');
  assert(
    gold.review.toLowerCase().includes('not independently reviewed'),
    name + ' review state no longer identifies unreviewed labels.',
  );
  const byPath = new Map(files.map((file) => [file.path, file]));
  assert(byPath.size === files.length, name + ' source paths are duplicated.');
  const actualPaths = [...byPath.keys()].sort(),
    pinnedPaths = Object.keys(expected.sourceHashes).sort(),
    goldPaths = Object.keys(gold.files).sort();
  assert(
    JSON.stringify(actualPaths) === JSON.stringify(pinnedPaths) &&
      JSON.stringify(actualPaths) === JSON.stringify(goldPaths),
    name + ' source paths differ from the independent pin.',
  );
  for (const [path, hash] of Object.entries(expected.sourceHashes)) {
    const file = byPath.get(path);
    assert(file, name + ' pinned source is missing: ' + path);
    assert(
      gold.files[path] === hash,
      name + ' gold source hash changed: ' + path,
    );
    assert(
      file.sha256 === hash &&
        createHash('sha256').update(file.bytes).digest('hex') === hash,
      name + ' source bytes do not match the independent pin: ' + path,
    );
  }
  return Object.fromEntries([...byPath].map(([path, file]) => [path, file]));
}

function verifyAnchoredEvidence(
  evidence: SourceEvidence,
  anchor: AnchoredEvidence['anchor'],
  file: PinnedSourceFile,
  fileId: string,
  snapshotId: string,
  expectedText?: string,
): string {
  const source = decodeSource(file.bytes),
    offsets = rangeOffsets(source, anchor.range),
    text = source.slice(offsets.start, offsets.end);
  assert(
    evidence.snapshotId === snapshotId,
    'evidence belongs to another snapshot.',
  );
  assert(
    evidence.fileId === fileId,
    'evidence points at the wrong source file.',
  );
  assert(
    evidence.contentHash === file.sha256,
    'evidence hash differs from pinned bytes.',
  );
  assert(
    evidence.kind === 'static_source',
    'evidence kind is not static source.',
  );
  assert(
    matchesPosition(evidence.range.start, anchor.range.start) &&
      evidence.range.start.offset === offsets.start &&
      matchesPosition(evidence.range.end, anchor.range.end) &&
      evidence.range.end.offset === offsets.end,
    'evidence range differs from the pinned source anchor.',
  );
  if (expectedText !== undefined)
    assert(
      text === expectedText,
      'expected edge text differs from pinned source bytes.',
    );
  return text;
}

export function verifyGraphEvidenceRefs(
  refs: readonly SourceEvidence[],
  expected: readonly AnchoredEvidence[],
  snapshotId: string,
  label: string,
): void {
  const expectedIds = expected.map((item) => item.id),
    actualIds = refs.map((item) => item.id);
  assert(
    actualIds.length === expectedIds.length &&
      new Set(actualIds).size === expectedIds.length &&
      expectedIds.every((id) => actualIds.includes(id)),
    label + ' evidence IDs do not match the anchored source path.',
  );
  for (const item of expected) {
    const matches = refs.filter((ref) => ref.id === item.id);
    assert(
      matches.length === 1,
      label + ' omits or duplicates evidence ' + item.id + '.',
    );
    verifyAnchoredEvidence(
      matches[0]!,
      item.anchor,
      item.file,
      item.fileId,
      snapshotId,
    );
  }
}

export function verifyEvidenceItems(
  result: GetSourceEvidenceResponse,
  expected: readonly AnchoredEvidence[],
  snapshotId: string,
): void {
  const ids = result.items.map((item) =>
    item.status === 'available' ? item.evidence.id : item.evidenceId,
  );
  assert(
    JSON.stringify(ids) === JSON.stringify(expected.map((item) => item.id)),
    'source evidence IDs do not match the anchored path and declarations.',
  );
  assert(
    result.meta.snapshotId === snapshotId,
    'evidence result belongs to another snapshot.',
  );
  assert(
    result.meta.evidenceBasis === 'static',
    'source evidence is not labeled static.',
  );
  assert(
    !result.meta.truncated && result.meta.truncationReasons.length === 0,
    'evidence result is truncated.',
  );
  assert(
    result.meta.appliedLimits.evidence === 100 && result.items.length <= 100,
    'source evidence exceeded its applied bound.',
  );
  for (let index = 0; index < expected.length; index++) {
    const item = result.items[index]!,
      anchor = expected[index]!;
    assert(item.status === 'available', 'source evidence is unavailable.');
    assert(
      item.filePath === anchor.anchor.file,
      'source evidence returned the wrong path.',
    );
    const text = verifyAnchoredEvidence(
      item.evidence,
      anchor.anchor,
      anchor.file,
      anchor.fileId,
      snapshotId,
      anchor.text,
    );
    assert(item.text === text, 'source excerpt differs from pinned bytes.');
  }
}

export function expectedEvidenceForGraphResponse(
  graph: GraphEvidenceResponse,
  pinnedFiles: Readonly<Record<string, PinnedSourceFile>>,
  facts: AnalysisFacts,
  label: string,
): readonly AnchoredEvidence[] {
  const factSymbols = new Map(
      facts.symbols.map((symbol) => [symbol.id, symbol]),
    ),
    factRelations = new Map(
      facts.relations.map((relation) => [relation.id, relation]),
    ),
    factEvidence = new Map(facts.evidenceRefs.map((item) => [item.id, item])),
    factFiles = new Map(facts.files.map((file) => [file.id, file])),
    evidenceIds = new Set<string>();
  assert(
    factEvidence.size === facts.evidenceRefs.length,
    'fact evidence IDs are duplicated.',
  );
  assert(
    factFiles.size === facts.files.length,
    'fact file IDs are duplicated.',
  );
  assert(
    new Set(graph.relations.map((relation) => relation.id)).size ===
      graph.relations.length,
    label + ' contains duplicate relations.',
  );
  for (const symbol of graph.symbols) {
    const fact = factSymbols.get(symbol.id);
    assert(fact, label + ' contains a symbol absent from analysis facts.');
    assert(
      symbol.declarationEvidenceId === fact.declarationEvidenceId &&
        JSON.stringify(symbol.evidenceIds) === JSON.stringify(fact.evidenceIds),
      label + ' symbol evidence differs from analysis facts.',
    );
    for (const id of fact.evidenceIds) evidenceIds.add(id);
  }
  for (const relation of graph.relations) {
    const fact = factRelations.get(relation.id);
    assert(fact, label + ' contains a relation absent from analysis facts.');
    assert(
      relation.snapshotId === fact.snapshotId &&
        relation.key === fact.key &&
        relation.sourceSymbolId === fact.sourceSymbolId &&
        relation.kind === fact.kind &&
        relation.siteEvidenceId === fact.siteEvidenceId &&
        JSON.stringify(relation.resolution) === JSON.stringify(fact.resolution),
      label + ' relation evidence or resolution differs from analysis facts.',
    );
    evidenceIds.add(fact.siteEvidenceId);
    for (const id of fact.resolution.evidenceIds) evidenceIds.add(id);
  }
  return [...evidenceIds].sort().map((id) => {
    const evidence = factEvidence.get(id),
      file = evidence && factFiles.get(evidence.fileId),
      pinnedFile = file && pinnedFiles[file.path];
    assert(
      evidence,
      label + ' references evidence absent from analysis facts.',
    );
    assert(file, label + ' evidence references an absent source file.');
    assert(pinnedFile, label + ' evidence file is not independently pinned.');
    return {
      id,
      anchor: {
        file: file.path,
        range: {
          start: {
            line: evidence.range.start.line,
            column: evidence.range.start.column,
          },
          end: {
            line: evidence.range.end.line,
            column: evidence.range.end.column,
          },
        },
      },
      file: pinnedFile,
      fileId: evidence.fileId,
    };
  });
}

export function expectedEvidenceForGraph(
  expectation: ExternalGraphExpectation,
  pinnedFiles: Readonly<Record<string, PinnedSourceFile>>,
  facts: AnalysisFacts,
  edgeEvidenceId: string,
  rootEvidenceId: string,
  targetEvidenceId: string,
): readonly AnchoredEvidence[] {
  const factFiles = new Map(facts.files.map((file) => [file.path, file])),
    edgeFacts = factFiles.get(expectation.edge.file),
    rootFacts = factFiles.get(expectation.root.file),
    targetFacts = factFiles.get(expectation.target.file);
  assert(
    edgeFacts && rootFacts && targetFacts,
    'anchored source is absent from the analyzed manifest.',
  );
  const result = [
    {
      id: edgeEvidenceId,
      anchor: { file: expectation.edge.file, range: expectation.edge.range },
      file: pinnedFiles[expectation.edge.file]!,
      fileId: edgeFacts.id,
      text: expectation.edge.text,
    },
    {
      id: rootEvidenceId,
      anchor: { file: expectation.root.file, range: expectation.root.range },
      file: pinnedFiles[expectation.root.file]!,
      fileId: rootFacts.id,
    },
    {
      id: targetEvidenceId,
      anchor: {
        file: expectation.target.file,
        range: expectation.target.range,
      },
      file: pinnedFiles[expectation.target.file]!,
      fileId: targetFacts.id,
    },
  ];
  assert(
    new Set(result.map((item) => item.id)).size === result.length,
    'edge and declaration evidence IDs are not distinct.',
  );
  return result;
}
