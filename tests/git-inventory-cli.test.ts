import {
  runGitFixture,
  createGitRepository,
  writeFixtureTree,
} from './helpers/git-fixture.ts';
import { rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireGitSources, discoverGitFiles } from '../scripts/git-source.ts';
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
describe('pinned Git source discovery', () => {
  it('lists only committed TypeScript paths from the resolved tree in byte order', async () => {
    const { directory, revision } = await createCommittedRepository([
      { path: 'src/zeta.ts', source: 'export function zeta() {}\n' },
      { path: 'src/a space.ts', source: 'export function alpha() {}\n' },
      { path: 'README.md', source: 'working tree metadata only\n' },
    ]);
    await writeFile(resolve(directory, 'src/dirty.ts'), 'dirty\n', 'utf8');

    const inventory = await discoverGitFiles({
      repositoryPath: directory,
      repositoryId: '00000000-0000-4000-8000-000000000012',
      revision: 'HEAD',
    });

    expect(inventory).toMatchObject({
      commitId: revision,
      truncated: false,
      files: [
        { path: 'src/a space.ts', mode: '100644' },
        { path: 'src/zeta.ts', mode: '100644' },
      ],
    });
  });

  it('does not read source blobs until an explicit selection is acquired', async () => {
    const { directory, revision } = await createCommittedRepository([
      { path: 'src/missing.ts', source: 'export function retained() {}\n' },
    ]);
    const blobId = (
      await runGitFixture(directory, [
        'rev-parse',
        `${revision}:src/missing.ts`,
      ])
    ).trim();
    await rm(
      resolve(
        directory,
        '.git',
        'objects',
        blobId.slice(0, 2),
        blobId.slice(2),
      ),
      { force: true },
    );

    const inventory = await discoverGitFiles({
      repositoryPath: directory,
      repositoryId: '00000000-0000-4000-8000-000000000012',
      revision,
    });
    expect(inventory.files).toEqual([
      { path: 'src/missing.ts', mode: '100644' },
    ]);
    await expect(
      acquireGitSources({
        repositoryPath: directory,
        repositoryId: '00000000-0000-4000-8000-000000000012',
        revision: inventory.commitId,
        selectedPaths: ['src/missing.ts'],
      }),
    ).rejects.toMatchObject({ code: 'MISSING_OBJECT' });
  });

  it('bounds repeated traversal of shared tree objects and reports truncation', async () => {
    const { directory } = await createCommittedRepository([
      { path: 'placeholder.ts', source: 'export function placeholder() {}\n' },
    ]);
    let repeatedTree = await writeFixtureTree(directory, []);
    for (let depth = 0; depth < 13; depth++)
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
        'shared subtree fixture',
      ])
    ).trim();

    const inventory = await discoverGitFiles({
      repositoryPath: directory,
      repositoryId: '00000000-0000-4000-8000-000000000012',
      revision: commit,
    });

    expect(inventory.files).toEqual([]);
    expect(inventory.truncated).toBe(true);
    expect(inventory.truncationReasons).toContain('tree_visit_limit');
    expect(inventory.appliedLimits.treeVisits).toBe(4096);
  });
});
