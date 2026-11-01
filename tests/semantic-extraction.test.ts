import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { analyzeManifest, COMPILER_PROFILE } from '@codethread/symbol-indexer';

const repositoryId = '00000000-0000-4000-8000-000000000001';
const sourceFile = (path: string, text: string) => {
  const bytes = new TextEncoder().encode(text);
  return {
    path,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
};

describe('CT-INDEX-001A semantic extraction', () => {
  it('discloses narrow function/call capability separately from broad graph coverage', async () => {
    const result = await analyzeManifest({
      repositoryId,
      compilerOptions: COMPILER_PROFILE,
      files: [sourceFile('source.ts', 'export function f() { f(); }')],
    });
    expect(result.facts.coverageByCapability).toMatchObject({
      'declarations.v1': 'partial',
      'relationships.v1': 'partial',
      'named_functions.v1': 'complete',
      'direct_calls.v1': 'complete',
      'test_behavior.v1': 'not_analyzed',
    });
  }, 15000);
  it('does not resolve installed packages or sources outside the manifest', async () => {
    const source =
      "import { createProgram } from 'typescript'; import { outside } from '../outside.js'; export function run() { createProgram(); outside(); }";
    const result = await analyzeManifest({
      repositoryId,
      compilerOptions: COMPILER_PROFILE,
      files: [sourceFile('source.ts', source)],
    });
    expect(result.facts.files).toHaveLength(1);
    expect(result.facts.observations.map((entry) => entry.status)).toEqual([
      'unsupported',
      'unresolved',
    ]);
    expect(
      result.facts.relations.every(
        (relation) => relation.resolution.targetId === null,
      ),
    ).toBe(true);
    expect(
      result.facts.diagnostics.some((item) => item.code === 'TS_2307'),
    ).toBe(true);
  }, 15000);
  it('produces identical facts for reordered equivalent manifests', async () => {
    const files = [
      sourceFile(
        'a.ts',
        "import { b } from './b.js'; export function a() { b(); }",
      ),
      sourceFile('b.ts', 'export function b() {}'),
    ];
    const first = await analyzeManifest({
      repositoryId,
      compilerOptions: COMPILER_PROFILE,
      files,
    });
    const second = await analyzeManifest({
      repositoryId,
      compilerOptions: COMPILER_PROFILE,
      files: [...files].reverse(),
    });
    expect(second.facts).toEqual(first.facts);
  }, 15000);
  it.each([
    [
      'declarations',
      Array.from(
        { length: 2001 },
        (_, index) => `function f${index}() {}\n`,
      ).join(''),
    ],
    ['call sites', `function f() { ${'f();'.repeat(5001)} }`],
  ])(
    'stops when the %s limit is exceeded',
    async (_label, source) => {
      await expect(
        analyzeManifest({
          repositoryId,
          compilerOptions: COMPILER_PROFILE,
          files: [sourceFile('source.ts', source)],
        }),
      ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
    },
    15000,
  );
  it('withholds exact targets affected by a compiler error and exposes the error', async () => {
    const source =
      "function target() { const value: number = 'wrong'; } function caller() { target(); }";
    const result = await analyzeManifest({
      repositoryId,
      compilerOptions: COMPILER_PROFILE,
      files: [sourceFile('source.ts', source)],
    });
    expect(result.facts.observations[0]?.status).toBe('unresolved');
    expect(result.facts.relations[0]?.resolution.targetId).toBeNull();
    expect(result.facts.diagnostics.map((item) => item.code)).toContain(
      'TS_2322',
    );
    expect(result.facts.coverageByCapability['relationships.v1']).toBe(
      'partial',
    );
  }, 15000);
  it.each([
    ['type-only local symbol', 'interface A {} function run() { A(); }'],
    ['optional invocation', 'function a() {} function run() { a?.(); }'],
    [
      'function expression target',
      'const a = () => {}; function run() { a(); }',
    ],
    ['default import', "import a from './b.js'; function run() { a(); }"],
  ])(
    'keeps %s outside exact resolution',
    async (_label, source) => {
      const result = await analyzeManifest({
        repositoryId,
        compilerOptions: COMPILER_PROFILE,
        files: [
          sourceFile('a.ts', source),
          sourceFile('b.ts', 'export default function a() {}'),
        ],
      });
      expect(result.facts.observations).toHaveLength(1);
      expect(result.facts.observations[0]?.status).toBe('unsupported');
      expect(result.facts.relations[0]?.resolution.targetId).toBeNull();
    },
    15000,
  );
  it('resolves named import aliases and preserves repeated call occurrences', async () => {
    const result = await analyzeManifest({
      repositoryId,
      compilerOptions: COMPILER_PROFILE,
      files: [
        sourceFile(
          'a.ts',
          "import { work as run } from './b.js'; export function root() { run(); run(); }",
        ),
        sourceFile('b.ts', 'export function work() {}'),
      ],
    });
    const root = result.facts.symbols.find((symbol) => symbol.name === 'root')!;
    const target = result.facts.symbols.find(
      (symbol) => symbol.name === 'work',
    )!;
    const relations = result.facts.relations.filter(
      (relation) => relation.sourceSymbolId === root.id,
    );
    expect(relations).toHaveLength(2);
    expect(new Set(relations.map((relation) => relation.key)).size).toBe(2);
    expect(relations.map((relation) => relation.resolution)).toEqual([
      expect.objectContaining({ status: 'exact', targetId: target.id }),
      expect.objectContaining({ status: 'exact', targetId: target.id }),
    ]);
    expect(relations[0]?.siteEvidenceId).not.toBe(relations[1]?.siteEvidenceId);
  }, 15000);
  it('resolves a recursive function call and opens its exact source evidence', async () => {
    const result = await analyzeManifest({
      repositoryId,
      compilerOptions: COMPILER_PROFILE,
      files: [
        sourceFile('source.ts', 'export function recurse() { recurse(); }\n'),
      ],
    });
    expect(result.facts.symbols).toHaveLength(1);
    expect(result.facts.relations).toHaveLength(1);
    const symbol = result.facts.symbols[0]!;
    const relation = result.facts.relations[0]!;
    expect(relation.sourceSymbolId).toBe(symbol.id);
    expect(relation.resolution).toMatchObject({
      status: 'exact',
      targetId: symbol.id,
    });
    expect(result.source.readEvidence(relation.siteEvidenceId)).toMatchObject({
      status: 'available',
      text: 'recurse()',
      filePath: 'source.ts',
    });
    expect(
      result.source.readEvidence(symbol.declarationEvidenceId),
    ).toMatchObject({
      status: 'available',
      text: 'export function recurse() { recurse(); }',
    });
  }, 15000);
});
