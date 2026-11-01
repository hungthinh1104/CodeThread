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
    expect(report.unresolvedRate).toEqual({
      numerator: 4,
      denominator: 17,
      value: 4 / 17,
    });
    expect(report.gate.passed).toBe(true);
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
    expect(report.unresolvedRate.value).toBeNull();
  });
});
