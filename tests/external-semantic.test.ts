import { beforeAll, describe, expect, it } from 'vitest';
import ts from 'typescript';
import { analyzeManifest, COMPILER_PROFILE } from '@codethread/symbol-indexer';
import type { AnalysisSnapshot } from '@codethread/symbol-indexer';
import { loadExternalCorpus } from '../scripts/external-semantic-corpus.ts';
import { evaluateSemantic } from '../scripts/eval-semantic.ts';

describe.each(['tinyexec', 'todo'] as const)('external corpus: %s', (name) => {
  let corpus: Awaited<ReturnType<typeof loadExternalCorpus>>;
  let snapshot: AnalysisSnapshot;
  beforeAll(async () => {
    corpus = await loadExternalCorpus(name);
    snapshot = await analyzeManifest({
      repositoryId:
        name === 'tinyexec'
          ? '00000000-0000-4000-8000-000000000011'
          : '00000000-0000-4000-8000-000000000012',
      compilerOptions: COMPILER_PROFILE,
      files: corpus.files,
    });
  }, 15000);
  it('matches every source call span independently of the analyzer', () => {
    const remaining = new Map(
      corpus.gold.calls.map((call) => [
        JSON.stringify([call.file, call.line, call.column, call.end]),
        call,
      ]),
    );
    expect(remaining.size).toBe(corpus.gold.calls.length);
    const anchors = new Set(
      corpus.gold.declarations.map((declaration) =>
        JSON.stringify([declaration.file, declaration.start, declaration.end]),
      ),
    );
    for (const call of corpus.gold.calls) {
      if (call.target)
        expect(
          anchors.has(
            JSON.stringify([
              call.target.file,
              call.target.start,
              call.target.end,
            ]),
          ),
        ).toBe(true);
      if (call.owner)
        expect(
          anchors.has(
            JSON.stringify([call.owner.file, call.owner.start, call.owner.end]),
          ),
        ).toBe(true);
    }
    for (const file of corpus.files) {
      const sf = ts.createSourceFile(
        file.path,
        file.bytes.toString('utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      const pos = (offset: number) => {
        const p = sf.getLineAndCharacterOfPosition(offset);
        return [p.line + 1, p.character + 1];
      };
      function visit(node: ts.Node): void {
        if (ts.isCallExpression(node)) {
          const start = pos(node.getStart(sf));
          const key = JSON.stringify([
            file.path,
            start[0],
            start[1],
            pos(node.end),
          ]);
          const expected = remaining.get(key);
          expect(expected?.text).toBe(node.getText(sf));
          let parent: ts.Node | undefined = node.parent;
          while (parent && !ts.isFunctionLike(parent)) parent = parent.parent;
          const owner =
            parent && ts.isFunctionDeclaration(parent) && parent.name
              ? {
                  file: file.path,
                  start: pos(parent.getStart(sf)),
                  end: pos(parent.end),
                }
              : null;
          expect(expected?.owner).toEqual(owner);
          expect(remaining.delete(key)).toBe(true);
        }
        ts.forEachChild(node, visit);
      }
      visit(sf);
    }
    expect(remaining.size).toBe(0);
  });
  it('evaluates every occurrence including nested calls with identical starts', () => {
    const report = evaluateSemantic(corpus.gold, snapshot);
    expect(report.gate.failures).toEqual([]);
    expect(report.counts.missingGoldOccurrences).toBe(0);
    expect(report.counts.unannotatedOccurrences).toBe(0);
    expect(report.gate.passed).toBe(true);
  });
});
