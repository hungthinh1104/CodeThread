import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { openGitInventory } from '../scripts/git-source.ts';
import {
  createGitRepository,
  runGitFixture,
  writeFixtureTree,
  commitFixtureTree,
} from './helpers/git-fixture.ts';

const directories: string[] = [];
const repositoryId = '00000000-0000-4000-8000-000000000022';
const source = 'export function entry() {}\n';
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    if (dirname(directory) !== resolve(tmpdir()))
      throw new Error('Unexpected cleanup target.');
    await rm(directory, { recursive: true, force: true });
  }
});
const fixture = () =>
  createGitRepository([{ path: 'entry.ts', source }], directories);
const blobId = async (directory: string) =>
  (await runGitFixture(directory, ['rev-parse', 'HEAD:entry.ts'])).trim();
const open = (repositoryPath: string, revision: string) =>
  openGitInventory({ repositoryPath, repositoryId, revision });
const objectPath = (directory: string, oid: string) =>
  resolve(directory, '.git/objects', oid.slice(0, 2), oid.slice(2));

async function rawTree(directory: string, bytes: Buffer): Promise<string> {
  return (
    await runGitFixture(
      directory,
      ['hash-object', '--literally', '-w', '-t', 'tree', '--stdin'],
      bytes,
    )
  ).trim();
}
function treeEntry(mode: string, name: Buffer, oid: string): Buffer {
  return Buffer.concat([
    Buffer.from(mode + ' '),
    name,
    Buffer.from([0]),
    Buffer.from(oid, 'hex'),
  ]);
}

async function sizedTree(
  directory: string,
  oid: string,
  bytes: number,
  count: number,
  tag: string,
): Promise<string> {
  const baseBytes = 39 * count;
  const padding = Math.floor((bytes - baseBytes) / count);
  const extra = bytes - baseBytes - padding * count;
  if (padding < 0 || tag.length !== 2)
    throw new Error('Invalid sized-tree fixture.');
  const entries = Array.from({ length: count }, (_, index) => ({
    mode: '100644',
    type: 'blob',
    oid,
    name: `${tag}-${String(index).padStart(4, '0')}-${'x'.repeat(padding + (index < extra ? 1 : 0))}.md`,
  }));
  const tree = await writeFixtureTree(directory, entries);
  expect(Number(await runGitFixture(directory, ['cat-file', '-s', tree]))).toBe(
    bytes,
  );
  return tree;
}

describe('adversarial inventory paths and Git objects', () => {
  it('retains exact safe names, reports unsupported byte names and rejects nonregular/case-colliding selections', async () => {
    const { directory } = await fixture(),
      oid = await blobId(directory);
    const safe = [
      '-leading.ts',
      'a space.ts',
      'quote".ts',
      '[*].ts',
      'é.ts',
      '\u202Edisplay.ts',
      'A.ts',
      'a.ts',
    ];
    const records = safe.map((name) =>
      treeEntry('100644', Buffer.from(name), oid),
    );
    const unsafe = [
      Buffer.from('tab\tname.ts'),
      Buffer.from('line\nname.ts'),
      Buffer.from('back\\name.ts'),
      Buffer.from([0xff, 0x2e, 0x74, 0x73]),
    ];
    records.push(...unsafe.map((name) => treeEntry('100644', name, oid)));
    records.push(treeEntry('120000', Buffer.from('link.ts'), oid));
    const commit = (
      await runGitFixture(directory, ['rev-parse', 'HEAD'])
    ).trim();
    records.push(treeEntry('160000', Buffer.from('submodule'), commit));
    const session = await open(
      directory,
      await commitFixtureTree(
        directory,
        await rawTree(directory, Buffer.concat(records)),
      ),
    );
    expect(session.inventory.truncationReasons).toContain('unsupported_paths');
    expect(session.inventory.counts.unsupportedPaths).toBe(4);
    expect(
      session.inventory.unsupportedPaths.find(
        (item) => item.reason === 'invalid_utf8',
      )!.nameBytesHex,
    ).toBe('ff2e7473');
    expect(session.lookup('submodule/entry.ts')).toEqual({
      status: 'unsupported',
      code: 'UNSUPPORTED_FILE_MODE',
    });
    expect(session.lookup('link.ts')).toEqual({
      status: 'unsupported',
      code: 'UNSUPPORTED_FILE_MODE',
    });
    for (const name of safe) expect(session.lookup(name).status).toBe('found');
    expect(() => session.select({ paths: ['A.ts', 'a.ts'] })).toThrow(
      expect.objectContaining({ code: 'INVALID_SELECTION' }),
    );
    expect(() => session.select({ paths: ['link.ts'] })).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_FILE_MODE' }),
    );
    expect(() => session.select({ directories: [''] })).toThrow(
      expect.objectContaining({ code: 'INCOMPLETE_INVENTORY' }),
    );
    expect(session.statistics().blobReads).toBe(0);
  }, 20000);

  it('rejects malformed framing, duplicate or escaping entry names and unsupported modes from real raw tree objects', async () => {
    const { directory } = await fixture(),
      oid = await blobId(directory);
    const entry = treeEntry('100644', Buffer.from('entry.ts'), oid);
    const malformed = [
      entry.subarray(0, entry.length - 1),
      Buffer.from('100644 entry.ts'),
      Buffer.concat([entry, entry]),
      treeEntry('100644', Buffer.from('..'), oid),
      treeEntry('100644', Buffer.from('a/b.ts'), oid),
      treeEntry('100600', Buffer.from('entry.ts'), oid),
    ];
    for (const body of malformed) {
      const revision = await commitFixtureTree(
        directory,
        await rawTree(directory, body),
      );
      await expect(open(directory, revision)).rejects.toMatchObject({
        code: 'CORRUPT_OBJECT',
      });
    }
  }, 30000);

  it('fails closed for missing/corrupt trees, wrong child types and mismatched object identities', async () => {
    const { directory, revision } = await fixture(),
      oid = await blobId(directory);
    const wrongChild = await rawTree(
      directory,
      treeEntry('40000', Buffer.from('src'), oid),
    );
    await expect(
      open(directory, await commitFixtureTree(directory, wrongChild)),
    ).rejects.toMatchObject({ code: 'CORRUPT_OBJECT' });
    const rootTree = (
      await runGitFixture(directory, ['rev-parse', `${revision}^{tree}`])
    ).trim();
    const original = await readFile(objectPath(directory, rootTree));
    await rm(objectPath(directory, rootTree));
    await expect(open(directory, revision)).rejects.toMatchObject({
      code: 'MISSING_OBJECT',
    });
    await writeFile(
      objectPath(directory, rootTree),
      Buffer.from('not a Git zlib object'),
    );
    await expect(open(directory, revision)).rejects.toMatchObject({
      code: 'CORRUPT_OBJECT',
    });
    await writeFile(objectPath(directory, rootTree), original);
    const otherTree = await writeFixtureTree(directory, [
      { mode: '100644', type: 'blob', oid, name: 'other.ts' },
    ]);
    await writeFile(
      objectPath(directory, rootTree),
      await readFile(objectPath(directory, otherTree)),
    );
    await expect(open(directory, revision)).rejects.toMatchObject({
      code: 'CORRUPT_OBJECT',
    });
  }, 30000);

  it('does not read an unavailable source blob during inventory and can retry acquisition after the exact object is restored', async () => {
    const { directory, revision } = await fixture(),
      oid = await blobId(directory);
    const location = objectPath(directory, oid),
      original = await readFile(location);
    await rm(location);
    const session = await open(directory, revision),
      plan = session.select({ paths: ['entry.ts'] });
    expect(session.inventory.truncated).toBe(false);
    expect(session.statistics().blobReads).toBe(0);
    await expect(session.acquire(plan)).rejects.toMatchObject({
      code: 'MISSING_OBJECT',
    });
    await writeFile(location, original);
    const acquired = await session.acquire(plan);
    expect(Buffer.from(acquired.input.files[0]!.bytes).toString('utf8')).toBe(
      source,
    );
    const alternate = (
      await runGitFixture(
        directory,
        ['hash-object', '-w', '--stdin'],
        'export function other() {}\n',
      )
    ).trim();
    await writeFile(location, await readFile(objectPath(directory, alternate)));
    await expect(session.acquire(plan)).rejects.toMatchObject({
      code: 'CORRUPT_OBJECT',
    });
  }, 20000);

  it('never lazily fetches missing promisor objects or executes a configured remote helper', async () => {
    const { directory, revision } = await fixture(),
      oid = await blobId(directory);
    const helperDirectory = await mkdtemp(
      resolve(tmpdir(), 'codethread-remote-helper-'),
    );
    directories.push(helperDirectory);
    const marker = resolve(helperDirectory, 'remote-executed');
    const helper = resolve(helperDirectory, 'controlled-helper.mjs');
    await writeFile(
      helper,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'attempted'); process.exit(9);`,
    );
    const extArgument = (value: string) =>
      value.replaceAll('%', '%%').replaceAll(' ', '% ');
    const remote = `ext::${extArgument(process.execPath)} ${extArgument(helper)}`;
    // Prove the trusted trap executes when explicitly invoked, then reset it.
    await expect(
      runGitFixture(directory, [
        '-c',
        'protocol.ext.allow=always',
        'ls-remote',
        remote,
      ]),
    ).rejects.toThrow();
    expect(await readFile(marker, 'utf8')).toBe('attempted');
    await rm(marker);
    await runGitFixture(directory, [
      'config',
      'remote.origin.promisor',
      'true',
    ]);
    await runGitFixture(directory, ['config', 'remote.origin.url', remote]);
    await runGitFixture(directory, ['config', 'protocol.ext.allow', 'always']);
    await rm(objectPath(directory, oid));
    const session = await open(directory, revision);
    await expect(
      session.acquire(session.select({ paths: ['entry.ts'] })),
    ).rejects.toMatchObject({ code: 'MISSING_OBJECT' });
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(session.statistics().blobReads).toBe(0);
  }, 20000);
});

describe('inventory safety bounds', () => {
  it('bounds unique trees and path depth without converting unknown paths into not-found', async () => {
    const { directory } = await fixture(),
      oid = await blobId(directory);
    const left = await writeFixtureTree(directory, [
      { mode: '100644', type: 'blob', oid, name: 'a.ts' },
    ]);
    const right = await writeFixtureTree(directory, [
      { mode: '100644', type: 'blob', oid, name: 'b.ts' },
    ]);
    const root = await writeFixtureTree(directory, [
      { mode: '40000', type: 'tree', oid: left, name: 'a' },
      { mode: '40000', type: 'tree', oid: right, name: 'b' },
    ]);
    const revision = await commitFixtureTree(directory, root);
    const treeLimited = await openGitInventory({
      repositoryPath: directory,
      repositoryId,
      revision,
      limits: { trees: 2 },
    });
    expect(treeLimited.inventory.truncationReasons).toEqual(['tree_limit']);
    expect(treeLimited.inventory.counts.uniqueTrees).toBe(2);
    expect(treeLimited.lookup('b/b.ts')).toEqual({
      status: 'not_verified',
      code: 'INCOMPLETE_INVENTORY',
    });
    const depthLimited = await openGitInventory({
      repositoryPath: directory,
      repositoryId,
      revision,
      limits: { pathComponents: 1 },
    });
    expect(depthLimited.inventory.truncationReasons).toEqual(['path_limit']);
    expect(depthLimited.inventory.counts.uniqueTrees).toBe(1);
    for (const limits of [
      { trees: 129 },
      { files: 1001 },
      { deadlineMs: 10001 },
      { files: 0 },
      { metadataBytes: Number.NaN },
    ])
      await expect(
        openGitInventory({
          repositoryPath: directory,
          repositoryId,
          revision,
          limits,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_DISCOVERY_REQUEST' });
  }, 20000);

  it('accepts the exact tree-entry bound and marks a larger inventory incomplete', async () => {
    const { directory } = await fixture(),
      oid = await blobId(directory);
    for (const count of [10000, 10001]) {
      const tree = await writeFixtureTree(
        directory,
        Array.from({ length: count }, (_, index) => ({
          mode: '100644',
          type: 'blob',
          oid,
          name: `f${String(index).padStart(5, '0')}.md`,
        })),
      );
      const request = open(directory, await commitFixtureTree(directory, tree));
      if (count === 10000)
        expect((await request).inventory).toMatchObject({
          truncated: false,
          counts: { treeEntries: 10000 },
        });
      else
        expect((await request).inventory).toMatchObject({
          truncated: true,
          truncationReasons: ['entry_limit'],
          counts: { treeEntries: 10000 },
        });
    }
  }, 30000);

  it('checks the one-MiB metadata-object boundary before retaining an oversized object', async () => {
    const { directory } = await fixture(),
      oid = await blobId(directory);
    for (const bytes of [1048576, 1048577]) {
      const tree = await sizedTree(directory, oid, bytes, 2000, '00');
      const request = open(directory, await commitFixtureTree(directory, tree));
      if (bytes === 1048576)
        expect((await request).inventory.truncated).toBe(false);
      else
        await expect(request).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
    }
  }, 30000);

  it('enforces cumulative four-MiB metadata across commit and distinct verified trees', async () => {
    const { directory } = await fixture(),
      oid = await blobId(directory);
    const trees: string[] = [];
    for (let index = 0; index < 7; index++)
      trees.push(
        await sizedTree(
          directory,
          oid,
          524288,
          1024,
          String(index).padStart(2, '0'),
        ),
      );
    const entries = (last: string) =>
      [...trees, last].map((tree, index) => ({
        mode: '40000',
        type: 'tree',
        oid: tree,
        name: `t${index}`,
      }));
    const sampleTree = await writeFixtureTree(directory, entries(trees[0]!));
    const sampleCommit = await commitFixtureTree(directory, sampleTree);
    const overhead =
      Number(await runGitFixture(directory, ['cat-file', '-s', sampleTree])) +
      Number(await runGitFixture(directory, ['cat-file', '-s', sampleCommit]));
    for (const overflow of [0, 1]) {
      const last = await sizedTree(
        directory,
        oid,
        524288 - overhead + overflow,
        1024,
        '07',
      );
      const tree = await writeFixtureTree(directory, entries(last)),
        revision = await commitFixtureTree(directory, tree);
      const request = open(directory, revision);
      if (overflow === 0) {
        const session = await request;
        expect(session.inventory.truncated).toBe(false);
        expect(session.statistics().metadataBytes).toBe(4 * 1024 * 1024);
      } else
        await expect(request).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
    }
  }, 30000);
});
