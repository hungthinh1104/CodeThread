import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverGitFiles } from '../scripts/git-source.ts';
import { createGitRepository, runGitFixture } from './helpers/git-fixture.ts';

const directories: string[] = [];
const repositoryId = '00000000-0000-4000-8000-000000000022';

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    if (dirname(directory) !== resolve(tmpdir()))
      throw new Error('Unexpected fixture cleanup target.');
    await rm(directory, { recursive: true, force: true });
  }
});

async function commitTree(directory: string, treeId: string): Promise<string> {
  return (
    await runGitFixture(directory, [
      '-c',
      'user.name=CodeThread Test',
      '-c',
      'user.email=codethread-test@example.invalid',
      'commit-tree',
      treeId,
      '-m',
      'inventory fixture',
    ])
  ).trim();
}

describe('verified Git inventory identity', () => {
  it('preserves filename BOM bytes instead of merging two distinct Git paths', async () => {
    const { directory } = await createGitRepository(
      [{ path: 'entry.ts', source: 'export function entry() {}\n' }],
      directories,
    );
    const blob = (
      await runGitFixture(directory, ['rev-parse', 'HEAD:entry.ts'])
    ).trim();
    const tree = (
      await runGitFixture(
        directory,
        ['mktree', '-z'],
        Buffer.from(
          `100644 blob ${blob}\tname.ts\0` +
            `100644 blob ${blob}\t\uFEFFname.ts\0`,
        ),
      )
    ).trim();
    const inventory = await discoverGitFiles({
      repositoryPath: directory,
      repositoryId,
      revision: await commitTree(directory, tree),
    });
    expect(inventory.files.map((file) => file.path)).toEqual([
      'name.ts',
      '\uFEFFname.ts',
    ]);
  });

  it('rejects non-ASCII mode bytes even when ASCII masking would spell a regular mode', async () => {
    const { directory } = await createGitRepository(
      [{ path: 'entry.ts', source: 'export function entry() {}\n' }],
      directories,
    );
    const blob = (
      await runGitFixture(directory, ['rev-parse', 'HEAD:entry.ts'])
    ).trim();
    const rawTree = Buffer.concat([
      Buffer.from([0xb1, 0xb0, 0xb0, 0xb6, 0xb4, 0xb4]),
      Buffer.from(' entry.ts\0'),
      Buffer.from(blob, 'hex'),
    ]);
    const tree = (
      await runGitFixture(
        directory,
        ['hash-object', '--literally', '-w', '-t', 'tree', '--stdin'],
        rawTree,
      )
    ).trim();
    await expect(
      discoverGitFiles({
        repositoryPath: directory,
        repositoryId,
        revision: await commitTree(directory, tree),
      }),
    ).rejects.toMatchObject({ code: 'CORRUPT_OBJECT' });
  });
});
