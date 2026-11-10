import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  analyzeProject,
  planRepositoryProjects,
} from '@codethread/symbol-indexer';
import type { ProjectEnvironment } from '@codethread/symbol-indexer';
import { createInvestigation } from '@codethread/trace-engine';

const repositoryId = '00000000-0000-4000-8000-000000000072';
function file(path: string, text: string) {
  const bytes = new TextEncoder().encode(text);
  return {
    path,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
function fixture(): ProjectEnvironment {
  const config = {
    extends: '../../tsconfig.base.json',
    compilerOptions: {
      composite: true,
      declaration: true,
      rootDir: 'src',
      outDir: 'dist',
    },
    files: ['src/index.ts'],
  };
  return {
    files: [
      file(
        'packages/a/src/index.ts',
        "import { twice } from '@fixture/b'; export function entry(n: number) { return twice(n); }",
      ),
      file(
        'packages/b/src/index.ts',
        'export function twice(n: number) { return n * 2; }',
      ),
    ],
    metadata: [
      file(
        'tsconfig.json',
        JSON.stringify({
          files: [],
          references: [{ path: 'packages/a' }, { path: 'packages/b' }],
        }),
      ),
      file(
        'tsconfig.base.json',
        JSON.stringify({
          compilerOptions: {
            target: 'ES2023',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            types: [],
            strict: true,
            lib: ['ES2023'],
          },
        }),
      ),
      file(
        'packages/a/tsconfig.json',
        JSON.stringify({ ...config, references: [{ path: '../b' }] }),
      ),
      file('packages/b/tsconfig.json', JSON.stringify(config)),
      file(
        'packages/a/package.json',
        JSON.stringify({
          name: '@fixture/a',
          type: 'module',
          exports: {
            '.': { types: './dist/index.d.ts', import: './dist/index.js' },
          },
        }),
      ),
      file(
        'packages/b/package.json',
        JSON.stringify({
          name: '@fixture/b',
          type: 'module',
          exports: {
            '.': { types: './dist/index.d.ts', import: './dist/index.js' },
          },
        }),
      ),
    ],
    workspacePackages: [
      { name: '@fixture/a', path: 'packages/a' },
      { name: '@fixture/b', path: 'packages/b' },
    ],
  };
}

describe('pinned monorepo project contexts', () => {
  it('accounts for configured sources and discloses inferred files', () => {
    const input = fixture();
    const plan = planRepositoryProjects(input);
    expect(plan.contextComplete).toBe(true);
    expect(
      plan.projects
        .filter((project) => project.status === 'ready')
        .map((project) => project.configPath),
    ).toEqual(['packages/a/tsconfig.json', 'packages/b/tsconfig.json']);
    expect(plan.assignedFiles).toBe(2);
    const withLooseSource = planRepositoryProjects({
      ...input,
      files: [...input.files, file('loose.ts', 'export function loose() {}')],
    });
    expect(withLooseSource.contextComplete).toBe(false);
    expect(withLooseSource.inferredFiles).toBe(1);
    expect(
      withLooseSource.projects.find((project) => project.configPath === null)
        ?.rootPaths,
    ).toEqual(['loose.ts']);
  });

  it('discovers configs only from tsconfig files and bounds config lists', () => {
    const input = fixture();
    const metadata = input.metadata.map((item) =>
      item.path === 'packages/a/package.json'
        ? file(
            item.path,
            JSON.stringify({
              name: '@fixture/a',
              extends: '../../not-a-config.json',
              references: [{ path: '../../not-a-project' }],
            }),
          )
        : item,
    );
    const plan = planRepositoryProjects({ ...input, metadata });
    expect(plan.contextComplete).toBe(true);
    expect(plan.projects.map((project) => project.configPath)).toEqual([
      'packages/a/tsconfig.json',
      'packages/b/tsconfig.json',
      'tsconfig.json',
    ]);

    const excessiveGlobs = planRepositoryProjects({
      ...input,
      workspacePackages: [],
      metadata: [
        file(
          'tsconfig.json',
          JSON.stringify({
            include: Array.from({ length: 129 }, () => 'src/**/*.ts'),
          }),
        ),
      ],
    });
    expect(excessiveGlobs.projects[0]).toMatchObject({
      status: 'invalid',
      diagnostics: [expect.objectContaining({ code: 'PROJECT_CONFIG_LIMIT' })],
    });

    const excessiveReferences = planRepositoryProjects({
      ...input,
      workspacePackages: [],
      metadata: [
        file(
          'tsconfig.json',
          JSON.stringify({
            references: Array.from({ length: 33 }, () => ({
              path: 'packages/a',
            })),
          }),
        ),
        ...input.metadata.filter((item) =>
          item.path.endsWith('/tsconfig.json'),
        ),
      ],
    });
    expect(
      excessiveReferences.projects.find(
        (project) => project.configPath === 'tsconfig.json',
      ),
    ).toMatchObject({
      status: 'invalid',
      diagnostics: [expect.objectContaining({ code: 'PROJECT_CONFIG_LIMIT' })],
    });
  });

  it('resolves a declared workspace project to original source without built outputs', async () => {
    const input = fixture();
    const snapshot = await analyzeProject({
      ...input,
      repositoryId,
      configPath: 'packages/a/tsconfig.json',
    });
    expect(snapshot.contextDiagnostics).toEqual([]);
    expect(snapshot.facts.files.map((source) => source.path)).toEqual([
      'packages/a/src/index.ts',
      'packages/b/src/index.ts',
    ]);
    const entry = snapshot.facts.symbols.find(
      (symbol) => symbol.name === 'entry',
    )!;
    const twice = snapshot.facts.symbols.find(
      (symbol) => symbol.name === 'twice',
    )!;
    expect(snapshot.facts.relations).toHaveLength(1);
    expect(snapshot.facts.relations[0]).toMatchObject({
      sourceSymbolId: entry.id,
      resolution: { status: 'exact', targetId: twice.id },
    });
    const evidence = snapshot.source.readEvidence(twice.declarationEvidenceId);
    expect(evidence).toMatchObject({
      status: 'available',
      filePath: 'packages/b/src/index.ts',
      text: 'export function twice(n: number) { return n * 2; }',
    });
    const other = await analyzeProject({
      ...input,
      repositoryId,
      configPath: 'packages/b/tsconfig.json',
    });
    expect(other.facts.snapshotId).not.toBe(snapshot.facts.snapshotId);
    const investigation = createInvestigation(snapshot.facts, snapshot.source, {
      resourceProfile: 'repository',
    });
    expect(() =>
      investigation.neighbors({
        snapshotId: other.facts.snapshotId,
        symbolId: entry.id,
      }),
    ).toThrowError(expect.objectContaining({ code: 'SNAPSHOT_NOT_FOUND' }));
  }, 30000);

  it('cancels an active project worker without publishing a snapshot', async () => {
    const input = fixture(),
      controller = new AbortController();
    const pending = analyzeProject({
      ...input,
      repositoryId,
      configPath: 'packages/a/tsconfig.json',
      signal: controller.signal,
    });
    const timer = setTimeout(() => controller.abort(), 0);
    try {
      await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    } finally {
      clearTimeout(timer);
    }
  }, 30000);

  it('keeps resolution deterministic when source and metadata order change', async () => {
    const input = fixture();
    const first = await analyzeProject({
      ...input,
      repositoryId,
      configPath: 'packages/a/tsconfig.json',
    });
    const reordered = await analyzeProject({
      ...input,
      files: [...input.files].reverse(),
      metadata: [...input.metadata].reverse(),
      workspacePackages: [...input.workspacePackages].reverse(),
      repositoryId,
      configPath: 'packages/a/tsconfig.json',
    });
    expect(reordered.facts).toEqual(first.facts);
  }, 30000);

  it('fails a missing configured source and preserves another valid context', async () => {
    const input = fixture();
    const metadata = input.metadata.map((item) =>
      item.path === 'packages/a/tsconfig.json'
        ? file(item.path, JSON.stringify({ files: ['missing.ts'] }))
        : item,
    );
    const plan = planRepositoryProjects({ ...input, metadata });
    expect(plan.contextComplete).toBe(false);
    expect(
      plan.projects.find(
        (project) => project.configPath === 'packages/a/tsconfig.json',
      ),
    ).toMatchObject({
      status: 'invalid',
      diagnostics: [
        expect.objectContaining({ code: 'PROJECT_SOURCE_MISSING' }),
      ],
    });
    const valid = await analyzeProject({
      ...input,
      metadata,
      repositoryId,
      configPath: 'packages/b/tsconfig.json',
    });
    expect(valid.facts.symbols.map((symbol) => symbol.name)).toEqual(['twice']);
  }, 30000);

  it('rejects reference cycles, escaping configuration and ambiguous workspace names', () => {
    const input = fixture();
    const metadata = input.metadata.map((item) =>
      item.path === 'packages/b/tsconfig.json'
        ? file(
            item.path,
            JSON.stringify({
              files: ['src/index.ts'],
              references: [{ path: '../a' }],
            }),
          )
        : item,
    );
    const plan = planRepositoryProjects({ ...input, metadata });
    expect(
      plan.projects
        .filter((project) => project.status === 'invalid')
        .map((project) => project.configPath),
    ).toEqual(['packages/a/tsconfig.json', 'packages/b/tsconfig.json']);
    expect(plan.contextComplete).toBe(false);
    const escape = planRepositoryProjects({
      ...input,
      workspacePackages: [],
      metadata: [file('tsconfig.json', '{"extends":"../outside.json"}')],
    });
    expect(
      escape.projects.find((project) => project.configPath === 'tsconfig.json')
        ?.diagnostics,
    ).toContainEqual(expect.objectContaining({ code: 'PROJECT_PATH_ESCAPE' }));
    expect(() =>
      planRepositoryProjects({
        ...input,
        workspacePackages: [
          input.workspacePackages[0]!,
          input.workspacePackages[0]!,
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_MANIFEST' }));
  });

  it('uses configured include/exclude membership without hiding unassigned sources', () => {
    const plan = planRepositoryProjects({
      files: [
        'src/root.ts',
        'src/deep/nested.ts',
        'src/fixtures/skip.ts',
        'other.ts',
      ].map((path) => file(path, 'export function item() {}')),
      metadata: [
        file(
          'tsconfig.json',
          '{"include":["src/**/*"],"exclude":["src/fixtures"]}',
        ),
      ],
      workspacePackages: [],
    });
    expect(
      plan.projects.find((project) => project.configPath === 'tsconfig.json')
        ?.rootPaths,
    ).toEqual(['src/deep/nested.ts', 'src/root.ts']);
    expect(
      plan.projects.find((project) => project.configPath === null)?.rootPaths,
    ).toEqual(['other.ts', 'src/fixtures/skip.ts']);
    expect(plan.assignedFiles + plan.inferredFiles).toBe(4);
  });

  it('keeps two alias resolutions for the same occurrence in separate snapshots', async () => {
    const input = {
      repositoryId,
      files: [
        file(
          'src/entry.ts',
          "import { target } from '@same'; export function entry(){ return target(); }",
        ),
        file('src/one.ts', 'export function target(){ return 1; }'),
        file('src/two.ts', 'export function target(){ return 2; }'),
      ],
      metadata: [
        file(
          'tsconfig.json',
          JSON.stringify({
            compilerOptions: {
              target: 'ES2023',
              module: 'ESNext',
              moduleResolution: 'Bundler',
              baseUrl: '.',
              paths: { '@same': ['./src/one.ts'] },
              types: [],
              ignoreDeprecations: '6.0',
            },
            include: ['src/**/*.ts'],
          }),
        ),
        file(
          'tsconfig.other.json',
          JSON.stringify({
            extends: './tsconfig.json',
            compilerOptions: { paths: { '@same': ['./src/two.ts'] } },
          }),
        ),
      ],
      workspacePackages: [],
    };
    const first = await analyzeProject({
      ...input,
      configPath: 'tsconfig.json',
    });
    const second = await analyzeProject({
      ...input,
      configPath: 'tsconfig.other.json',
    });
    const targetPath = (snapshot: typeof first) => {
      const relation = snapshot.facts.relations[0]!;
      expect(relation.resolution.status).toBe('exact');
      return snapshot.facts.symbols.find(
        (symbol) =>
          relation.resolution.status === 'exact' &&
          symbol.id === relation.resolution.targetId,
      )?.filePath;
    };
    expect(targetPath(first)).toBe('src/one.ts');
    expect(targetPath(second)).toBe('src/two.ts');
    expect(first.facts.snapshotId).not.toBe(second.facts.snapshotId);
  }, 30000);
});
