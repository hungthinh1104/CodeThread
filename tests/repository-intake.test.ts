import { rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireGitRepository } from '../scripts/git-source/repository-intake.ts';
import { createGitRepository, runGitFixture } from './helpers/git-fixture.ts';

const temporaryDirectories: string[] = [];
const repositoryId = '00000000-0000-4000-8000-000000000073';
afterEach(async () => {
  for (const path of temporaryDirectories.splice(0))
    await rm(path, { recursive: true, force: true });
});

describe('whole pinned Git repository intake', () => {
  it('acquires every regular .ts file and only required metadata from one commit', async () => {
    const sourceFiles = Array.from({ length: 25 }, (_, index) => ({
      path: `src/source${index}.ts`,
      source: `export function source${index}(){ return ${index}; }`,
    }));
    const repository = await createGitRepository(
      [
        ...sourceFiles,
        {
          path: 'tsconfig.json',
          source: '{"extends":"./config/base.json","include":["src"]}',
        },
        {
          path: 'config/base.json',
          source: '{"compilerOptions":{"target":"ES2023"}}',
        },
        {
          path: 'package.json',
          source: '{"scripts":{"prepare":"node should-never-run.js"}}',
        },
        { path: 'unrelated.json', source: '{"not":"compiler context"}' },
        {
          path: 'should-never-run.js',
          source: 'throw new Error("analyzed repository code ran");',
        },
      ],
      temporaryDirectories,
    );
    await writeFile(
      resolve(repository.directory, 'src/source0.ts'),
      'DIRTY CONTENT',
      'utf8',
    );
    const acquired = await acquireGitRepository({
      repositoryPath: repository.directory,
      repositoryId,
      revision: repository.revision,
    });
    expect(acquired.commitId).toBe(repository.revision);
    expect(acquired.inventory).toMatchObject({
      complete: true,
      sourceFiles: 25,
      metadataFiles: 3,
      excluded: [],
    });
    expect(acquired.files.map((file) => file.path).sort()).toEqual(
      sourceFiles.map((file) => file.path).sort(),
    );
    expect(
      new TextDecoder().decode(
        acquired.files.find((file) => file.path === 'src/source0.ts')!.bytes,
      ),
    ).toBe(sourceFiles[0]!.source);
    expect(acquired.metadata.map((file) => file.path)).toEqual([
      'config/base.json',
      'package.json',
      'tsconfig.json',
    ]);
    expect(acquired.statistics.blobReads).toBe(28);
  }, 30000);

  it('accounts for a committed symlink without following its target', async () => {
    const repository = await createGitRepository(
      [{ path: 'source.ts', source: 'export function source() {}' }],
      temporaryDirectories,
    );
    const link = (
      await runGitFixture(
        repository.directory,
        ['hash-object', '-w', '--stdin'],
        '../outside-secret.ts',
      )
    ).trim();
    await runGitFixture(repository.directory, [
      'update-index',
      '--add',
      '--cacheinfo',
      '120000',
      link,
      'escape.ts',
    ]);
    await runGitFixture(repository.directory, [
      '-c',
      'user.name=CodeThread Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'symlink as data',
    ]);
    const acquired = await acquireGitRepository({
      repositoryPath: repository.directory,
      repositoryId,
      revision: 'HEAD',
    });
    expect(acquired.files.map((file) => file.path)).toEqual(['source.ts']);
    expect(acquired.inventory.excluded).toEqual([
      { path: 'escape.ts', reason: 'symlink' },
    ]);
  }, 30000);

  it('refuses a silent subset when the whole source set exceeds 1000 files', async () => {
    const repository = await createGitRepository(
      Array.from({ length: 1001 }, (_, index) => ({
        path: `source${index}.ts`,
        source: 'export const value = 1;',
      })),
      temporaryDirectories,
    );
    await expect(
      acquireGitRepository({
        repositoryPath: repository.directory,
        repositoryId,
        revision: repository.revision,
      }),
    ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
  }, 30000);

  it('cancels before reading a repository', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      acquireGitRepository({
        repositoryPath: 'absent',
        repositoryId,
        revision: 'HEAD',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
