import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createGitRepository,
  runGitFixture,
  writeFixtureTree,
  commitFixtureTree,
} from './helpers/git-fixture.ts';
import {
  runInvestigationCli,
  startInvestigationCli,
} from './helpers/investigation-cli.ts';

const directories: string[] = [];
const repositoryId = '00000000-0000-4000-8000-000000000022';
const cliArgs = (directory: string, revision: string) => [
  '--repo',
  directory,
  '--repository-id',
  repositoryId,
  '--revision',
  revision,
  '--browse',
];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    if (dirname(directory) !== resolve(tmpdir()))
      throw new Error('Unexpected cleanup target.');
    await rm(directory, { recursive: true, force: true });
  }
});

describe('repository browse to investigation CLI', () => {
  it('searches and filters pinned source, then inspects exact calls and evidence after the selected branch moves', async () => {
    const entry =
      "import { leaf } from './leaf';\nexport function entry() { return leaf(); }\n";
    const leaf = 'export function leaf() { return 7; }\r\n';
    const { directory, revision } = await createGitRepository(
      [
        { path: 'src/entry.ts', source: entry },
        { path: 'src/leaf.ts', source: leaf },
      ],
      directories,
    );
    const branch = (
      await runGitFixture(directory, ['symbolic-ref', 'HEAD'])
    ).trim();
    const running = startInvestigationCli(cliArgs(directory, branch));
    try {
      await running.waitFor(/Inventory status: complete/);
      const blob = (
        await runGitFixture(
          directory,
          ['hash-object', '-w', '--stdin'],
          'export function changed() {}\n',
        )
      ).trim();
      const tree = await writeFixtureTree(directory, [
        { mode: '100644', type: 'blob', oid: blob, name: 'changed.ts' },
      ]);
      await runGitFixture(directory, [
        'update-ref',
        branch,
        await commitFixtureTree(directory, tree),
      ]);
      await writeFile(
        resolve(directory, 'src/leaf.ts'),
        'DIRTY SOURCE MUST NOT BE ANALYZED',
      );
      running.child.stdin.end(
        [
          'files src',
          'search leaf src',
          'lookup src/leaf.ts',
          'select-module src',
          'selected',
          'analyze',
          'inspect src/entry.ts@2:1 calls outgoing',
          'follow src/leaf.ts@1:1',
          'evidence symbol src/leaf.ts@1:1',
          'quit',
        ].join('\n') + '\n',
      );
      const result = await running.result;
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain(`Pinned Git commit: ${revision}`);
      expect(result.stdout).toContain('Lookup "src/leaf.ts": found.');
      expect(result.stdout).toContain(
        'Source selection: 2 selected, 2 admitted, 0 rejected, 0 not admitted.',
      );
      expect(result.stdout).toContain('CALLS');
      expect(result.stdout).toContain('return 7;');
      expect(result.stdout).toContain(
        createHash('sha256').update(leaf).digest('hex'),
      );
      expect(result.stdout).not.toContain('changed.ts');
      expect(result.stdout).not.toContain('DIRTY SOURCE');
    } finally {
      await running.stop();
    }
  }, 30000);

  it('selects unusual literal Git names without normalization and safely renders selectors and excerpts', async () => {
    const { directory } = await createGitRepository(
      [{ path: 'placeholder.ts', source: 'export function entry() {}\n' }],
      directories,
    );
    const blob = (
      await runGitFixture(directory, ['rev-parse', 'HEAD:placeholder.ts'])
    ).trim();
    const names = [
      '-first.ts',
      ' space .ts',
      '"quote.ts',
      'wild*.ts',
      '\u202Ehandler.ts',
      'src/\uFEFFfile.ts',
    ];
    const nested = await writeFixtureTree(directory, [
      { mode: '100644', type: 'blob', oid: blob, name: '\uFEFFfile.ts' },
    ]);
    const tree = await writeFixtureTree(directory, [
      ...names
        .slice(0, 5)
        .map((name) => ({ mode: '100644', type: 'blob', oid: blob, name })),
      { mode: '40000', type: 'tree', oid: nested, name: 'src' },
    ]);
    const revision = await commitFixtureTree(directory, tree);
    const result = await runInvestigationCli(
      cliArgs(directory, revision),
      [
        'search "*"',
        ...names.map((name) => `select ${JSON.stringify(name)}`),
        'selected',
        'analyze',
        'symbols',
        `evidence symbol ${JSON.stringify('src/\uFEFFfile.ts@1:1')}`,
        'quit',
      ].join('\n') + '\n',
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Loaded 6 files');
    expect(result.stdout).toContain('6 selected, 6 admitted');
    expect(result.stdout).toContain('\\u202ehandler.ts');
    expect(result.stdout).toContain('\\ufefffile.ts');
    expect(result.stdout).not.toContain('\u202E');
    expect(result.stdout).not.toContain('\uFEFF');
    expect(result.stdout).toContain('export function entry() {}');
  }, 20000);

  it('preserves the analyzer rejection for a BOM at the beginning of a full source path', async () => {
    const { directory } = await createGitRepository(
      [{ path: 'placeholder.ts', source: 'export function entry() {}\n' }],
      directories,
    );
    const blob = (
      await runGitFixture(directory, ['rev-parse', 'HEAD:placeholder.ts'])
    ).trim();
    const tree = await writeFixtureTree(directory, [
      { mode: '100644', type: 'blob', oid: blob, name: '\uFEFFroot.ts' },
    ]);
    const result = await runInvestigationCli(
      cliArgs(directory, await commitFixtureTree(directory, tree)),
      `select ${JSON.stringify('\uFEFFroot.ts')}\nanalyze\n`,
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('ERROR[INVALID_MANIFEST]');
    expect(result.stderr).toContain('1 selected, 0 admitted, 1 rejected');
    expect(result.stdout).not.toContain('Loaded 1 files');
    expect(result.stdout).toContain('\\ufeffroot.ts');
  }, 20000);

  it('keeps cursor advancement tied to rows actually displayed under the output byte limit', async () => {
    const { directory } = await createGitRepository(
      [{ path: 'placeholder.ts', source: 'export function entry() {}\n' }],
      directories,
    );
    const blob = (
      await runGitFixture(directory, ['rev-parse', 'HEAD:placeholder.ts'])
    ).trim();
    const names = Array.from(
      { length: 60 },
      (_, index) =>
        `${String(index).padStart(3, '0')}-${'\u202E'.repeat(500)}.ts`,
    );
    const tree = await writeFixtureTree(
      directory,
      names.map((name) => ({ mode: '100644', type: 'blob', oid: blob, name })),
    );
    const result = await runInvestigationCli(
      cliArgs(directory, await commitFixtureTree(directory, tree)),
      'next\n'.repeat(10) + 'quit\n',
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    const displayed = [
      ...result.stdout.matchAll(/^("(?:[^"\\]|\\.)*") \[100644\]$/gm),
    ].map((match) => JSON.parse(match[1]!) as unknown);
    expect(displayed).toEqual(names);
    expect(result.stdout).not.toContain('\u202E');
    expect(result.stdout).not.toContain('Text response truncated');
    expect(result.stdout).not.toContain('Source selection:');
    expect(result.stdout).toContain(
      'End of verified results; repository inventory is complete.',
    );
  }, 20000);

  it('rejects a continuation from a previous search before any analysis starts', async () => {
    const { directory, revision } = await createGitRepository(
      Array.from({ length: 51 }, (_, index) => ({
        path: `f${String(index).padStart(2, '0')}.ts`,
        source: 'export function entry() {}\n',
      })),
      directories,
    );
    const running = startInvestigationCli(cliArgs(directory, revision));
    try {
      const first = await running.waitFor(/Cursor: ([A-Za-z0-9_-]+)/);
      running.child.stdin.end(`search f00\nnext ${first[1]}\nanalyze\n`);
      const result = await running.result;
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('ERROR[INVALID_CURSOR]');
      expect(result.stdout).not.toContain('Source selection:');
    } finally {
      await running.stop();
    }
  }, 20000);

  it('rejects control-character selections and absolute directory notation explicitly', async () => {
    const { directory, revision } = await createGitRepository(
      [{ path: 'entry.ts', source: 'export function entry() {}\n' }],
      directories,
    );
    for (const command of [
      `select ${JSON.stringify('line\nname.ts')}`,
      'select-module /',
    ]) {
      const result = await runInvestigationCli(
        cliArgs(directory, revision),
        command + '\nanalyze\n',
      );
      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(
        /ERROR\[(?:INVALID_SELECTION|INVALID_COMMAND)\]/,
      );
      expect(result.stdout).not.toContain('Source selection:');
    }
  }, 20000);

  it('returns exit 130 on a controlled SIGINT while waiting for source selection', async () => {
    const { directory, revision } = await createGitRepository(
      [{ path: 'entry.ts', source: 'export function entry() {}\n' }],
      directories,
    );
    const controlDirectory = await mkdtemp(
      resolve(tmpdir(), 'codethread-cli-control-'),
    );
    directories.push(controlDirectory);
    const control = resolve(controlDirectory, 'sigint.mjs');
    await writeFile(
      control,
      `const write = process.stdout.write.bind(process.stdout); let fired = false;
process.stdout.write = (chunk, ...args) => { const result = write(chunk, ...args);
if (!fired && String(chunk).includes('Inventory status:')) { fired = true; setImmediate(() => process.emit('SIGINT')); }
return result; };`,
    );
    const running = startInvestigationCli(cliArgs(directory, revision), {
      nodeArguments: ['--import', pathToFileURL(control).href],
    });
    try {
      const result = await running.result;
      expect(result.code).toBe(130);
      expect(result.stderr).toContain('ERROR[CANCELLED]');
      expect(result.stdout).not.toContain('Source selection:');
    } finally {
      await running.stop();
    }
  }, 20000);
});
