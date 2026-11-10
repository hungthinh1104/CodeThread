import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { analyzeManifest, COMPILER_PROFILE } from '@codethread/symbol-indexer';
import {
  loadExternalCorpus,
  loadTodoClosure,
} from '../scripts/external-semantic-corpus.ts';

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
  it('reports unsupported decorators even when the decorator is not a call expression', async () => {
    const source =
      'function decorate(value: unknown) {}\n@decorate\nclass Thing {}\n';
    const result = await analyzeManifest({
      repositoryId,
      compilerOptions: COMPILER_PROFILE,
      files: [sourceFile('source.ts', source)],
    });
    const diagnostic = result.facts.diagnostics.find(
      (item) => item.code === 'DECORATOR_UNSUPPORTED',
    );
    expect(diagnostic).toBeDefined();
    expect(result.facts.coverageByCapability['decorators.v1']).toBe(
      'unsupported',
    );
    const evidence = result.facts.evidenceRefs.find(
      (item) =>
        item.fileId === diagnostic!.fileId &&
        item.range.start.offset === diagnostic!.range!.start.offset &&
        item.range.end.offset === diagnostic!.range!.end.offset,
    )!;
    expect(result.source.readEvidence(evidence.id)).toMatchObject({
      status: 'available',
      text: '@decorate',
    });
  }, 15000);
  it('diagnoses an unavailable triple-slash type dependency without reading ambient types', async () => {
    const source =
      '/// <reference types="node" />\nexport function run() { missing(); }\n';
    const result = await analyzeManifest({
      repositoryId,
      compilerOptions: COMPILER_PROFILE,
      files: [sourceFile('source.ts', source)],
    });
    expect(result.facts.observations[0]?.status).toBe('unresolved');
    expect(
      result.facts.diagnostics.some((item) => item.code === 'TS_2688'),
    ).toBe(true);
  }, 15000);
  it('scopes compiler-error uncertainty to the candidate declaration', async () => {
    const missingSignatureType = await analyzeManifest({
      repositoryId,
      compilerOptions: COMPILER_PROFILE,
      files: [
        sourceFile(
          'source.ts',
          'function target(arg?: MissingType): void {}\nexport function caller() { target(); }\n',
        ),
      ],
    });
    expect(missingSignatureType.facts.observations[0]?.status).toBe(
      'unresolved',
    );
    expect(
      missingSignatureType.facts.diagnostics.map((item) => item.code),
    ).toEqual(expect.arrayContaining(['TS_2304', 'INVALID_BINDING']));

    const targetBodyError = await analyzeManifest({
      repositoryId,
      compilerOptions: COMPILER_PROFILE,
      files: [
        sourceFile(
          'source.ts',
          'function target() { const value: string = 1; }\nexport function caller() { target(); }\n',
        ),
      ],
    });
    expect(targetBodyError.facts.observations[0]?.status).toBe('unresolved');
    expect(targetBodyError.facts.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(['TS_2322', 'INVALID_BINDING']),
    );

    const unrelatedError = await analyzeManifest({
      repositoryId,
      compilerOptions: COMPILER_PROFILE,
      files: [
        sourceFile(
          'source.ts',
          'function target() {}\nexport function caller() { target(); }\nconst unrelated: string = 1;\n',
        ),
      ],
    });
    expect(unrelatedError.facts.observations[0]?.status).toBe('exact');
    expect(unrelatedError.facts.diagnostics.map((item) => item.code)).toEqual([
      'TS_2322',
    ]);
  }, 15000);
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
  it('keeps source-anchored calls exact across renames, file moves, and byte changes', async () => {
    const variants = [
      {
        callerPath: 'src/caller.ts',
        targetPath: 'src/leaf.ts',
        targetName: 'leaf',
        importPath: './leaf.js',
        targetText: 'export function leaf() { return 1; }\n',
        extraFiles: [],
      },
      {
        callerPath: 'src/moved/caller.ts',
        targetPath: 'src/moved/renamed-leaf.ts',
        targetName: 'renamedLeaf',
        importPath: './renamed-leaf.js',
        targetText: 'export function renamedLeaf() { return 1; }\n',
        extraFiles: [
          sourceFile('extra.ts', 'export function unrelated() {}\n'),
        ],
      },
      {
        callerPath: 'src/caller.ts',
        targetPath: 'src/leaf.ts',
        targetName: 'leaf',
        importPath: './leaf.js',
        targetText: 'export function leaf() { return 2; }\n',
        extraFiles: [
          sourceFile('extra.ts', 'export function unrelated() {}\n'),
        ],
      },
    ];
    for (const variant of variants) {
      const callerText =
        `import { ${variant.targetName} } from '${variant.importPath}';\n` +
        `export function caller() { return ${variant.targetName}(); }\n`;
      const result = await analyzeManifest({
        repositoryId,
        compilerOptions: COMPILER_PROFILE,
        files: [
          sourceFile(variant.callerPath, callerText),
          sourceFile(variant.targetPath, variant.targetText),
          ...variant.extraFiles,
        ],
      });
      const callerFile = result.facts.files.find(
        (file) => file.path === variant.callerPath,
      )!;
      const observations = result.facts.observations.filter(
        (item) => item.fileId === callerFile.id,
      );
      expect(observations).toHaveLength(1);
      const observation = observations[0]!;
      expect(observation.status).toBe('exact');
      expect(observation.relationId).toBeDefined();
      const relation = result.facts.relations.find(
        (item) => item.id === observation.relationId,
      )!;
      expect(relation).toMatchObject({
        kind: 'calls',
        sourceSymbolId: observation.ownerId,
        resolution: { status: 'exact' },
      });
      if (relation.resolution.status !== 'exact')
        throw new Error('Expected a source-supported exact call target.');
      const target = result.facts.symbols.find(
        (symbol) => symbol.id === relation.resolution.targetId,
      )!;
      expect(target).toMatchObject({
        filePath: variant.targetPath,
        name: variant.targetName,
        kind: 'function',
      });
      expect(result.source.readEvidence(observation.evidenceId)).toMatchObject({
        status: 'available',
        filePath: variant.callerPath,
        text: `${variant.targetName}()`,
      });
      expect(
        result.source.readEvidence(target.declarationEvidenceId),
      ).toMatchObject({
        status: 'available',
        filePath: variant.targetPath,
        text: variant.targetText.trim(),
      });
    }
  }, 30000);
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
    [
      'declaration without implementation',
      'declare function a(): void; function run() { a(); }',
    ],
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
  it('extracts the three pinned todo method references with exact source evidence', async () => {
    const corpus = await loadExternalCorpus('todo');
    const closure = await loadTodoClosure();
    const files = [
      corpus.files.find((file) => file.path === 'routes/todo.router.ts')!,
      ...closure.filter(({ path }) =>
        ['controllers/todo.controller.ts', 'models/todo.ts'].includes(path),
      ),
    ];
    const result = await analyzeManifest({
      repositoryId,
      compilerOptions: COMPILER_PROFILE,
      files,
    });
    const routeFile = result.facts.files.find(
      (file) => file.path === 'routes/todo.router.ts',
    )!;
    const references = result.facts.relations.filter(
      (relation) =>
        relation.kind === 'references' &&
        result.facts.evidenceRefs.find(
          (item) => item.id === relation.siteEvidenceId,
        )?.fileId === routeFile.id,
    );
    expect(references).toHaveLength(3);
    expect(references.every((item) => item.resolution.status === 'exact')).toBe(
      true,
    );
    const resolved = references.map((relation) => {
      const target = result.facts.symbols.find(
        (symbol) =>
          symbol.id ===
          (relation.resolution.status === 'exact'
            ? relation.resolution.targetId
            : null),
      )!;
      const site = result.source.readEvidence(relation.siteEvidenceId);
      const declaration = result.source.readEvidence(
        target.declarationEvidenceId,
      );
      return {
        relation,
        target,
        targetEvidenceIncluded:
          relation.resolution.status === 'exact' &&
          relation.resolution.evidenceIds.includes(
            target.declarationEvidenceId,
          ),
        siteText: site.status === 'available' ? site.text : null,
        siteRange: site.status === 'available' ? site.evidence.range : null,
        declarationText:
          declaration.status === 'available' ? declaration.text : null,
        declarationRange:
          declaration.status === 'available'
            ? declaration.evidence.range
            : null,
      };
    });
    expect(
      resolved.map(({ siteText, target, declarationText }) => [
        siteText,
        target.kind,
        target.filePath,
        target.name,
        declarationText?.slice(0, 24),
      ]),
    ).toEqual([
      [
        'toDoCtrl.getAll',
        'method',
        'controllers/todo.controller.ts',
        'getAll',
        'async getAll(req: Reques',
      ],
      [
        'toDoCtrl.getOne',
        'method',
        'controllers/todo.controller.ts',
        'getOne',
        'async getOne(req: Reques',
      ],
      [
        'toDoCtrl.create',
        'method',
        'controllers/todo.controller.ts',
        'create',
        'async create(req: Reques',
      ],
    ]);
    expect(
      resolved.every(({ targetEvidenceIncluded }) => targetEvidenceIncluded),
    ).toBe(true);
    expect(
      resolved.every(
        ({ target, declarationRange }) =>
          declarationRange &&
          declarationRange.start.offset === target.range.start.offset &&
          declarationRange.end.offset === target.range.end.offset,
      ),
    ).toBe(true);
    expect(
      resolved.map(({ siteRange, declarationRange }) => [
        siteRange?.start.line,
        siteRange?.start.column,
        siteRange?.end.line,
        siteRange?.end.column,
        declarationRange?.start.line,
        declarationRange?.end.line,
      ]),
    ).toEqual([
      [8, 19, 8, 34, 10, 26],
      [11, 22, 11, 37, 28, 40],
      [14, 20, 14, 35, 42, 60],
    ]);
    expect(references.map((relation) => relation.kind)).toEqual([
      'references',
      'references',
      'references',
    ]);
    const methodIds = new Set(resolved.map(({ target }) => target.id));
    expect(
      result.facts.relations.some(
        (relation) =>
          relation.kind === 'calls' &&
          relation.resolution.status === 'exact' &&
          methodIds.has(relation.resolution.targetId),
      ),
    ).toBe(false);
    expect(result.facts.coverageByCapability['references.v1']).toBe('partial');
  }, 30000);
  it('keeps computed, accessor, overloaded, ambiguous and missing references unknown', async () => {
    const source = [
      'class Base { handle() {} }',
      'class Derived extends Base { override handle() {} }',
      'class Accessor { get handle(): () => void { return () => {}; } }',
      'class Left { execute() {} }',
      'class Right { execute() {} }',
      "class Data { label = 'value'; }",
      'class Overloaded { run(value: string): void; run(value: unknown) {} }',
      "import type { MissingType } from './missing-type.js';",
      "import { missing } from './missing.js';",
      'function register(value: unknown) {}',
      'export function inspect(base: Base, accessor: Accessor, choice: Left | Right, data: Data, overloaded: Overloaded, typeOnly: MissingType) {',
      '  let reassigned: Base = new Derived();',
      '  reassigned = new Derived();',
      '  register(reassigned.handle);',
      '  register(accessor.handle);',
      '  register(choice.execute);',
      '  register(data.label);',
      "  register(base['handle']);",
      '  register(overloaded.run);',
      '  register(missing.handle);',
      '  register(typeOnly.execute);',
      '  (() => register(base.handle))();',
      '}',
      '',
    ].join('\n');
    const result = await analyzeManifest({
      repositoryId,
      compilerOptions: COMPILER_PROFILE,
      files: [sourceFile('references.ts', source)],
    });
    const references = result.facts.relations.filter(
      (relation) => relation.kind === 'references',
    );
    const byText = new Map(
      references.map((relation) => {
        const evidence = result.source.readEvidence(relation.siteEvidenceId);
        return [evidence.status === 'available' ? evidence.text : '', relation];
      }),
    );
    const targetName = (text: string) => {
      const relation = byText.get(text)!;
      return relation.resolution.status === 'exact'
        ? result.facts.symbols.find(
            (symbol) => symbol.id === relation.resolution.targetId,
          )?.name
        : null;
    };
    expect(targetName('reassigned.handle')).toBe('handle');
    expect(byText.get('reassigned.handle')?.resolution.status).toBe('exact');
    expect(byText.get('accessor.handle')?.resolution).toMatchObject({
      status: 'unsupported',
      targetId: null,
    });
    expect(byText.get('choice.execute')?.resolution).toMatchObject({
      status: 'ambiguous',
      targetId: null,
    });
    expect(byText.get("base['handle']")?.resolution).toMatchObject({
      status: 'unsupported',
      targetId: null,
    });
    expect(byText.get('overloaded.run')?.resolution).toMatchObject({
      status: 'unsupported',
      targetId: null,
    });
    expect(byText.get('missing.handle')?.resolution).toMatchObject({
      status: 'unresolved',
      targetId: null,
    });
    expect(byText.get('typeOnly.execute')?.resolution.targetId).toBeNull();
    expect(byText.has('data.label')).toBe(false);
    expect(
      result.facts.diagnostics.some(
        (diagnostic) => diagnostic.code === 'OWNER_UNSUPPORTED',
      ),
    ).toBe(true);
    const reassigned = byText.get('reassigned.handle');
    const reassignedTarget =
      reassigned?.resolution.status === 'exact'
        ? result.facts.symbols.find(
            (symbol) => symbol.id === reassigned.resolution.targetId,
          )
        : undefined;
    expect(reassignedTarget?.range.start.line).toBe(1);
    expect(references.every((relation) => relation.kind === 'references')).toBe(
      true,
    );
  }, 30000);
  it('binds shadowed method references to the local declaration and lexical owner', async () => {
    const source = [
      'class Outer { handle() {} }',
      'class Inner { handle() {} }',
      'function register(value: unknown) {}',
      'export function root(value: Outer) {',
      '  register(value.handle);',
      '  function nested(value: Inner) { register(value.handle); }',
      '}',
      '',
    ].join('\n');
    const result = await analyzeManifest({
      repositoryId,
      compilerOptions: COMPILER_PROFILE,
      files: [sourceFile('shadowed.ts', source)],
    });
    const references = result.facts.relations.filter(
      (relation) => relation.kind === 'references',
    );
    expect(references).toHaveLength(2);
    const byLine = references.map((relation) => {
      const site = result.facts.evidenceRefs.find(
        (item) => item.id === relation.siteEvidenceId,
      )!;
      const owner = result.facts.symbols.find(
        (item) => item.id === relation.sourceSymbolId,
      )!;
      const target = result.facts.symbols.find(
        (item) =>
          relation.resolution.status === 'exact' &&
          item.id === relation.resolution.targetId,
      )!;
      return [
        site.range.start.line,
        owner.name,
        target.filePath,
        target.range.start.line,
      ];
    });
    expect(byLine).toEqual([
      [5, 'root', 'shadowed.ts', 1],
      [6, 'nested', 'shadowed.ts', 2],
    ]);
  }, 15000);
  it('keeps repeated method references as separate source occurrences', async () => {
    const source = [
      'class Handler { handle() {} }',
      'function register(value: unknown) {}',
      'export function root(handler: Handler) {',
      '  register(handler.handle);',
      '  register(handler.handle);',
      '}',
      '',
    ].join('\n');
    const result = await analyzeManifest({
      repositoryId,
      compilerOptions: COMPILER_PROFILE,
      files: [sourceFile('occurrences.ts', source)],
    });
    const references = result.facts.relations.filter(
      (relation) => relation.kind === 'references',
    );
    expect(references).toHaveLength(2);
    expect(new Set(references.map((item) => item.key)).size).toBe(2);
    expect(new Set(references.map((item) => item.siteEvidenceId)).size).toBe(2);
    expect(
      new Set(
        references.map((item) =>
          item.resolution.status === 'exact' ? item.resolution.targetId : null,
        ),
      ).size,
    ).toBe(1);
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
