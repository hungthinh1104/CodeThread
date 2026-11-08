import { runInvestigationCli as runCli } from './helpers/investigation-cli.ts';
import {
  runGitFixture,
  createGitRepository,
  writeFixtureTree,
} from './helpers/git-fixture.ts';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
const temporaryDirectories: string[] = [];
const createCommittedRepository = (
  files: readonly { path: string; source: string }[],
) => createGitRepository(files, temporaryDirectories);
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function manifestFile(
  files: readonly { path: string; source: string }[],
) {
  const directory = await mkdtemp(resolve(tmpdir(), 'codethread-investigate-'));
  temporaryDirectories.push(directory);
  const manifestPath = resolve(directory, 'manifest.json');
  const content = JSON.stringify({
    version: 1,
    repositoryId: '00000000-0000-4000-8000-000000000012',
    files: files.map(({ path, source }) => {
      const bytes = Buffer.from(source, 'utf8');
      return {
        path,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        contentBase64: bytes.toString('base64'),
      };
    }),
  });
  await writeFile(manifestPath, content, 'utf8');
  return manifestPath;
}
describe('textual investigation CLI', () => {
  it('atomically selects and analyzes a complete directory-backed module', async () => {
    const { directory, revision } = await createCommittedRepository([
      { path: 'src/a.ts', source: 'export function a() {}\n' },
      { path: 'src/nested/b.ts', source: 'export function b() {}\n' },
      { path: 'src/λ.ts', source: 'export function lambda() {}\n' },
      {
        path: `src/${String.fromCodePoint(0x202e)}file.ts`,
        source: 'export function escapedPath() {}\n',
      },
    ]);
    const result = await runCli(
      [
        '--repo',
        directory,
        '--repository-id',
        '00000000-0000-4000-8000-000000000012',
        '--revision',
        revision,
        '--browse',
      ],
      'select-module src\nanalyze\nfiles\nquit\n',
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Selected 4 files from "src/" atomically.');
    expect(result.stdout).toContain('Source selection: 4 selected, 4 admitted');
    expect(result.stdout).toContain('Loaded 4 files');
    expect(result.stdout).toContain('src/λ.ts');
    expect(result.stdout).not.toContain(String.fromCodePoint(0x202e));
  });

  it('rejects an over-limit module atomically without analyzing a prefix', async () => {
    const files = Array.from({ length: 21 }, (_, index) => ({
      path: `src/file-${String(index).padStart(2, '0')}.ts`,
      source: `export function item${index}() {}\n`,
    }));
    const { directory, revision } = await createCommittedRepository(files);
    const result = await runCli(
      [
        '--repo',
        directory,
        '--repository-id',
        '00000000-0000-4000-8000-000000000012',
        '--revision',
        revision,
        '--browse',
      ],
      'select-module src\n',
    );

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('ERROR[RESOURCE_LIMIT]');
    expect(result.stderr).toContain('20-file limit');
    expect(result.stdout).not.toContain('Source selection:');
    expect(result.stdout).not.toContain('STATIC RELATIONSHIPS ONLY');
  });

  it('rejects module selection from an incomplete inventory without analyzing a subset', async () => {
    const { directory, revision } = await createCommittedRepository([
      { path: 'placeholder.ts', source: 'export function retained() {}\n' },
    ]);
    const blobId = (
      await runGitFixture(directory, [
        'rev-parse',
        `${revision}:placeholder.ts`,
      ])
    ).trim();
    let repeatedTree = await writeFixtureTree(directory, [
      { mode: '100644', type: 'blob', oid: blobId, name: 'file.ts' },
    ]);
    for (let depth = 0; depth < 10; depth++)
      repeatedTree = await writeFixtureTree(directory, [
        { mode: '40000', type: 'tree', oid: repeatedTree, name: 'a' },
        { mode: '40000', type: 'tree', oid: repeatedTree, name: 'b' },
      ]);
    const rootTree = await writeFixtureTree(directory, [
      { mode: '40000', type: 'tree', oid: repeatedTree, name: 'src' },
    ]);
    const commit = (
      await runGitFixture(directory, [
        '-c',
        'user.name=CodeThread Test',
        '-c',
        'user.email=codethread-test@example.invalid',
        'commit-tree',
        rootTree,
        '-m',
        'oversized module inventory fixture',
      ])
    ).trim();
    const result = await runCli(
      [
        '--repo',
        directory,
        '--repository-id',
        '00000000-0000-4000-8000-000000000012',
        '--revision',
        commit,
        '--browse',
      ],
      'select-module src\n',
    );

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('ERROR[SOURCE_INVENTORY_INCOMPLETE]');
    expect(result.stdout).toContain('file_limit');
    expect(result.stdout).not.toContain('STATIC RELATIONSHIPS ONLY');
  }, 30_000);

  it('browses committed files and continues into the existing investigation session', async () => {
    const { directory, revision } = await createCommittedRepository([
      {
        path: 'src/a space.ts',
        source:
          'export function root() { target(); }\nexport function target() {}\n',
      },
    ]);
    await writeFile(
      resolve(directory, 'src/a space.ts'),
      'working tree only\n',
    );
    const result = await runCli(
      [
        '--repo',
        directory,
        '--repository-id',
        '00000000-0000-4000-8000-000000000012',
        '--revision',
        'HEAD',
        '--browse',
      ],
      [
        'search "a space"',
        'select "src/a space.ts"',
        'analyze',
        'symbols',
        'inspect "src/a space.ts@1:1" calls outgoing',
        'evidence symbol "src/a space.ts@1:1"',
        'quit',
        '',
      ].join('\n'),
    );

    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(`Pinned Git commit: ${revision} (sha1).`);
    expect(result.stdout).toContain('Source selection: 1 selected, 1 admitted');
    expect(result.stdout).toContain('src/a space.ts');
    expect(result.stdout).toContain('[CALLS exact] outgoing');
    expect(result.stdout).toContain('target');
    expect(result.stdout).toContain('export function root() { target(); }');
    expect(result.stdout).not.toContain('working tree only');
  });

  it('supports a pinned source investigation with typed references, follow and verified evidence', async () => {
    const result = await runCli(
      ['--demo', 'todo'],
      [
        'symbols controllers/todo.controller.ts',
        'inspect routes/todo.router.ts@4:1 calls,references outgoing',
        'follow controllers/todo.controller.ts@10:3 references incoming',
        'evidence symbol controllers/todo.controller.ts@10:3',
        'quit',
        '',
      ].join('\n'),
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('STATIC RELATIONSHIPS ONLY');
    expect(result.stdout).toContain('[REFERENCES exact] outgoing');
    expect(result.stdout).toContain('[REFERENCES exact] incoming');
    expect(result.stdout).toContain('Reference occurrence:');
    expect(result.stdout).not.toContain('[CALLS exact]');
    expect(result.stdout).toContain('controllers/todo.controller.ts@10:3');
    expect(result.stdout).toContain(
      'sha256:3d1a82e2db7af3c8af876ff445fce286517c3636ee571f4094ea22e9b48195c2',
    );
    expect(result.stdout).toContain('getAll');
    expect(result.stdout).toContain('getOne');
    expect(result.stdout).toContain('create');
    expect(result.stdout).not.toContain('Call site:');
    expect(result.stdout).not.toMatch(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/i);
  }, 20_000);

  it('rejects ambiguous display-name selection and keeps uncertain calls targetless', async () => {
    const ambiguousManifest = await manifestFile([
      { path: 'a.ts', source: 'export function same() {}\n' },
      { path: 'b.ts', source: 'export function same() {}\n' },
    ]);
    const ambiguous = await runCli(
      ['--manifest', ambiguousManifest],
      'help\ninspect name:same\nhelp\n',
    );
    expect(ambiguous.code).toBe(2);
    expect(ambiguous.stderr).toContain('ERROR[SYMBOL_AMBIGUOUS]');
    expect(ambiguous.stderr).toContain('a.ts@1:1');
    expect(ambiguous.stderr).toContain('b.ts@1:1');
    expect(ambiguous.stdout.match(/files — list manifest paths/g)).toHaveLength(
      1,
    );

    const uncertainManifest = await manifestFile([
      {
        path: 'main.ts',
        source: 'function root() { missing(); }\n',
      },
    ]);
    const uncertain = await runCli(
      ['--manifest', uncertainManifest],
      'inspect main.ts@1:1 calls outgoing\n',
    );
    expect(uncertain.code).toBe(0);
    expect(uncertain.stdout).toContain('[CALLS unresolved] outgoing');
    expect(uncertain.stdout).toContain('target unknown (unresolved)');
    expect(uncertain.stdout).not.toContain('[CALLS EXACT');
  });

  it('keeps calls as the default filter and treats empty partial views as non-exhaustive', async () => {
    const manifest = await manifestFile([
      {
        path: 'flow.ts',
        source:
          'function root() { target(); }\nfunction target() {}\nfunction empty() {}\n',
      },
    ]);
    const result = await runCli(
      ['--manifest', manifest],
      'inspect flow.ts@1:1\ninspect flow.ts@3:1\n',
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('[CALLS exact] outgoing');
    expect(result.stdout).toContain('No calls relationships were returned');
    expect(result.stdout).toContain('not proof that no relationship exists');
    expect(result.stdout).not.toContain('[REFERENCES');
  });

  it('reports returned graph truncation and separately bounded text omissions', async () => {
    const targets = Array.from({ length: 25 }, (_, index) => `target${index}`);
    const source = [
      `export function root() {\n  ${targets.map((name) => `${name}();`).join('\n  ')}\n}`,
      ...targets.map((name) => `export function ${name}() { leaf(); }`),
      'export function leaf() {}',
    ].join('\n');
    const manifest = await manifestFile([{ path: 'many.ts', source }]);
    const result = await runCli(
      ['--manifest', manifest],
      'inspect many.ts@1:1 calls outgoing\n',
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      'CLI display omitted 5 of 25 returned relationship occurrences',
    );
    expect(result.stdout).toContain('Query truncated:');
    expect(result.stdout).not.toContain('No calls relationships were returned');
  });

  it('does not allow following an exact target whose relationship row was byte-truncated', async () => {
    const targets = Array.from({ length: 20 }, (_, index) => `target${index}`);
    const bidi = String.fromCodePoint(0x202e);
    const source = [
      `export function root() {\n${targets
        .map((name) => `  ${name}('${bidi.repeat(320)}');`)
        .join('\n')}\n}`,
      ...targets.map((name) => `export function ${name}(_value: string) {}`),
    ].join('\n');
    const manifest = await manifestFile([{ path: 'truncated.ts', source }]);
    const hiddenTarget = await runCli(
      ['--manifest', manifest],
      [
        'inspect truncated.ts@1:1 calls outgoing',
        'follow truncated.ts@42:1 calls incoming',
      ].join('\n'),
    );
    expect(hiddenTarget.stdout).toContain('20 exact');
    expect(hiddenTarget.stdout).toContain('[Text response truncated');
    expect(hiddenTarget.stdout).not.toContain('target19" (function)');
    expect(hiddenTarget.code).toBe(2);
    expect(hiddenTarget.stderr).toContain('ERROR[TARGET_NOT_IN_LAST_RESULTS]');
    expect(hiddenTarget.stderr).toContain('truncated.ts@42:1');

    const displayedTarget = await runCli(
      ['--manifest', manifest],
      [
        'inspect truncated.ts@1:1 calls outgoing',
        'follow truncated.ts@23:1 calls incoming',
      ].join('\n'),
    );
    expect(displayedTarget.stdout).toContain('[Text response truncated');
    expect(displayedTarget.stdout).toContain('"target0" (function)');
    expect(displayedTarget.code).toBe(0);
    expect(displayedTarget.stderr).toBe('');
  });

  it('rejects duplicate JSON keys and unsafe paths before analysis', async () => {
    const directory = await mkdtemp(
      resolve(tmpdir(), 'codethread-investigate-'),
    );
    temporaryDirectories.push(directory);
    const manifestPath = resolve(directory, 'duplicate.json');
    await writeFile(
      manifestPath,
      '{"version":1,"version":1,"repositoryId":"00000000-0000-4000-8000-000000000012","files":[]}',
      'utf8',
    );
    const duplicate = await runCli(['--manifest', manifestPath]);
    expect(duplicate.code).toBe(2);
    expect(duplicate.stderr).toContain('ERROR[INVALID_MANIFEST]');

    const unsafePath = await manifestFile([
      { path: '../outside.ts', source: 'export function root() {}\n' },
    ]);
    const unsafe = await runCli(['--manifest', unsafePath]);
    expect(unsafe.code).toBe(2);
    expect(unsafe.stderr).toContain('ERROR[INVALID_MANIFEST]');

    const oversizedPath = resolve(directory, 'oversized.json');
    await writeFile(oversizedPath, Buffer.alloc(3 * 1024 * 1024 + 1, 0x20));
    const oversized = await runCli(['--manifest', oversizedPath]);
    expect(oversized.code).toBe(2);
    expect(oversized.stderr).toContain('ERROR[MANIFEST_TOO_LARGE]');
  });

  it('prints a reusable evidence continuation for long declarations and spaced paths', async () => {
    const payload = 'x'.repeat(5000);
    const manifest = await manifestFile([
      {
        path: 'page file.ts',
        source: `export function root() { const text = '${payload}'; }\n`,
      },
    ]);
    const result = await runCli(
      ['--manifest', manifest],
      [
        'evidence symbol "page file.ts@1:1"',
        'evidence symbol "page file.ts@1:1" 4096',
      ].join('\n'),
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('UTF-16 page [0, 4096)');
    expect(result.stdout).toContain(
      'Next page: evidence symbol "page file.ts@1:1" 4096',
    );
    expect(result.stdout).toContain('UTF-16 page [4096,');
    expect(result.stdout).toContain('End of verified evidence.');
  });

  it('prints safe, reversible selectors for legal unusual source paths', async () => {
    const formatCharacters = String.fromCodePoint(
      0x7f,
      0x85,
      0x202e,
      0x2066,
      0xe0001,
    );
    const paths = [
      '"leading.ts',
      `control${formatCharacters}.ts`,
      'folder with space/λ@file.ts',
    ];
    const manifest = await manifestFile(
      paths.map((path) => ({ path, source: 'export function root() {}\n' })),
    );
    const listing = await runCli(['--manifest', manifest], 'symbols\nquit\n');
    expect(listing.code).toBe(0);
    expect(listing.stdout).not.toMatch(/[\u007f\u0085\u202e\u2066]/u);
    expect(listing.stdout).not.toContain(String.fromCodePoint(0xe0001));

    const selectorRows = listing.stdout
      .split('\n')
      .filter((line) => line.includes('  function  "root"'));
    const selectors = selectorRows.map((line) =>
      line.slice(0, line.indexOf('  function  "root"')).trim(),
    );
    expect(selectors).toEqual([
      String.raw`"\"leading.ts@1:1"`,
      String.raw`"control\u007f\u0085\u202e\u2066\udb40\udc01.ts@1:1"`,
      String.raw`"folder with space/λ@file.ts@1:1"`,
    ]);

    const replay = await runCli(
      ['--manifest', manifest],
      [...selectors.map((selector) => `inspect ${selector}`), 'quit', ''].join(
        '\n',
      ),
    );
    expect(replay.code).toBe(0);
    expect(replay.stderr).toBe('');
    for (const selector of selectors) expect(replay.stdout).toContain(selector);
  });

  it('escapes terminal controls in source excerpts', async () => {
    const manifest = await manifestFile([
      {
        path: 'control.ts',
        source: `export function root() { /* ${String.fromCharCode(0x1b)}[31m */ }\n`,
      },
    ]);
    const result = await runCli(
      ['--manifest', manifest],
      'evidence symbol control.ts@1:1\n',
    );
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain(String.fromCharCode(0x1b));
    expect(result.stdout).toContain('\\u{1b}');
  });
});
