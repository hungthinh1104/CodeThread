import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelScanJob,
  createRepository,
  getRepository,
  getScanFiles,
  getScanProjects,
  getScanStatus,
  startRepositoryScan,
  systemHealth,
} from '../packages/investigation-workspace/src/server/scan-admin-bff.ts';
import {
  openWorkspace,
  queryWorkspaceBackendSymbols,
  queryWorkspaceDeepNeighbors,
  queryWorkspaceDirectEvidence,
} from '../packages/investigation-workspace/src/server/workspace-bff.ts';
import {
  chainGraphFixture,
  id as fixtureId,
  productionSource,
} from './fixtures/trace.ts';

const scanId = '11111111-1111-4111-8111-111111111111';
const repositoryId = '22222222-2222-4222-8222-222222222222';
const commitId = 'a'.repeat(40);
const viewerToken = 'b'.repeat(64);

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('local Investigation Workspace full backend BFF routes', () => {
  beforeEach(() => {
    vi.stubEnv('CODETHREAD_API_TOKEN', 'server-only-test-token');
    vi.stubEnv('CODETHREAD_WORKSPACE_PORT', '3000');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('adapts 200 and 503 health payloads, sanitizes repository locators, and manages scan lifecycle without leaking tokens', async () => {
    const now = new Date().toISOString();
    const seen: { url: string; method: string; body?: string }[] = [];
    let degraded = true;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        const body = typeof init?.body === 'string' ? init.body : undefined;
        seen.push({ url, method, ...(body === undefined ? {} : { body }) });

        if (url.endsWith('/v1/health')) {
          return degraded
            ? json(
                {
                  api: 'ready',
                  database: 'ready',
                  worker: 'unavailable',
                  ready: false,
                },
                503,
              )
            : json({
                api: 'ready',
                database: 'ready',
                worker: 'ready',
                ready: true,
              });
        }
        if (url.endsWith('/v1/ai/status')) return json({ enabled: false });
        if (method === 'POST' && url.endsWith('/v1/repositories')) {
          return json({
            id: repositoryId,
            locator: 'C:/sensitive/host/path/my-repo',
          });
        }
        if (
          method === 'GET' &&
          url.endsWith(`/v1/repositories/${repositoryId}`)
        ) {
          return json({
            id: repositoryId,
            locator: 'C:/sensitive/host/path/my-repo',
            desired_generation: '2',
            active_job_id: scanId,
          });
        }
        if (
          method === 'POST' &&
          url.endsWith(`/v1/repositories/${repositoryId}/scans`)
        ) {
          return json({
            id: scanId,
            repositoryId,
            state: 'queued',
            reused: false,
          });
        }
        if (method === 'GET' && url.endsWith(`/v1/scans/${scanId}`)) {
          return json({
            id: scanId,
            repository_id: repositoryId,
            generation: '2',
            state: 'queued',
            attempt: 0,
            revision_selector: 'HEAD',
            git_commit_oid: null,
            git_tree_oid: null,
            activation_result: null,
            error_code: null,
            error_message: null,
            created_at: now,
            updated_at: now,
          });
        }
        if (method === 'POST' && url.endsWith(`/v1/scans/${scanId}/cancel`)) {
          return json({ id: scanId, state: 'cancelled' });
        }
        if (method === 'GET' && url.endsWith(`/v1/scans/${scanId}/projects`)) {
          return json([
            {
              project_id: 'root',
              project_label: 'root',
              status: 'ready',
              snapshot_id: fixtureId(1),
              diagnostics: [],
            },
          ]);
        }
        if (url.includes(`/v1/scans/${scanId}/files`)) {
          return json({
            items: [
              {
                path: 'src/index.ts',
                content_hash: 'c'.repeat(64),
                git_blob_oid: commitId,
                git_mode: '100644',
              },
            ],
            total: 1,
            nextOffset: null,
          });
        }
        return json({ error: { code: 'NOT_FOUND', message: 'Missing.' } }, 404);
      }),
    );

    const initialHealth = await systemHealth();
    expect(initialHealth.health).toEqual({
      api: 'ready',
      database: 'ready',
      worker: 'unavailable',
      ready: false,
    });
    degraded = false;
    expect((await systemHealth()).health.ready).toBe(true);

    const created = await createRepository({
      locator: 'C:/sensitive/host/path/my-repo',
    });
    expect(created.repository).toEqual({
      id: repositoryId,
      label: 'my-repo',
      activeScanId: null,
      generation: '0',
    });
    expect(JSON.stringify(created)).not.toContain('C:/sensitive/host/path');

    const loadedRepo = await getRepository(repositoryId);
    expect(loadedRepo.repository.label).toBe('my-repo');
    expect(loadedRepo.repository.activeScanId).toBe(scanId);

    const started = await startRepositoryScan(repositoryId, {
      revision: 'HEAD',
      idempotencyKey: 'idem-1',
    });
    expect(started.scan.state).toBe('queued');

    const status = await getScanStatus(scanId);
    expect(status.scan.revision).toBe('HEAD');

    const cancelled = await cancelScanJob(scanId, {});
    expect(cancelled.scan.state).toBe('cancelled');
    const cancelCall = seen.find((entry) => entry.url.endsWith('/cancel'));
    expect(cancelCall?.body).toBeUndefined();

    const projects = await getScanProjects(scanId);
    expect(projects.items[0]?.status).toBe('ready');

    const files = await getScanFiles(scanId, '0');
    expect(files.items[0]?.git_mode).toBe('100644');
    await expect(getScanFiles(scanId, '9999')).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_REQUEST',
    });
  });

  it('validates scan-scoped deep neighbors, direct evidence, and backend symbol metadata', async () => {
    const now = new Date().toISOString();
    const chain = chainGraphFixture();
    const snapshotId = chain.meta.snapshotId;
    const rootSymbolId = fixtureId(7);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `http://127.0.0.1:8765/v1/scans/${scanId}`) {
          return json({
            id: scanId,
            repository_id: repositoryId,
            generation: '1',
            state: 'succeeded',
            attempt: 1,
            revision_selector: 'HEAD',
            git_commit_oid: commitId,
            git_tree_oid: 'd'.repeat(40),
            activation_result: 'activated',
            error_code: null,
            error_message: null,
            created_at: now,
            updated_at: now,
          });
        }
        if (url === `http://127.0.0.1:8765/v1/scans/${scanId}/viewer`) {
          return json({
            url: `http://127.0.0.1:43123/#${viewerToken}`,
            expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
          });
        }
        if (url === 'http://127.0.0.1:43123/api/projects') {
          return json({
            mode: 'repository',
            initialProjectId: null,
            repositoryId,
            commitId,
            source: null,
            items: [],
          });
        }
        if (url.endsWith('/neighbors')) {
          return json({
            ...chain,
            meta: {
              ...chain.meta,
              appliedLimits: {
                ...chain.meta.appliedLimits,
                depth: 3,
                nodes: 100,
              },
            },
            rootSymbolId,
          });
        }
        if (url.endsWith('/evidence')) {
          const ev = chain.evidenceRefs[0]!;
          return json({
            meta: {
              ...chain.meta,
              appliedLimits: { evidence: 100 },
            },
            items: [
              {
                status: 'available',
                filePath: 'example.ts',
                evidence: ev,
                text: productionSource.slice(
                  ev.range.start.offset,
                  ev.range.end.offset,
                ),
              },
            ],
          });
        }
        if (url.includes('/symbols?')) {
          return json({
            meta: {
              ...chain.meta,
              appliedLimits: { pageSize: 50 },
            },
            items: [chain.symbols[0]!],
            total: 1,
            nextOffset: null,
          });
        }
        return json({ error: { code: 'NOT_FOUND', message: 'Missing.' } }, 404);
      }),
    );

    const opened = await openWorkspace(scanId);
    expect(opened.metadata.treeId).toBe('d'.repeat(40));

    const deep = await queryWorkspaceDeepNeighbors(opened.sessionId, scanId, {
      projectId: 'root',
      request: {
        snapshotId,
        symbolId: rootSymbolId,
        direction: 'outgoing',
        relationKinds: ['calls'],
        depth: 3,
        nodeLimit: 100,
      },
    });
    expect(deep.result.graph.symbols).toHaveLength(3);

    const directEv = await queryWorkspaceDirectEvidence(
      opened.sessionId,
      scanId,
      {
        projectId: 'root',
        request: { snapshotId, evidenceIds: [chain.evidenceRefs[0]!.id] },
      },
    );
    expect(directEv.result.items).toHaveLength(1);

    const symbolsMeta = await queryWorkspaceBackendSymbols(
      opened.sessionId,
      scanId,
      {
        projectId: 'root',
        request: { query: 'first', offset: 0 },
      },
    );
    expect(symbolsMeta.result.total).toBe(1);
  });
});
