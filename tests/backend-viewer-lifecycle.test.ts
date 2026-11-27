import { createHash } from 'node:crypto';
import { analyzeManifest, COMPILER_PROFILE } from '@codethread/symbol-indexer';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../scripts/backend/database.ts';
import { PersistentViewerManager } from '../scripts/backend/viewer-adapter.ts';

const loadState = vi.hoisted(() => ({
  session: null as unknown,
  gate: null as Promise<void> | null,
}));

vi.mock('../scripts/backend/session-persistence.ts', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../scripts/backend/session-persistence.ts')
    >();
  return {
    ...actual,
    loadRepositorySession: async () => {
      if (loadState.gate) await loadState.gate;
      return loadState.session;
    },
  };
});

async function makeSession(repositoryId: string) {
  const bytes = Buffer.from('export function entry() { return 1; }');
  const snapshot = await analyzeManifest({
    repositoryId,
    compilerOptions: COMPILER_PROFILE,
    files: [
      {
        path: 'src/entry.ts',
        bytes,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    ],
  });
  return {
    repositoryId,
    commitId: 'a'.repeat(40),
    objectFormat: 'sha1' as const,
    inventory: {
      complete: true,
      sourceFiles: 1,
      sourceBytes: bytes.length,
      metadataFiles: 0,
      excluded: [],
    },
    files: [
      {
        path: 'src/entry.ts',
        sha256: snapshot.facts.files[0]!.contentHash,
        blobId: 'b'.repeat(40),
        byteLength: bytes.length,
        status: 'analyzed' as const,
        projectIds: ['project:1'],
      },
    ],
    projects: [
      {
        project: {
          id: 'project:1',
          configPath: null,
          rootPaths: ['src/entry.ts'],
          referencePaths: [],
          status: 'ready' as const,
          diagnostics: [],
        },
        status: 'ready' as const,
        snapshot,
      },
    ],
    diagnostics: [],
    sourceCoverageComplete: true,
    analysisComplete: true,
    contextComplete: true,
    metrics: {
      acquisitionMs: 0,
      totalMs: 0,
      resultBytes: 0,
      memberships: 1,
      contextSourceBytes: bytes.length,
      parentPeakRssBytes: 0,
      git: {
        subprocesses: 0,
        metadataChecks: 0,
        commitReads: 0,
        treeReads: 0,
        blobReads: 1,
        metadataBytes: 0,
        blobBytes: bytes.length,
      },
    },
  };
}

describe('PersistentViewerManager lifecycle guards', () => {
  it('closes and evicts a cached viewer when its scan has been purged by retention', async () => {
    const retained = new Set<string>([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
      '55555555-5555-4555-8555-555555555555',
    ]);
    const db = ((_strings: TemplateStringsArray, scanId: string) =>
      Promise.resolve(
        retained.has(scanId) ? [{ id: scanId }] : [],
      )) as unknown as Database;
    loadState.session = await makeSession(
      '00000000-0000-4000-8000-000000000091',
    );
    loadState.gate = null;
    const manager = new PersistentViewerManager(db);
    try {
      const first = await manager.open('11111111-1111-4111-8111-111111111111');
      await manager.open('22222222-2222-4222-8222-222222222222');
      await manager.open('33333333-3333-4333-8333-333333333333');
      await manager.open('44444444-4444-4444-8444-444444444444');

      retained.delete('11111111-1111-4111-8111-111111111111');
      await expect(
        manager.open('11111111-1111-4111-8111-111111111111'),
      ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });

      // The purged viewer server must be closed and its capacity slot released.
      await expect(fetch(new URL(first.url).origin)).rejects.toThrow();
      const fifth = await manager.open('55555555-5555-4555-8555-555555555555');
      expect(fifth.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#[a-f0-9]{64}$/);
    } finally {
      await manager.closeAll();
    }
  });

  it('rejects opens racing with closeAll() without leaking viewer servers', async () => {
    const db = ((_strings: TemplateStringsArray, scanId: string) =>
      Promise.resolve([{ id: scanId }])) as unknown as Database;
    loadState.session = await makeSession(
      '00000000-0000-4000-8000-000000000092',
    );
    let release!: () => void;
    loadState.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new PersistentViewerManager(db);
    const pendingOpen = manager.open('66666666-6666-4666-8666-666666666666');
    const closing = manager.closeAll();
    release();
    await expect(pendingOpen).rejects.toMatchObject({
      status: 503,
      code: 'VIEWER_UNAVAILABLE',
    });
    await closing;
    await expect(
      manager.open('77777777-7777-4777-8777-777777777777'),
    ).rejects.toMatchObject({
      status: 503,
      code: 'VIEWER_UNAVAILABLE',
    });
    loadState.gate = null;
  });
});
