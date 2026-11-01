import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { analyzeManifest, COMPILER_PROFILE } from '@codethread/symbol-indexer';
import type { AnalysisSnapshot } from '@codethread/symbol-indexer';
import type { AnalysisInput } from '@codethread/symbol-indexer';
import type { CodeSymbol, SourceRange } from '@codethread/code-model';
import { loadSemanticCorpus } from './semantic-corpus.ts';
import type { GoldAnchor, SemanticGold } from './semantic-corpus.ts';

const rate = (numerator: number, denominator: number) => ({
  numerator,
  denominator,
  value: denominator ? numerator / denominator : null,
});
const location = (path: string, line: number, column: number) =>
  JSON.stringify([path, line, column]);
const anchorKey = (anchor: GoldAnchor) =>
  JSON.stringify([anchor.file, anchor.start, anchor.end]);
const anchorLabel = (anchor: GoldAnchor) =>
  `${anchor.file}:${anchor.start[0]}:${anchor.start[1]}-${anchor.end[0]}:${anchor.end[1]}`;
const symbolAnchor = (symbol: CodeSymbol): GoldAnchor => ({
  file: symbol.filePath,
  start: [symbol.range.start.line, symbol.range.start.column],
  end: [symbol.range.end.line, symbol.range.end.column],
});
const sameRange = (left: SourceRange, right: SourceRange) =>
  (['start', 'end'] as const).every((edge) =>
    (['offset', 'line', 'column'] as const).every(
      (part) => left[edge][part] === right[edge][part],
    ),
  );

/** Compare predictions to manually authored labels; never derive labels from the analyzer. */
export function evaluateSemantic(
  gold: SemanticGold,
  snapshot: AnalysisSnapshot,
) {
  const { facts, source } = snapshot;
  const files = new Map(facts.files.map((file) => [file.id, file]));
  const evidence = new Map(facts.evidenceRefs.map((item) => [item.id, item]));
  const symbols = new Map(facts.symbols.map((item) => [item.id, item]));
  const relations = new Map(facts.relations.map((item) => [item.id, item]));
  const diagnostics = new Map(facts.diagnostics.map((item) => [item.id, item]));
  const goldDeclarations = new Map<
    string,
    (typeof gold.declarations)[number]
  >();
  for (const declaration of gold.declarations)
    goldDeclarations.set(anchorKey(declaration), declaration);
  function matchesDeclaration(
    symbol: CodeSymbol | undefined,
    anchor: GoldAnchor,
  ): boolean {
    const expected = goldDeclarations.get(anchorKey(anchor));
    if (
      !symbol ||
      !expected ||
      !gold.files[anchor.file] ||
      anchorKey(symbolAnchor(symbol)) !== anchorKey(anchor) ||
      symbol.name !== expected.name ||
      symbol.snapshotId !== facts.snapshotId
    )
      return false;
    const file = files.get(symbol.fileId),
      primary = source.readEvidence(symbol.declarationEvidenceId);
    return (
      !!file &&
      file.path === anchor.file &&
      file.contentHash === gold.files[anchor.file] &&
      primary.status === 'available' &&
      primary.filePath === anchor.file &&
      primary.evidence.id === symbol.declarationEvidenceId &&
      primary.evidence.fileId === symbol.fileId &&
      primary.evidence.snapshotId === facts.snapshotId &&
      primary.evidence.contentHash === gold.files[anchor.file] &&
      sameRange(primary.evidence.range, symbol.range)
    );
  }
  const predicted = new Map<string, (typeof facts.observations)[number][]>();
  let unlocatable = 0;
  for (const observation of facts.observations) {
    const span = evidence.get(observation.evidenceId),
      file = files.get(observation.fileId);
    if (!span || !file) {
      unlocatable++;
      continue;
    }
    const key = location(
      file.path,
      span.range.start.line,
      span.range.start.column,
    );
    const rows = predicted.get(key);
    if (rows) rows.push(observation);
    else predicted.set(key, [observation]);
  }
  const expectedLocations = new Set(
    gold.calls.map((call) => location(call.file, call.line, call.column)),
  );
  const exactPredictions = facts.observations.filter(
    (item) => item.status === 'exact',
  ).length;
  let correct = 0,
    evidenceMismatches = 0,
    analyzedSupported = 0,
    unresolvedSupported = 0,
    missing = 0;
  const failures: string[] = [];
  const correctExamples: { site: string; target: string }[] = [];
  const incorrectExamples: {
    site: string;
    expected: string | null;
    actual: string | null;
  }[] = [];
  for (const expected of gold.calls) {
    const key = location(expected.file, expected.line, expected.column),
      rows = predicted.get(key) ?? [];
    if (rows.length !== 1) {
      missing++;
      failures.push(
        `${expected.file}:${expected.line}:${expected.column}: expected one occurrence, found ${rows.length}`,
      );
      continue;
    }
    const observation = rows[0]!,
      span = evidence.get(observation.evidenceId)!;
    const owner = observation.ownerId
      ? symbols.get(observation.ownerId)
      : undefined;
    const relation = observation.relationId
      ? relations.get(observation.relationId)
      : undefined;
    const target =
      relation?.resolution.status === 'exact'
        ? symbols.get(relation.resolution.targetId)
        : undefined;
    const actualTarget = target ? anchorLabel(symbolAnchor(target)) : null;
    const diagnostic = observation.diagnosticId
      ? diagnostics.get(observation.diagnosticId)
      : undefined;
    const excerpt = source.readEvidence(observation.evidenceId);
    let evidenceValid =
      excerpt.status === 'available' &&
      excerpt.filePath === expected.file &&
      excerpt.text === expected.text &&
      excerpt.evidence.contentHash === gold.files[expected.file] &&
      excerpt.evidence.id === span.id &&
      excerpt.evidence.fileId === observation.fileId &&
      excerpt.evidence.snapshotId === facts.snapshotId &&
      sameRange(excerpt.evidence.range, span.range) &&
      span.range.start.line === expected.line &&
      span.range.start.column === expected.column;
    if (relation?.resolution.status === 'exact') {
      evidenceValid =
        evidenceValid &&
        !!owner &&
        !!target &&
        relation.resolution.evidenceIds.includes(owner.declarationEvidenceId) &&
        relation.resolution.evidenceIds.includes(
          target.declarationEvidenceId,
        ) &&
        relation.resolution.evidenceIds.every(
          (id) => source.readEvidence(id).status === 'available',
        );
    }
    if (!evidenceValid) evidenceMismatches++;
    if (expected.eligible) {
      analyzedSupported++;
      if (
        observation.status === 'unresolved' ||
        observation.status === 'ambiguous'
      )
        unresolvedSupported++;
    }
    const ownerMatches =
      expected.owner === null
        ? observation.ownerId === null
        : matchesDeclaration(owner, expected.owner);
    const targetMatches = expected.target
      ? matchesDeclaration(target, expected.target)
      : !relation || relation.resolution.targetId === null;
    const relationMatches =
      expected.owner === null
        ? observation.relationId === null
        : !!relation &&
          relation.sourceSymbolId === observation.ownerId &&
          relation.siteEvidenceId === observation.evidenceId &&
          relation.resolution.status === observation.status &&
          (relation.resolution.status === 'exact' ||
            (!!observation.diagnosticId &&
              relation.resolution.diagnosticIds.includes(
                observation.diagnosticId,
              )));
    const matches =
      observation.status === expected.status &&
      observation.eligible === expected.eligible &&
      ownerMatches &&
      targetMatches &&
      relationMatches &&
      (expected.diagnostic
        ? !!observation.diagnosticId && diagnostic?.code === expected.diagnostic
        : observation.diagnosticId === null && !diagnostic) &&
      evidenceValid;
    if (!matches)
      failures.push(
        `${expected.file}:${expected.line}:${expected.column}: expected ${expected.status}, owner ${expected.owner ? anchorLabel(expected.owner) : 'none'}, target ${expected.target ? anchorLabel(expected.target) : 'none'}; observed ${observation.status}, owner ${owner ? anchorLabel(symbolAnchor(owner)) : 'none'}, target ${actualTarget ?? 'none'}`,
      );
    if (observation.status === 'exact') {
      if (expected.status === 'exact' && matches) {
        correct++;
        if (correctExamples.length < 3)
          correctExamples.push({
            site: `${expected.file}:${expected.line}:${expected.column}`,
            target: actualTarget!,
          });
      } else
        incorrectExamples.push({
          site: `${expected.file}:${expected.line}:${expected.column}`,
          expected: expected.target ? anchorLabel(expected.target) : null,
          actual: actualTarget,
        });
    }
  }
  const unannotated = [...predicted].reduce(
    (count, [key, rows]) =>
      count +
      (expectedLocations.has(key) ? Math.max(0, rows.length - 1) : rows.length),
    unlocatable,
  );
  const expectedDeclarations = new Set(
    gold.declarations.map((item) =>
      JSON.stringify([item.file, item.name, item.start, item.end]),
    ),
  );
  const actualDeclarations = facts.symbols.map((item) =>
    JSON.stringify([
      item.filePath,
      item.name,
      [item.range.start.line, item.range.start.column],
      [item.range.end.line, item.range.end.column],
    ]),
  );
  const declarationMatch =
    goldDeclarations.size === gold.declarations.length &&
    expectedDeclarations.size === gold.declarations.length &&
    new Set(actualDeclarations).size === gold.declarations.length &&
    actualDeclarations.every((item) => expectedDeclarations.has(item));
  const eligibleSupportedCallOccurrences = gold.calls.filter(
    (item) => item.eligible,
  ).length;
  const resolvable = gold.calls.filter(
    (item) => item.eligible && item.status === 'exact',
  ).length;
  const counts = {
    eligibleSupportedCallOccurrences,
    correctExactResolutions: correct,
    incorrectExactResolutions: exactPredictions - correct,
    missedResolvableOccurrences: resolvable - correct,
    unresolvedOccurrences: facts.observations.filter(
      (item) => item.status === 'unresolved',
    ).length,
    ambiguousOccurrences: facts.observations.filter(
      (item) => item.status === 'ambiguous',
    ).length,
    unsupportedOccurrences: facts.observations.filter(
      (item) => item.status === 'unsupported',
    ).length,
    notAnalyzedInputs: facts.counts.notAnalyzedInputs,
    sourceEvidenceMismatches: evidenceMismatches,
    missingGoldOccurrences: missing,
    unannotatedOccurrences: unannotated,
  };
  const passed =
    declarationMatch &&
    failures.length === 0 &&
    counts.incorrectExactResolutions === 0 &&
    counts.missedResolvableOccurrences === 0 &&
    !missing &&
    !unannotated &&
    !evidenceMismatches &&
    facts.counts.notAnalyzedInputs === 0;
  return {
    corpus: {
      authorship: gold.authorship,
      review: gold.review,
      files: Object.keys(gold.files).length,
      goldDeclarations: gold.declarations.length,
      goldCalls: gold.calls.length,
    },
    extracted: {
      declarations: facts.symbols.length,
      relations: facts.relations.length,
      callSites: facts.observations.length,
    },
    counts,
    precision: rate(correct, exactPredictions),
    recall: rate(correct, resolvable),
    unresolvedRate: rate(unresolvedSupported, analyzedSupported),
    gate: { passed, declarationMatch, failures },
    examples: { correct: correctExamples, incorrect: incorrectExamples },
  };
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const { gold, files } = await loadSemanticCorpus();
  const snapshot = await analyzeManifest({
    repositoryId: '00000000-0000-4000-8000-000000000001',
    compilerOptions: COMPILER_PROFILE,
    files,
  });
  const report = evaluateSemantic(gold, snapshot);
  const source = (path: string, bytes: Uint8Array) => ({
    path,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  const valid = new TextEncoder().encode('export const value = 1;');
  const invalid = new Uint8Array([0xc3, 0x28]);
  const malformed = new TextEncoder().encode('export function broken( {');
  const heavy = new TextEncoder().encode(
    Array.from(
      { length: 1000 },
      (_, index) => `export function f${index}() {}\n`,
    ).join(''),
  );
  const base = {
    repositoryId: '00000000-0000-4000-8000-000000000001',
    compilerOptions: COMPILER_PROFILE,
  };
  const cases: { name: string; input: AnalysisInput; expected: string }[] = [
    {
      name: 'unsafe path',
      input: { ...base, files: [source('../escape.ts', valid)] },
      expected: 'INVALID_MANIFEST',
    },
    {
      name: 'wrong source hash',
      input: {
        ...base,
        files: [{ ...source('source.ts', valid), sha256: '0'.repeat(64) }],
      },
      expected: 'HASH_MISMATCH',
    },
    {
      name: 'invalid UTF-8',
      input: { ...base, files: [source('source.ts', invalid)] },
      expected: 'INVALID_ENCODING',
    },
    {
      name: 'source byte limit',
      input: { ...base, files: [source('large.ts', new Uint8Array(262145))] },
      expected: 'RESOURCE_LIMIT',
    },
    {
      name: 'malformed source',
      input: { ...base, files: [source('source.ts', malformed)] },
      expected: 'MALFORMED_SOURCE',
    },
    {
      name: 'deadline',
      input: { ...base, deadlineMs: 1, files: [source('source.ts', valid)] },
      expected: 'ANALYSIS_TIMEOUT',
    },
    {
      name: 'heap exhaustion',
      input: { ...base, heapLimitMiB: 16, files: [source('source.ts', heavy)] },
      expected: 'RESOURCE_LIMIT',
    },
  ];
  const rejections = [];
  for (const item of cases) {
    let actual = 'ACCEPTED';
    try {
      await analyzeManifest(item.input);
    } catch (error) {
      actual =
        error &&
        typeof error === 'object' &&
        'code' in error &&
        typeof error.code === 'string'
          ? error.code
          : 'UNCLASSIFIED_ERROR';
    }
    rejections.push({
      name: item.name,
      expected: item.expected,
      actual,
      passed: actual === item.expected,
    });
  }
  const passed = report.gate.passed && rejections.every((item) => item.passed);
  process.stdout.write(
    JSON.stringify(
      {
        ...report,
        gate: { ...report.gate, passed },
        inputRejections: {
          excludedFromSemanticMetrics: true,
          cases: rejections,
        },
      },
      null,
      2,
    ) + '\n',
  );
  if (!passed) process.exitCode = 1;
}
