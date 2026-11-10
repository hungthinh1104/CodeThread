import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeManifest, COMPILER_PROFILE } from '@codethread/symbol-indexer';
import type { AnalysisSnapshot } from '@codethread/symbol-indexer';
import { loadSemanticCorpus } from '../scripts/semantic-corpus.ts';
import type { SemanticGold } from '../scripts/semantic-corpus.ts';
import { evaluateSemantic } from '../scripts/eval-semantic.ts';

let snapshot: AnalysisSnapshot, gold: SemanticGold;
beforeAll(async () => {
  const corpus = await loadSemanticCorpus();
  gold = corpus.gold;
  snapshot = await analyzeManifest({
    repositoryId: '00000000-0000-4000-8000-000000000001',
    compilerOptions: COMPILER_PROFILE,
    files: corpus.files,
  });
}, 15000);

describe('CT-INDEX-001A semantic quality accounting', () => {
  it('reports fixture counts and explicit precision, recall and unresolved denominators', () => {
    const report = evaluateSemantic(gold, snapshot);
    expect(report.counts).toMatchObject({
      eligibleSupportedCallOccurrences: 17,
      correctExactResolutions: 13,
      incorrectExactResolutions: 0,
      missedResolvableOccurrences: 0,
      unresolvedOccurrences: 3,
      ambiguousOccurrences: 1,
      unsupportedOccurrences: 13,
      notAnalyzedInputs: 0,
      sourceEvidenceMismatches: 0,
    });
    expect(report.precision).toEqual({
      numerator: 13,
      denominator: 13,
      value: 1,
    });
    expect(report.recall).toEqual({ numerator: 13, denominator: 13, value: 1 });
    expect(report.supportedCoverage).toEqual({
      numerator: 17,
      denominator: 30,
      value: 17 / 30,
    });
    expect(report.exactCoverage).toEqual({
      numerator: 13,
      denominator: 30,
      value: 13 / 30,
    });
    expect(report.unresolvedRate).toEqual({
      numerator: 4,
      denominator: 17,
      value: 4 / 17,
    });
    expect(report.gate.passed).toBe(true);
  });
  it('reduces observed coverage when an eligible call is emitted as unsupported', () => {
    const facts = structuredClone(snapshot.facts);
    const observation = facts.observations.find((item) => item.eligible)!;
    observation.status = 'unsupported';
    const report = evaluateSemantic(gold, { facts, source: snapshot.source });
    expect(report.supportedCoverage).toEqual({
      numerator: 16,
      denominator: 30,
      value: 16 / 30,
    });
    expect(report.exactCoverage).toEqual({
      numerator: 12,
      denominator: 30,
      value: 12 / 30,
    });
    expect(report.gate.passed).toBe(false);
  });
  it('counts a wrong exact target as both an incorrect prediction and a missed gold relation', () => {
    const facts = structuredClone(snapshot.facts);
    const relation = facts.relations.find(
      (item) =>
        item.resolution.status === 'exact' &&
        facts.symbols.find((symbol) => symbol.id === item.sourceSymbolId)
          ?.name === 'start',
    )!;
    const incorrect = facts.symbols.find(
      (item) => item.filePath === 'c.ts' && item.name === 'end',
    )!;
    if (relation.resolution.status !== 'exact')
      throw new Error('fixture relation is not exact');
    relation.resolution.targetId = incorrect.id;
    const report = evaluateSemantic(gold, { facts, source: snapshot.source });
    expect(report.counts).toMatchObject({
      correctExactResolutions: 12,
      incorrectExactResolutions: 1,
      missedResolvableOccurrences: 1,
    });
    expect(report.gate.passed).toBe(false);
  });
  it('reports empty denominators as unavailable', () => {
    const facts = { ...snapshot.facts, observations: [], relations: [] };
    const report = evaluateSemantic(
      { ...gold, calls: [] },
      { facts, source: snapshot.source },
    );
    expect(report.precision.value).toBeNull();
    expect(report.recall.value).toBeNull();
    expect(report.supportedCoverage.value).toBeNull();
    expect(report.exactCoverage.value).toBeNull();
    expect(report.unresolvedRate.value).toBeNull();
  });
  it('does not hide an unlocatable extra occurrence from unannotated counts', () => {
    const extra = {
      ...snapshot.facts.observations[0]!,
      fileId: '00000000-0000-4000-8000-000000000099',
      status: 'unsupported' as const,
      eligible: false,
      ownerId: null,
      relationId: null,
      diagnosticId: null,
    };
    const facts = {
      ...snapshot.facts,
      observations: [...snapshot.facts.observations, extra],
    };
    const report = evaluateSemantic(gold, { facts, source: snapshot.source });
    expect(report.counts.unannotatedOccurrences).toBe(1);
    expect(report.counts.unsupportedOccurrences).toBe(14);
    expect(report.gate.passed).toBe(false);
  });
});

describe('same-name declarations in different lexical scopes', () => {
  const path = 'same-name.ts';
  const text = [
    'function target() {}',
    'function outer() {',
    '  function target() {}',
    '  function owner() {',
    '    target();',
    '    function owner() {}',
    '  }',
    '}',
    '',
  ].join('\n');
  const fixtureGold: SemanticGold = {
    authorship: 'manually authored regression',
    review: 'not independently reviewed',
    files: {
      [path]:
        '89c558ee097e94988e8a54610fce258c0ff53b77a014d1b130e05368c785f06f',
    },
    declarations: [
      { file: path, name: 'target', start: [1, 1], end: [1, 21] },
      { file: path, name: 'outer', start: [2, 1], end: [8, 2] },
      { file: path, name: 'target', start: [3, 3], end: [3, 23] },
      { file: path, name: 'owner', start: [4, 3], end: [7, 4] },
      { file: path, name: 'owner', start: [6, 5], end: [6, 24] },
    ],
    calls: [
      {
        file: path,
        line: 5,
        column: 5,
        text: 'target()',
        owner: { file: path, start: [4, 3], end: [7, 4] },
        status: 'exact',
        target: { file: path, start: [3, 3], end: [3, 23] },
        eligible: true,
      },
    ],
  };
  let fixture: AnalysisSnapshot;
  beforeAll(async () => {
    fixture = await analyzeManifest({
      repositoryId: '00000000-0000-4000-8000-000000000001',
      compilerOptions: COMPILER_PROFILE,
      files: [
        {
          path,
          bytes: new TextEncoder().encode(text),
          sha256: fixtureGold.files[path]!,
        },
      ],
    });
    expect(evaluateSemantic(fixtureGold, fixture).gate.passed).toBe(true);
  }, 15000);

  it('rejects the wrong same-name target declaration', () => {
    const facts = structuredClone(fixture.facts);
    const wrong = facts.symbols.find(
      (symbol) => symbol.name === 'target' && symbol.range.start.line === 1,
    )!;
    const relation = facts.relations[0]!;
    if (relation.resolution.status !== 'exact')
      throw new Error('expected exact fixture relation');
    relation.resolution.targetId = wrong.id;
    relation.resolution.evidenceIds.push(wrong.declarationEvidenceId);
    const report = evaluateSemantic(fixtureGold, {
      facts,
      source: fixture.source,
    });
    expect(report.counts).toMatchObject({
      correctExactResolutions: 0,
      incorrectExactResolutions: 1,
      missedResolvableOccurrences: 1,
    });
    expect(report.gate.passed).toBe(false);
  });
  it('rejects the wrong same-name owner declaration', () => {
    const facts = structuredClone(fixture.facts);
    const wrong = facts.symbols.find(
      (symbol) => symbol.name === 'owner' && symbol.range.start.line === 6,
    )!;
    const relation = facts.relations[0]!;
    if (relation.resolution.status !== 'exact')
      throw new Error('expected exact fixture relation');
    facts.observations[0]!.ownerId = wrong.id;
    relation.sourceSymbolId = wrong.id;
    relation.resolution.evidenceIds.push(wrong.declarationEvidenceId);
    const report = evaluateSemantic(fixtureGold, {
      facts,
      source: fixture.source,
    });
    expect(report.counts).toMatchObject({
      correctExactResolutions: 0,
      incorrectExactResolutions: 1,
      missedResolvableOccurrences: 1,
    });
    expect(report.gate.passed).toBe(false);
  });
  it('rejects an edge owner that disagrees with the observation owner', () => {
    const facts = structuredClone(fixture.facts);
    const wrong = facts.symbols.find(
      (symbol) => symbol.name === 'owner' && symbol.range.start.line === 6,
    )!;
    const relation = facts.relations[0]!;
    if (relation.resolution.status !== 'exact')
      throw new Error('expected exact fixture relation');
    relation.sourceSymbolId = wrong.id;
    relation.resolution.evidenceIds.push(wrong.declarationEvidenceId);
    const report = evaluateSemantic(fixtureGold, {
      facts,
      source: fixture.source,
    });
    expect(report.gate.passed).toBe(false);
  });
  it.each(['owner', 'target'] as const)(
    'rejects a %s anchor with the correct start but wrong end',
    (field) => {
      const changed = structuredClone(fixtureGold);
      changed.calls[0]![field]!.end[1]--;
      const report = evaluateSemantic(changed, fixture);
      expect(report.counts).toMatchObject({
        correctExactResolutions: 0,
        incorrectExactResolutions: 1,
        missedResolvableOccurrences: 1,
      });
      expect(report.gate.passed).toBe(false);
    },
  );
});

describe('source-anchored method-owned call evaluation', () => {
  const path = 'method-owner.ts';
  const text = [
    'class Worker {',
    '  run() {',
    '    helper();',
    '  }',
    '  fallback() {',
    '  }',
    '}',
    'function helper() {}',
    'function decoy() {}',
    '',
  ].join('\n');
  const gold: SemanticGold = {
    authorship: 'manually authored regression',
    review: 'not independently reviewed',
    files: {
      [path]:
        'bebd1f08de767845cdf66f1ea3367226152ae742c3a8aad0a4e7b6857cafa923',
    },
    declarations: [
      {
        file: path,
        name: 'run',
        kind: 'method',
        start: [2, 3],
        end: [4, 4],
      },
      {
        file: path,
        name: 'fallback',
        kind: 'method',
        start: [5, 3],
        end: [6, 4],
      },
      {
        file: path,
        name: 'helper',
        kind: 'function',
        start: [8, 1],
        end: [8, 21],
      },
      {
        file: path,
        name: 'decoy',
        kind: 'function',
        start: [9, 1],
        end: [9, 20],
      },
    ],
    calls: [
      {
        file: path,
        line: 3,
        column: 5,
        text: 'helper()',
        owner: { file: path, start: [2, 3], end: [4, 4] },
        status: 'exact',
        target: { file: path, start: [8, 1], end: [8, 21] },
        eligible: true,
      },
    ],
  };
  let fixture: AnalysisSnapshot;

  beforeAll(async () => {
    const bytes = new TextEncoder().encode(text);
    fixture = await analyzeManifest({
      repositoryId: '00000000-0000-4000-8000-000000000001',
      compilerOptions: COMPILER_PROFILE,
      files: [
        {
          path,
          bytes,
          sha256: gold.files[path]!,
        },
      ],
    });
  }, 15000);

  it('accepts the independently anchored method owner, call and function target', () => {
    const report = evaluateSemantic(gold, fixture);
    expect(report.counts).toMatchObject({
      correctExactResolutions: 1,
      incorrectExactResolutions: 0,
      missedResolvableOccurrences: 0,
      sourceEvidenceMismatches: 0,
    });
    expect(report.gate.passed).toBe(true);
  });

  it('rejects a wrong exact target even when its declaration evidence is added', () => {
    const facts = structuredClone(fixture.facts);
    const relation = facts.relations[0]!;
    const wrong = facts.symbols.find((symbol) => symbol.name === 'decoy')!;
    if (relation.resolution.status !== 'exact')
      throw new Error('expected exact fixture relation');
    relation.resolution.targetId = wrong.id;
    relation.resolution.evidenceIds.push(wrong.declarationEvidenceId);
    const report = evaluateSemantic(gold, { facts, source: fixture.source });
    expect(report.counts).toMatchObject({
      correctExactResolutions: 0,
      incorrectExactResolutions: 1,
      missedResolvableOccurrences: 1,
    });
    expect(report.gate.passed).toBe(false);
  });

  it('rejects a different method as the call owner', () => {
    const facts = structuredClone(fixture.facts);
    const relation = facts.relations[0]!;
    const wrong = facts.symbols.find((symbol) => symbol.name === 'fallback')!;
    if (relation.resolution.status !== 'exact')
      throw new Error('expected exact fixture relation');
    facts.observations[0]!.ownerId = wrong.id;
    relation.sourceSymbolId = wrong.id;
    relation.resolution.evidenceIds.push(wrong.declarationEvidenceId);
    const report = evaluateSemantic(gold, { facts, source: fixture.source });
    expect(report.gate.failures).toHaveLength(1);
    expect(report.gate.passed).toBe(false);
  });

  it('rejects an exact edge missing its target declaration evidence', () => {
    const facts = structuredClone(fixture.facts);
    const relation = facts.relations[0]!;
    const target = facts.symbols.find((symbol) => symbol.name === 'helper')!;
    if (relation.resolution.status !== 'exact')
      throw new Error('expected exact fixture relation');
    relation.resolution.evidenceIds = relation.resolution.evidenceIds.filter(
      (id) => id !== target.declarationEvidenceId,
    );
    const report = evaluateSemantic(gold, { facts, source: fixture.source });
    expect(report.counts.sourceEvidenceMismatches).toBe(1);
    expect(report.gate.passed).toBe(false);
  });
});
