import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeManifest, COMPILER_PROFILE } from '@codethread/symbol-indexer';
import type { AnalysisSnapshot } from '@codethread/symbol-indexer';
import { loadSemanticCorpus } from '../scripts/semantic-corpus.ts';
import type { SemanticGold } from '../scripts/semantic-corpus.ts';
import { semanticFingerprint } from '../scripts/semantic-fingerprint.ts';

const gold = JSON.parse(
  readFileSync(resolve('fixtures/semantic/gold.json'), 'utf8'),
) as SemanticGold;
let snapshot: AnalysisSnapshot;

beforeAll(async () => {
  const { files } = await loadSemanticCorpus();
  snapshot = await analyzeManifest({
    repositoryId: '00000000-0000-4000-8000-000000000001',
    compilerOptions: COMPILER_PROFILE,
    files,
  });
}, 15000);

describe('CT-INDEX-001A source-pinned semantic gold', () => {
  it('matches the pinned canonical-output fingerprint across platforms', () => {
    const expected = JSON.parse(
      readFileSync(resolve('fixtures/semantic/determinism.json'), 'utf8'),
    ) as { sha256: string };
    expect(semanticFingerprint(snapshot.facts)).toBe(expected.sha256);
  });
  it('matches manually annotated function declaration spans', () => {
    const declarations = snapshot.facts.symbols.map((symbol) => ({
      file: symbol.filePath,
      name: symbol.name,
      start: [symbol.range.start.line, symbol.range.start.column],
      end: [symbol.range.end.line, symbol.range.end.column],
    }));
    expect(declarations).toHaveLength(gold.declarations.length);
    expect(declarations).toEqual(expect.arrayContaining(gold.declarations));
  });
  it.each(gold.calls)('$file:$line:$column $text -> $status', (expected) => {
    const file = snapshot.facts.files.find(
      (item) => item.path === expected.file,
    )!;
    const observation = snapshot.facts.observations.find((item) => {
      const evidence = snapshot.facts.evidenceRefs.find(
        (entry) => entry.id === item.evidenceId,
      );
      return (
        item.fileId === file.id &&
        evidence?.range.start.line === expected.line &&
        evidence.range.start.column === expected.column
      );
    });
    expect(observation, 'missing call occurrence').toBeDefined();
    expect(observation!.status).toBe(expected.status);
    expect(observation!.eligible).toBe(expected.eligible);
    const owner = snapshot.facts.symbols.find(
      (symbol) => symbol.id === observation!.ownerId,
    );
    expect(owner?.name ?? null).toBe(expected.owner);
    const evidence = snapshot.source.readEvidence(observation!.evidenceId);
    expect(evidence).toMatchObject({
      status: 'available',
      filePath: expected.file,
      text: expected.text,
    });
    if (expected.target) {
      const relation = snapshot.facts.relations.find(
        (item) => item.id === observation!.relationId,
      )!;
      expect(relation.resolution.status).toBe('exact');
      const target = snapshot.facts.symbols.find(
        (symbol) => symbol.id === relation.resolution.targetId,
      )!;
      expect(`${target.filePath}:${target.name}`).toBe(expected.target);
    } else {
      const diagnostic = snapshot.facts.diagnostics.find(
        (item) => item.id === observation!.diagnosticId,
      );
      expect(diagnostic?.code).toBe(expected.diagnostic);
      if (observation!.relationId)
        expect(
          snapshot.facts.relations.find(
            (item) => item.id === observation!.relationId,
          )?.resolution.targetId,
        ).toBeNull();
    }
  });
  it('does not emit unannotated calls', () => {
    expect(snapshot.facts.observations).toHaveLength(gold.calls.length);
  });
});
