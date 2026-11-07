import { runInvestigationCli as runCli } from './helpers/investigation-cli.ts';
import {
  runGitFixture,
  createGitRepository,
  writeFixtureTree,
} from './helpers/git-fixture.ts';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireGitSources, GitSourceError } from '../scripts/git-source.ts';
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
describe('Git source CLI rejection and limits', () => {
  it('rejects invalid selections and pre-cancelled requests before probing a repository', async () => {
    const invalidPaths = [
      '../escape.ts',
      'folder\\unsafe.ts',
      'control\u0001.ts',
      String.fromCharCode(0xd800) + '.ts',
      'source.tsx',
      Array.from({ length: 65 }, () => 'd').join('/') + '/source.ts',
    ];
    for (const selectedPath of invalidPaths) {
      await expect(
        acquireGitSources({
          repositoryPath: 'no-such-repository',
          repositoryId: '00000000-0000-4000-8000-000000000012',
          revision: 'HEAD',
          selectedPaths: [selectedPath],
        }),
      ).rejects.toMatchObject({
        name: 'GitSourceError',
        code: 'INVALID_SELECTION',
      });
    }
    const controller = new AbortController();
    controller.abort();
    await expect(
      acquireGitSources({
        repositoryPath: 'no-such-repository',
        repositoryId: '00000000-0000-4000-8000-000000000012',
        revision: 'HEAD',
        selectedPaths: ['source.ts'],
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(GitSourceError);
    await expect(
      acquireGitSources({
        repositoryPath: 'no-such-repository',
        repositoryId: 'not-a-uuid',
        revision: 'HEAD',
        selectedPaths: ['source.ts'],
      }),
    ).rejects.toMatchObject({
      name: 'GitSourceError',
      code: 'INVALID_REPOSITORY_ID',
    });
    await expect(
      acquireGitSources({
        repositoryPath: 'no-such-repository',
        repositoryId: '00000000-0000-4000-8000-000000000012',
        revision: 'HEAD',
        selectedPaths: Array.from(
          { length: 21 },
          (_, index) => `file-${index}.ts`,
        ),
      }),
    ).rejects.toMatchObject({ name: 'GitSourceError', code: 'RESOURCE_LIMIT' });
  });

  it('returns typed missing and corrupt object failures without partial analysis', async () => {
    const missing = await createCommittedRepository([
        { path: 'source.ts', source: 'export function source() {}\n' },
      ]),
      missingBlob = (
        await runGitFixture(missing.directory, [
          'rev-parse',
          `${missing.revision}:source.ts`,
        ])
      ).trim();
    await runGitFixture(missing.directory, [
      'config',
      'extensions.partialClone',
      'origin',
    ]);
    await runGitFixture(missing.directory, [
      'config',
      'remote.origin.promisor',
      'true',
    ]);
    await runGitFixture(missing.directory, [
      'config',
      'remote.origin.url',
      'https://invalid.invalid/codethread-no-fetch-test.git',
    ]);
    await rm(
      resolve(
        missing.directory,
        '.git',
        'objects',
        missingBlob.slice(0, 2),
        missingBlob.slice(2),
      ),
    );
    const missingResult = await runCli([
      '--repo',
      missing.directory,
      '--repository-id',
      '00000000-0000-4000-8000-000000000012',
      '--revision',
      missing.revision,
      '--file',
      'source.ts',
    ]);

    const corrupt = await createCommittedRepository([
        { path: 'source.ts', source: 'export function source() {}\n' },
      ]),
      corruptBlob = (
        await runGitFixture(corrupt.directory, [
          'rev-parse',
          `${corrupt.revision}:source.ts`,
        ])
      ).trim();
    const corruptObjectPath = resolve(
      corrupt.directory,
      '.git',
      'objects',
      corruptBlob.slice(0, 2),
      corruptBlob.slice(2),
    );
    await chmod(corruptObjectPath, 0o644);
    await writeFile(corruptObjectPath, Buffer.from('damaged loose object'));
    const corruptResult = await runCli([
      '--repo',
      corrupt.directory,
      '--repository-id',
      '00000000-0000-4000-8000-000000000012',
      '--revision',
      corrupt.revision,
      '--file',
      'source.ts',
    ]);
    expect(missingResult.code).toBe(2);
    expect(missingResult.stderr).toContain('ERROR[MISSING_OBJECT]');
    expect(missingResult.stdout).not.toContain(
      'CodeThread textual investigation',
    );
    expect(corruptResult.code).toBe(2);
    expect(corruptResult.stderr).toContain('ERROR[CORRUPT_OBJECT]');
    expect(corruptResult.stdout).not.toContain(
      'CodeThread textual investigation',
    );
  }, 40_000);

  it('enforces the per-file object limit before retaining source bytes', async () => {
    const oversized = await createCommittedRepository([
      { path: 'large.ts', source: 'x'.repeat(256 * 1024 + 1) },
    ]);
    const result = await runCli([
      '--repo',
      oversized.directory,
      '--repository-id',
      '00000000-0000-4000-8000-000000000012',
      '--revision',
      oversized.revision,
      '--file',
      'large.ts',
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('ERROR[RESOURCE_LIMIT]');
    expect(result.stderr).toContain('"large.ts": rejected');
    expect(result.stdout).not.toContain('CodeThread textual investigation');
  }, 30_000);

  it('enforces the selected-tree entry limit before starting analysis', async () => {
    const directory = await mkdtemp(
      resolve(tmpdir(), 'codethread-git-tree-limit-'),
    );
    temporaryDirectories.push(directory);
    await runGitFixture(directory, ['init', '--quiet']);
    const blob = (
        await runGitFixture(
          directory,
          ['hash-object', '-w', '--stdin'],
          'export function selected() {}\n',
        )
      ).trim(),
      entries = Array.from({ length: 10_001 }, (_, index) => ({
        mode: '100644',
        type: 'blob',
        oid: blob,
        name: `file-${String(index).padStart(5, '0')}.ts`,
      })),
      tree = await writeFixtureTree(directory, entries),
      commit = (
        await runGitFixture(directory, [
          '-c',
          'user.name=CodeThread Test',
          '-c',
          'user.email=codethread-test@example.invalid',
          'commit-tree',
          tree,
          '-m',
          'tree entry resource boundary',
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
      'file-00000.ts',
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('ERROR[RESOURCE_LIMIT]');
    expect(result.stdout).not.toContain('CodeThread textual investigation');
  }, 40_000);

  it('rejects bare repositories and linked worktrees explicitly', async () => {
    const bare = await mkdtemp(resolve(tmpdir(), 'codethread-git-bare-'));
    temporaryDirectories.push(bare);
    await runGitFixture(bare, ['init', '--bare', '--quiet']);
    const bareResult = await runCli([
      '--repo',
      bare,
      '--repository-id',
      '00000000-0000-4000-8000-000000000012',
      '--revision',
      'HEAD',
      '--file',
      'source.ts',
    ]);
    expect(bareResult.code).toBe(2);
    expect(bareResult.stderr).toContain('ERROR[UNSUPPORTED_REPOSITORY_LAYOUT]');

    const repository = await createCommittedRepository([
        { path: 'source.ts', source: 'export function source() {}\n' },
      ]),
      linked = await mkdtemp(resolve(tmpdir(), 'codethread-git-linked-'));
    temporaryDirectories.push(linked);
    await rm(linked, { recursive: true, force: true });
    await runGitFixture(repository.directory, [
      'worktree',
      'add',
      '--detach',
      linked,
      repository.revision,
    ]);
    const linkedResult = await runCli([
      '--repo',
      linked,
      '--repository-id',
      '00000000-0000-4000-8000-000000000012',
      '--revision',
      repository.revision,
      '--file',
      'source.ts',
    ]);
    expect(linkedResult.code).toBe(2);
    expect(linkedResult.stderr).toContain(
      'ERROR[UNSUPPORTED_REPOSITORY_LAYOUT]',
    );
    expect(linkedResult.stderr).toContain(
      '1 selected, 0 admitted, 0 rejected, 1 not admitted',
    );

    const alternate = await createCommittedRepository([
      { path: 'source.ts', source: 'export function source() {}\n' },
    ]);
    await mkdir(resolve(alternate.directory, '.git', 'objects', 'info'), {
      recursive: true,
    });
    await writeFile(
      resolve(alternate.directory, '.git', 'objects', 'info', 'alternates'),
      'outside-object-store\n',
      'utf8',
    );
    const alternateResult = await runCli([
      '--repo',
      alternate.directory,
      '--repository-id',
      '00000000-0000-4000-8000-000000000012',
      '--revision',
      alternate.revision,
      '--file',
      'source.ts',
    ]);
    expect(alternateResult.code).toBe(2);
    expect(alternateResult.stderr).toContain(
      'ERROR[UNSUPPORTED_REPOSITORY_LAYOUT]',
    );
  }, 30_000);

  it('accepts the exact two-MiB source boundary and rejects one additional byte', async () => {
    const maxFileBytes = 256 * 1024,
      prefix = 'export function root() {}/*',
      suffix = '*/',
      exactFile =
        prefix +
        'x'.repeat(maxFileBytes - prefix.length - suffix.length) +
        suffix,
      files = Array.from({ length: 8 }, (_, index) => ({
        path: `file-${index}.ts`,
        source: exactFile,
      }));
    files.push({ path: 'zz-extra.ts', source: 'export function extra() {}\n' });
    const repository = await createCommittedRepository(files),
      common = [
        '--repo',
        repository.directory,
        '--repository-id',
        '00000000-0000-4000-8000-000000000012',
        '--revision',
        repository.revision,
      ],
      exact = await runCli([
        ...common,
        ...files.slice(0, 8).flatMap((file) => ['--file', file.path]),
      ]),
      over = await runCli([
        ...common,
        ...files.flatMap((file) => ['--file', file.path]),
      ]);
    expect(exact.code).toBe(0);
    expect(exact.stdout).toContain(
      '8 selected, 8 admitted, 0 rejected, 0 not admitted',
    );
    expect(over.code).toBe(2);
    expect(over.stderr).toContain('ERROR[RESOURCE_LIMIT]');
    expect(over.stderr).toContain(
      '9 selected, 0 admitted, 1 rejected, 8 not admitted',
    );
    expect(over.stdout).not.toContain('CodeThread textual investigation');
  }, 60_000);
});
