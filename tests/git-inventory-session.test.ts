import { createHash } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeManifest } from '@codethread/symbol-indexer';
import { createInvestigation } from '@codethread/trace-engine';
import { openGitInventory } from '../scripts/git-source.ts';
import { createViewer } from '../scripts/viewer.ts';
import {
  createGitRepository,
  runGitFixture,
  writeFixtureTree,
  commitFixtureTree,
} from './helpers/git-fixture.ts';

const directories: string[] = [];
const repositoryId = '00000000-0000-4000-8000-000000000022';
const open = (repositoryPath: string, revision: string) =>
  openGitInventory({ repositoryPath, repositoryId, revision });
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    if (dirname(directory) !== resolve(tmpdir()))
      throw new Error('Unexpected fixture cleanup target.');
    await rm(directory, { recursive: true, force: true });
  }
});

describe('pinned inventory session and source handoff', () => {
  it('keeps a moved branch and dirty worktree out of selected bytes, semantic evidence and the viewer', async () => {
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
    const session = await open(directory, branch);
    const beforeQueries = session.statistics();
    const page = session.query({ text: 'entry', prefix: 'src', limit: 1 });
    expect(page.items.map((item) => item.path)).toEqual(['src/entry.ts']);
    const plan = session.select({ directories: ['src'] });
    expect(session.statistics()).toEqual(beforeQueries);
    expect(beforeQueries.blobReads).toBe(0);
    expect(beforeQueries.commitReads).toBe(1);
    const blob = (
      await runGitFixture(
        directory,
        ['hash-object', '-w', '--stdin'],
        'export function other() {}\n',
      )
    ).trim();
    const tree = await writeFixtureTree(directory, [
      { mode: '100644', type: 'blob', oid: blob, name: 'other.ts' },
    ]);
    const nextCommit = await commitFixtureTree(directory, tree);
    await runGitFixture(directory, ['update-ref', branch, nextCommit]);
    await writeFile(
      resolve(directory, 'src/leaf.ts'),
      'DIRTY AND INVALID SOURCE\n',
    );
    const acquired = await session.acquire(plan);
    expect(acquired.provenance.commitId).toBe(revision);
    expect(session.inventory.commitId).toBe(revision);
    expect(
      acquired.input.files.map((file) => [
        file.path,
        Buffer.from(file.bytes).toString('utf8'),
      ]),
    ).toEqual([
      ['src/entry.ts', entry],
      ['src/leaf.ts', leaf],
    ]);
    expect(acquired.input.files[1]!.sha256).toBe(
      createHash('sha256').update(leaf).digest('hex'),
    );
    expect(session.statistics().commitReads).toBe(1);
    expect(session.statistics().treeReads).toBe(beforeQueries.treeReads);
    expect(session.statistics().subprocesses - beforeQueries.subprocesses).toBe(
      2,
    );
    const other = await open(directory, branch);
    expect(other.inventory.commitId).toBe(nextCommit);
    await expect(other.acquire(plan)).rejects.toMatchObject({
      code: 'INVENTORY_MISMATCH',
    });
    expect(other.statistics().blobReads).toBe(0);
    const snapshot = await analyzeManifest(acquired.input);
    const root = snapshot.facts.symbols.find(
      (symbol) => symbol.filePath === 'src/entry.ts',
    )!;
    const target = snapshot.facts.symbols.find(
      (symbol) => symbol.filePath === 'src/leaf.ts',
    )!;
    const investigation = createInvestigation(snapshot.facts, snapshot.source);
    const graph = investigation.neighbors({
      snapshotId: snapshot.facts.snapshotId,
      symbolId: root.id,
    });
    expect(graph.relations).toHaveLength(1);
    expect(graph.relations[0]).toMatchObject({
      kind: 'calls',
      resolution: { status: 'exact', targetId: target.id },
    });
    const evidenceIds = [
      graph.relations[0]!.siteEvidenceId,
      target.declarationEvidenceId,
    ];
    const evidence = investigation.sourceEvidence({
      snapshotId: snapshot.facts.snapshotId,
      evidenceIds,
    });
    expect(
      evidence.items.map((item) =>
        item.status === 'available' ? item.text : item.code,
      ),
    ).toEqual(['leaf()', 'export function leaf() { return 7; }']);
    const viewer = await createViewer(snapshot);
    try {
      const url = new URL(viewer.url);
      const token = url.hash.slice(1);
      const response = await fetch(url.origin + '/api/evidence', {
        method: 'POST',
        headers: {
          'X-CodeThread-Token': token,
          'Content-Type': 'application/json',
          Origin: url.origin,
        },
        body: JSON.stringify({
          snapshotId: snapshot.facts.snapshotId,
          evidenceIds,
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(evidence);
    } finally {
      await viewer.close();
    }
  }, 30000);

  it('paginates literal searches in byte order and rejects cursors for different queries, inventories or positions', async () => {
    const expected = [
      'src/a.ts',
      'src/bracket[1].ts',
      'src/nested/b.ts',
      'src/é.ts',
      'src/Ω.ts',
      'src/\u202Ename.ts',
    ];
    const { directory, revision } = await createGitRepository(
      [...expected, 'src2/a.ts'].map((path) => ({
        path,
        source: 'export function value() {}\n',
      })),
      directories,
    );
    const session = await open(directory, revision);
    const baseline = session.statistics();
    const first = session.query({ prefix: 'src', limit: 2 });
    expect(first.items.map((item) => item.path)).toEqual(expected.slice(0, 2));
    expect(first.appliedLimits.pageSize).toBe(2);
    expect(first.inventoryComplete).toBe(true);
    expect(
      session
        .query({ text: '[1]', prefix: 'src' })
        .items.map((item) => item.path),
    ).toEqual(['src/bracket[1].ts']);
    const paths = first.items.map((item) => item.path);
    let cursor = first.nextCursor;
    while (cursor !== null) {
      const page = session.query({ prefix: 'src', limit: 2, cursor });
      paths.push(...page.items.map((item) => item.path));
      cursor = page.nextCursor;
    }
    expect(paths).toEqual(expected);
    expect(
      session.query({ prefix: 'src', limit: 1, cursor: first.nextCursor! })
        .items[0]!.path,
    ).toBe(expected[2]);
    expect(
      session.query({ prefix: 'src', limit: 2, cursor: first.nextCursor! }),
    ).toEqual(
      session.query({ prefix: 'src', limit: 2, cursor: first.nextCursor! }),
    );
    for (const query of [
      { prefix: 'src2', cursor: first.nextCursor! },
      { prefix: 'src', text: 'a', cursor: first.nextCursor! },
      { prefix: 'src', cursor: first.nextCursor! + '=' },
      { cursor: '' },
      { cursor: 'not-a-cursor' },
    ])
      expect(() => session.query(query)).toThrow(
        expect.objectContaining({ code: 'INVALID_CURSOR' }),
      );
    const payload: unknown = JSON.parse(
      Buffer.from(first.nextCursor!, 'base64url').toString('utf8'),
    );
    if (payload === null || typeof payload !== 'object')
      throw new Error('Expected cursor payload.');
    const tampered = Buffer.from(
      JSON.stringify({ ...payload, after: 'src/absent.ts' }),
    ).toString('base64url');
    expect(() => session.query({ prefix: 'src', cursor: tampered })).toThrow(
      expect.objectContaining({ code: 'INVALID_CURSOR' }),
    );
    const limited = await openGitInventory({
      repositoryPath: directory,
      repositoryId,
      revision,
      limits: { files: 1 },
    });
    expect(() =>
      limited.query({ prefix: 'src', cursor: first.nextCursor! }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_CURSOR' }));
    for (const input of [
      { limit: 0 },
      { limit: 201 },
      { text: '' },
      { prefix: 'src/../x' },
      { unexpected: true },
    ])
      expect(() => session.query(input)).toThrow(
        expect.objectContaining({ code: 'INVALID_QUERY' }),
      );
    expect(session.statistics()).toEqual(baseline);
    expect(Object.isFrozen(session.inventory.files[0])).toBe(true);
    expect(Reflect.set(session.inventory.files[0]!, 'path', 'changed.ts')).toBe(
      false,
    );
  }, 20000);

  it('distinguishes no matches from unverified absence and rejects incomplete directory or partial plan admission', async () => {
    const { directory, revision } = await createGitRepository(
      [
        { path: 'src/a.ts', source: 'export function a() {}\n' },
        { path: 'src/b.ts', source: 'export function b() {}\n' },
      ],
      directories,
    );
    const partial = await openGitInventory({
      repositoryPath: directory,
      repositoryId,
      revision,
      limits: { files: 1 },
    });
    expect(partial.inventory.truncationReasons).toEqual(['file_limit']);
    expect(partial.query({ text: 'absent' })).toMatchObject({
      knownMatches: 0,
      searchComplete: false,
      endOfVerifiedResults: true,
      nextCursor: null,
    });
    expect(partial.lookup('src/b.ts')).toEqual({
      status: 'not_verified',
      code: 'INCOMPLETE_INVENTORY',
    });
    expect(() => partial.select({ paths: ['src/a.ts', 'src/b.ts'] })).toThrow(
      expect.objectContaining({ code: 'INCOMPLETE_INVENTORY' }),
    );
    expect(() => partial.select({ directories: ['src'] })).toThrow(
      expect.objectContaining({ code: 'INCOMPLETE_INVENTORY' }),
    );
    expect(partial.statistics().blobReads).toBe(0);
    const complete = await open(directory, revision);
    expect(complete.lookup('src/absent.ts')).toEqual({ status: 'not_found' });
    expect(complete.query({ text: 'absent' })).toMatchObject({
      searchComplete: true,
      knownMatches: 0,
    });
    const plan = complete.select({ directories: ['src'] });
    await expect(
      complete.acquire({ ...plan, selection: plan.selection.slice(0, 1) }),
    ).rejects.toMatchObject({ code: 'INVALID_SELECTION' });
    expect(complete.statistics().blobReads).toBe(0);
    expect(() => complete.select({ paths: ['src/a.ts', 'src/a.ts'] })).toThrow(
      expect.objectContaining({ code: 'INVALID_SELECTION' }),
    );
    const acquired = await partial.acquire(
      partial.select({ paths: ['src/a.ts'] }),
    );
    expect(acquired.input.files.map((file) => file.path)).toEqual(['src/a.ts']);
  }, 20000);

  it('rejects an oversized complete directory and keeps blob acquisition atomic', async () => {
    const { directory, revision } = await createGitRepository(
      Array.from({ length: 21 }, (_, index) => ({
        path: `src/f${String(index).padStart(2, '0')}.ts`,
        source: 'export function leaf() {}\n',
      })),
      directories,
    );
    const session = await open(directory, revision);
    expect(session.inventory.truncated).toBe(false);
    expect(() => session.select({ directories: ['src'] })).toThrow(
      expect.objectContaining({ code: 'RESOURCE_LIMIT' }),
    );
    expect(session.statistics().blobReads).toBe(0);
  });

  it('returns explicit partial inventory when the tree-entry traversal bound is reached', async () => {
    const { directory, revision } = await createGitRepository(
      [
        { path: 'a.ts', source: 'export function a() {}\n' },
        { path: 'b.ts', source: 'export function b() {}\n' },
      ],
      directories,
    );
    const session = await openGitInventory({
      repositoryPath: directory,
      repositoryId,
      revision,
      limits: { treeEntries: 1 },
    });

    expect(session.inventory).toMatchObject({
      truncated: true,
      truncationReasons: ['entry_limit'],
      counts: { treeEntries: 1 },
    });
    expect(session.query({ text: 'missing' })).toMatchObject({
      knownMatches: 0,
      searchComplete: false,
      endOfVerifiedResults: true,
    });
    expect(session.lookup('b.ts')).toEqual({
      status: 'not_verified',
      code: 'INCOMPLETE_INVENTORY',
    });
    expect(session.statistics().blobReads).toBe(0);
    expect(() => session.select({ directories: [''] })).toThrow(
      expect.objectContaining({ code: 'INCOMPLETE_INVENTORY' }),
    );
  });

  it('supports SHA-256 inventories and ignores caller mutation of discovery options', async () => {
    const { directory, revision } = await createGitRepository(
      [{ path: 'entry.ts', source: 'export function entry() {}\n' }],
      directories,
      'sha256',
    );
    const options = {
      repositoryPath: directory,
      repositoryId,
      revision,
      limits: { files: 1 },
    };
    const pending = openGitInventory(options);
    options.revision = 'missing';
    options.limits.files = 100000;
    const session = await pending;
    expect(session.inventory.commitId).toBe(revision);
    expect(session.inventory.commitId).toHaveLength(64);
    expect(session.inventory.objectFormat).toBe('sha256');
    expect(session.inventory.appliedLimits.files).toBe(1);
    const result = await session.acquire(
      session.select({ paths: ['entry.ts'] }),
    );
    expect(result.provenance.files[0]!.blobId).toHaveLength(64);
  }, 20000);
});
