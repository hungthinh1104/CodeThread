import { runInvestigationCli as runCli } from './helpers/investigation-cli.ts';
import {
  runGitFixture,
  createGitRepository,
  writeFixtureTree,
} from './helpers/git-fixture.ts';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeManifest } from '@codethread/symbol-indexer';
import { acquireGitSources } from '../scripts/git-source.ts';
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
describe('Git source CLI acquisition', () => {
  it('investigates explicitly selected committed source despite dirty working files', async () => {
    const { directory, revision } = await createCommittedRepository([
      {
        path: 'entry.ts',
        source:
          "import { helper } from './src/target';\nexport function root() { return helper(); }\n",
      },
      {
        path: 'src/target.ts',
        source: 'export function helper() { return 7; }\n',
      },
    ]);
    await writeFile(
      resolve(directory, 'entry.ts'),
      'export function poison() { return poisonTarget(); }\n',
      'utf8',
    );
    await writeFile(
      resolve(directory, 'src/target.ts'),
      'export function poisonTarget() {}\n',
      'utf8',
    );
    await runGitFixture(directory, ['add', '--', 'entry.ts', 'src/target.ts']);
    await runGitFixture(directory, [
      '-c',
      'user.name=CodeThread Test',
      '-c',
      'user.email=codethread-test@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'move branch away from pinned revision',
    ]);
    await writeFile(
      resolve(directory, 'entry.ts'),
      'export function dirtyWorkingTree() {}\n',
      'utf8',
    );

    const result = await runCli(
      [
        '--repo',
        directory,
        '--repository-id',
        '00000000-0000-4000-8000-000000000012',
        '--revision',
        revision,
        '--file',
        'entry.ts',
        '--file',
        'src/target.ts',
      ],
      'inspect entry.ts@2:1 calls outgoing\n',
    );
    const reordered = await runCli(
      [
        '--repo',
        directory,
        '--repository-id',
        '00000000-0000-4000-8000-000000000012',
        '--revision',
        revision,
        '--file',
        'src/target.ts',
        '--file',
        'entry.ts',
      ],
      'inspect entry.ts@2:1 calls outgoing\n',
    );
    const sourceFirst = await acquireGitSources({
        repositoryPath: directory,
        repositoryId: '00000000-0000-4000-8000-000000000012',
        revision,
        selectedPaths: ['entry.ts', 'src/target.ts'],
      }),
      sourceReordered = await acquireGitSources({
        repositoryPath: directory,
        repositoryId: '00000000-0000-4000-8000-000000000012',
        revision,
        selectedPaths: ['src/target.ts', 'entry.ts'],
      }),
      snapshotFirst = await analyzeManifest(sourceFirst.input),
      snapshotReordered = await analyzeManifest(sourceReordered.input);

    expect(result.code).toBe(0);
    expect(reordered.code).toBe(0);
    expect(reordered.stdout).toBe(result.stdout);
    expect(snapshotReordered.facts.identity).toEqual(
      snapshotFirst.facts.identity,
    );
    expect(snapshotReordered.facts.snapshotId).toBe(
      snapshotFirst.facts.snapshotId,
    );
    expect(snapshotReordered.facts.relations).toEqual(
      snapshotFirst.facts.relations,
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('2 selected, 2 admitted, 0 rejected');
    expect(result.stdout).toContain('[CALLS exact] outgoing');
    expect(result.stdout).toContain('"helper" (function)');
    expect(result.stdout).not.toContain('poison');
    expect(result.stdout).toContain('return 7;');
  }, 60_000);

  it('round-trips legal unusual Git paths through safe selectors', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'codethread-git-paths-'));
    temporaryDirectories.push(directory);
    await runGitFixture(directory, ['init', '--quiet']);
    const names = [
      '-leading.ts',
      'space name.ts',
      'quote"name.ts',
      'glob*[x].ts',
      'bidi\u202e.ts',
    ];
    const entries = [];
    for (const [index, name] of names.entries()) {
      const blob = (
        await runGitFixture(
          directory,
          ['hash-object', '-w', '--stdin'],
          `export function root${index}() { return ${index}; }\n`,
        )
      ).trim();
      entries.push({ mode: '100644', type: 'blob', oid: blob, name });
    }
    const tree = await writeFixtureTree(directory, entries),
      commit = (
        await runGitFixture(directory, [
          '-c',
          'user.name=CodeThread Test',
          '-c',
          'user.email=codethread-test@example.invalid',
          'commit-tree',
          tree,
          '-m',
          'unusual literal paths',
        ])
      ).trim();
    await runGitFixture(directory, ['update-ref', 'HEAD', commit]);
    const revision = (
        await runGitFixture(directory, ['rev-parse', 'HEAD'])
      ).trim(),
      inspectCommands = names.map((name) => {
        const selector = JSON.stringify(`${name}@1:1`).replaceAll(
          '\u202e',
          '\\u202e',
        );
        return `inspect ${selector} calls outgoing`;
      }),
      result = await runCli(
        [
          '--repo',
          directory,
          '--repository-id',
          '00000000-0000-4000-8000-000000000012',
          '--revision',
          revision,
          ...names.map((name) => `--file=${name}`),
        ],
        ['files', ...inspectCommands, 'quit', ''].join('\n'),
      );

    expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(
      '5 selected, 5 admitted, 0 rejected, 0 not admitted',
    );
    expect(result.stdout).toContain('"quote\\"name.ts"');
    expect(result.stdout).toContain('bidi\\u202e.ts');
    expect(result.stdout).toContain('glob*[x].ts');
    expect(result.stdout).toContain('"-leading.ts"');
    expect(result.stdout).not.toContain('\u202e');
    for (const index of names.keys())
      expect(result.stdout).toContain(`function "root${index}"`);
  }, 30_000);

  it('rejects unsafe revisions, missing files, and case-colliding selections atomically', async () => {
    const { directory, revision } = await createCommittedRepository([
      { path: 'safe.ts', source: 'export function safe() {}\n' },
    ]);
    const base = [
      '--repo',
      directory,
      '--repository-id',
      '00000000-0000-4000-8000-000000000012',
    ];
    const unsafeRevision = await runCli([
        ...base,
        '--revision',
        'HEAD~1',
        '--file',
        'safe.ts',
      ]),
      invalidQualifiedRef = await runCli([
        ...base,
        '--revision',
        'refs/heads/not..valid',
        '--file',
        'safe.ts',
      ]),
      duplicateRepositoryOption = await runCli([
        ...base,
        '--repo',
        directory,
        '--revision',
        revision,
        '--file',
        'safe.ts',
      ]),
      missingFile = await runCli([
        ...base,
        '--revision',
        revision,
        '--file',
        'missing.ts',
      ]),
      collision = await runCli([
        ...base,
        '--revision',
        revision,
        '--file',
        'safe.ts',
        '--file=SAFE.ts',
      ]);

    expect(unsafeRevision.code).toBe(2);
    expect(unsafeRevision.stderr).toContain('ERROR[INVALID_REVISION]');
    expect(unsafeRevision.stdout).not.toContain(
      'CodeThread textual investigation',
    );
    expect(invalidQualifiedRef.code).toBe(2);
    expect(invalidQualifiedRef.stderr).toContain('ERROR[INVALID_REVISION]');
    expect(invalidQualifiedRef.stdout).not.toContain(
      'CodeThread textual investigation',
    );
    expect(duplicateRepositoryOption.code).toBe(2);
    expect(duplicateRepositoryOption.stderr).toContain(
      'ERROR[INVALID_ARGUMENT]',
    );
    expect(missingFile.code).toBe(2);
    expect(missingFile.stderr).toContain('ERROR[FILE_NOT_FOUND]');
    expect(missingFile.stderr).toContain(
      '1 selected, 0 admitted, 1 rejected, 0 not admitted',
    );
    expect(missingFile.stdout).not.toContain(
      'CodeThread textual investigation',
    );
    expect(collision.code).toBe(2);
    expect(collision.stderr).toContain('ERROR[INVALID_SELECTION]');
    expect(collision.stderr).toContain(
      '2 selected, 0 admitted, 1 rejected, 1 not admitted',
    );
    expect(collision.stdout).not.toContain('CodeThread textual investigation');
  }, 60_000);

  it('rejects symlink and gitlink modes created through Git tree plumbing', async () => {
    const { directory, revision: parent } = await createCommittedRepository([
      { path: 'safe.ts', source: 'export function safe() {}\n' },
    ]);
    const safeBlob = (
        await runGitFixture(directory, ['rev-parse', `${parent}:safe.ts`])
      ).trim(),
      symlinkBlob = (
        await runGitFixture(
          directory,
          ['hash-object', '-w', '--stdin'],
          'safe.ts',
        )
      ).trim(),
      tree = await writeFixtureTree(directory, [
        { mode: '100644', type: 'blob', oid: safeBlob, name: 'safe.ts' },
        { mode: '120000', type: 'blob', oid: symlinkBlob, name: 'link.ts' },
        { mode: '160000', type: 'commit', oid: parent, name: 'submodule.ts' },
      ]),
      commit = (
        await runGitFixture(directory, [
          '-c',
          'user.name=CodeThread Test',
          '-c',
          'user.email=codethread-test@example.invalid',
          'commit-tree',
          tree,
          '-p',
          parent,
          '-m',
          'unsupported tree modes',
        ])
      ).trim();
    await runGitFixture(directory, ['update-ref', 'HEAD', commit]);

    for (const path of ['link.ts', 'submodule.ts']) {
      const result = await runCli([
        '--repo',
        directory,
        '--repository-id',
        '00000000-0000-4000-8000-000000000012',
        '--revision',
        commit,
        `--file=${path}`,
      ]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('ERROR[UNSUPPORTED_FILE_MODE]');
      expect(result.stderr).toContain(
        '1 selected, 0 admitted, 1 rejected, 0 not admitted',
      );
      expect(result.stdout).not.toContain('CodeThread textual investigation');
    }
  }, 30_000);

  it('ignores inherited Git overrides and never reads dirty source or executes configured filters', async () => {
    const { directory, revision } = await createCommittedRepository([
      {
        path: 'safe.ts',
        source: 'export function root() { return 3; }\n',
      },
      { path: '.gitattributes', source: '*.ts filter=codethread\n' },
    ]);
    await runGitFixture(directory, [
      'config',
      'filter.codethread.smudge',
      'codethread-filter-must-not-run',
    ]);
    await runGitFixture(directory, [
      'config',
      'core.hooksPath',
      resolve(directory, 'hooks-that-must-not-run'),
    ]);
    const foreign = await createCommittedRepository([
      { path: 'foreign.ts', source: 'export function poison() {}\n' },
    ]);
    await writeFile(
      resolve(directory, 'safe.ts'),
      'export function workingTreePoison() {}\n',
      'utf8',
    );
    const tracePath = resolve(directory, 'git-trace.log');
    const result = await runCli(
      [
        '--repo',
        directory,
        '--repository-id',
        '00000000-0000-4000-8000-000000000012',
        '--revision',
        revision,
        '--file',
        'safe.ts',
      ],
      'inspect safe.ts@1:1 calls outgoing\n',
      {
        GIT_DIR: resolve(foreign.directory, '.git'),
        GIT_WORK_TREE: foreign.directory,
        GIT_OBJECT_DIRECTORY: resolve(foreign.directory, '.git', 'objects'),
        GIT_TRACE: tracePath,
        GIT_NO_LAZY_FETCH: '0',
        GIT_NO_REPLACE_OBJECTS: '0',
      },
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Pinned Git commit:');
    expect(result.stdout).toContain('function "root"');
    expect(result.stdout).not.toContain('workingTreePoison');
    expect(result.stdout).not.toContain('poison');
    await expect(
      import('node:fs/promises').then(({ lstat }) => lstat(tracePath)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30_000);

  it('reports invalid committed UTF-8 with its source path and no partial session', async () => {
    const directory = await mkdtemp(
      resolve(tmpdir(), 'codethread-git-invalid-'),
    );
    temporaryDirectories.push(directory);
    await runGitFixture(directory, ['init', '--quiet']);
    const blob = (
      await runGitFixture(
        directory,
        ['hash-object', '-w', '--stdin'],
        Buffer.from([0xff, 0xfe]),
      )
    ).trim();
    const tree = await writeFixtureTree(directory, [
        { mode: '100644', type: 'blob', oid: blob, name: 'invalid.ts' },
      ]),
      commit = (
        await runGitFixture(directory, [
          '-c',
          'user.name=CodeThread Test',
          '-c',
          'user.email=codethread-test@example.invalid',
          'commit-tree',
          tree,
          '-m',
          'invalid UTF-8 fixture',
        ])
      ).trim();
    await runGitFixture(directory, ['update-ref', 'HEAD', commit]);
    const result = await runCli([
      '--repo',
      directory,
      '--repository-id',
      '00000000-0000-4000-8000-000000000012',
      '--revision',
      commit,
      '--file',
      'invalid.ts',
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('ERROR[INVALID_ENCODING]');
    expect(result.stderr).toContain('"invalid.ts": rejected');
    expect(result.stdout).not.toContain('CodeThread textual investigation');
  }, 30_000);

  it('attributes malformed committed source to its selected path', async () => {
    const malformed = await createCommittedRepository([
      { path: 'broken.ts', source: 'export function {\n' },
    ]);
    const result = await runCli([
      '--repo',
      malformed.directory,
      '--repository-id',
      '00000000-0000-4000-8000-000000000012',
      '--revision',
      malformed.revision,
      '--file',
      'broken.ts',
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('ERROR[MALFORMED_SOURCE]');
    expect(result.stderr).toContain('"broken.ts": rejected');
    expect(result.stdout).not.toContain('CodeThread textual investigation');
  }, 30_000);
});
