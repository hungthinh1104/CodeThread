import { analyzerBuildHash as currentAnalyzerBuildHash } from '@codethread/symbol-indexer';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { connect } from '../scripts/backend/database.ts';
import type { Database } from '../scripts/backend/database.ts';
import { makeApi } from '../scripts/backend/http.ts';
import { applyMigrations } from '../scripts/backend/migrations.ts';
import { ScanService } from '../scripts/backend/service.ts';
import { loadSnapshot } from '../scripts/backend/snapshot-persistence.ts';
import { acquireWorkerLease } from '../scripts/backend/worker-lease.ts';
import { createGitRepository } from './helpers/git-fixture.ts';

const databaseUrl = process.env.CODETHREAD_TEST_DATABASE_URL;
const token = 'query-admission-test-token-000000';

async function checkRetentionRace(
  db: Database,
  service: ScanService,
  repositoryId: string,
  jobId: string,
  request: () => Promise<Response>,
  expected: unknown,
) {
  await db`UPDATE codethread.repository SET active_job_id=NULL WHERE id=${repositoryId}`;
  const checked = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const read = service.publishedSnapshot.bind(service);
  const lookup = vi
    .spyOn(service, 'publishedSnapshot')
    .mockImplementation(async (...args) => {
      const snapshotId = await read(...args);
      checked.resolve();
      await resume.promise;
      return snapshotId;
    });
  const prune = () =>
    db`SELECT * FROM codethread.prune_inactive_data(clock_timestamp(),100,100,1000)`;
  const pending = request();
  try {
    await Promise.race([
      checked.promise,
      pending.then((result) => {
        throw new Error(
          'Query ended before scoped hydration with HTTP ' + result.status,
        );
      }),
    ]);
    await prune();
    resume.resolve();
    const response = await pending;
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(
      200,
    );
    expect(await response.json()).toEqual(expected);
    expect(
      await db`SELECT id FROM codethread.scan_job WHERE id=${jobId}`,
    ).toHaveLength(1);
  } finally {
    resume.resolve();
    lookup.mockRestore();
    await pending.catch(() => {});
  }
  await prune();
  const gone = await request();
  expect(gone.status).toBe(404);
  expect(await gone.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
}

async function reservePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

describe.skipIf(!databaseUrl)('heavy HTTP query admission', () => {
  it('rejects excess graph work promptly while keeping health responsive', async () => {
    const directories: string[] = [],
      fixture = await createGitRepository(
        [
          {
            path: 'index.ts',
            source:
              'export function target(){return 1} export function entry(){return target()}',
          },
        ],
        directories,
      ),
      db = connect(databaseUrl!),
      apiDb = connect(databaseUrl!);
    let lease: Awaited<ReturnType<typeof acquireWorkerLease>> | undefined,
      service: ScanService | undefined,
      worker: Promise<void> | undefined,
      server: ReturnType<typeof makeApi> | undefined,
      held: Awaited<ReturnType<typeof db.reserve>> | undefined,
      snapshotId: string | undefined,
      requests: Promise<Response>[] = [];
    try {
      await applyMigrations(db);
      lease = await acquireWorkerLease(databaseUrl!);
      service = new ScanService(
        db,
        { root: tmpdir(), analyzerBuildHash: currentAnalyzerBuildHash() },
        lease,
      );
      await service.recover();
      worker = service.run();
      const repo = await service.register(fixture.directory),
        job = await service.accept(
          repo.id,
          fixture.revision,
          'query-admission',
        );
      const deadline = Date.now() + 30_000;
      let current = await service.job(job.id);
      while (
        !['succeeded', 'failed', 'cancelled'].includes(current.state) &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        current = await service.job(job.id);
      }
      expect(current.state).toBe('succeeded');
      const project = (await service.projects(job.id)).find(
        (item) => item.snapshot_id,
      );
      expect(project?.snapshot_id).toBeTruthy();
      snapshotId = String(project!.snapshot_id);
      const snapshot = await loadSnapshot(db, snapshotId),
        entry = snapshot.facts.symbols.find(
          (symbol) => symbol.name === 'entry',
        );
      if (!entry) throw new Error('Fixture symbol is missing');
      const port = await reservePort();
      server = makeApi(apiDb, service, token, port);
      await new Promise<void>((resolve) =>
        server!.listen(port, '127.0.0.1', resolve),
      );
      held = await db.reserve();
      await held`SELECT pg_advisory_lock(1919606126, hashtext(${snapshotId}::text))`;
      const base = `http://127.0.0.1:${port}`,
        path = `/v1/scans/${job.id}/projects/${project!.project_id}/neighbors`,
        headers = {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body = JSON.stringify({
          snapshotId,
          symbolId: entry.id,
          direction: 'outgoing',
          depth: 1,
          nodeLimit: 20,
        });
      requests = Array.from({ length: 5 }, () =>
        fetch(base + path, { method: 'POST', headers, body }),
      );
      const first = await Promise.race([
        ...requests,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
      ]);
      expect(first?.status).toBe(429);
      const waitingDeadline = Date.now() + 3000;
      let waiting = 0;
      while (Date.now() < waitingDeadline) {
        const rows =
          await db`SELECT count(*)::integer AS total FROM pg_stat_activity
          WHERE datname=current_database() AND application_name='codethread-backend'
            AND wait_event='advisory' AND query LIKE '%pg_advisory_xact_lock_shared%'`;
        waiting = Number(rows[0]?.total);
        if (waiting >= 4) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(waiting).toBe(4);
      const symbolResponse = await fetch(
        `${base}/v1/scans/${job.id}/projects/${project!.project_id}/symbols?query=entry`,
        { headers },
      );
      expect(symbolResponse.status).toBe(429);
      expect(await symbolResponse.json()).toMatchObject({
        error: {
          code: 'QUERY_CAPACITY_EXCEEDED',
          message:
            'Too many symbol, graph or evidence queries are active; retry shortly.',
        },
      });
      const health = await fetch(base + '/v1/health', { headers });
      expect(health.status).toBe(200);
      await held`SELECT pg_advisory_unlock(1919606126, hashtext(${snapshotId}::text))`;
      await held.release();
      held = undefined;
      const responses = await Promise.all(requests),
        rejected = responses.filter((response) => response.status === 429);
      expect(
        responses.filter((response) => response.status === 200),
      ).toHaveLength(4);
      expect(rejected).toHaveLength(1);
      expect(await rejected[0]!.json()).toMatchObject({
        error: { code: 'QUERY_CAPACITY_EXCEEDED' },
      });
      const original = await responses
        .find((response) => response.status === 200)!
        .json();
      const invalid = await Promise.all(
        Array.from({ length: 4 }, () =>
          fetch(base + path, { method: 'POST', headers, body: '{}' }),
        ),
      );
      expect(invalid.every((response) => response.status === 400)).toBe(true);
      const resumed = await fetch(base + path, {
        method: 'POST',
        headers,
        body,
      });
      expect(resumed.status).toBe(200);
      expect(await resumed.json()).toEqual(original);

      // PostgreSQL enforces the configured lock deadline and every slot is returned.
      await heldLockTimeout(db, snapshotId, (signal) =>
        fetch(base + path, { method: 'POST', headers, body, signal }),
      );
      await checkRetentionRace(
        db,
        service,
        repo.id,
        job.id,
        () =>
          fetch(base + path.replace(job.id, job.id.toUpperCase()), {
            method: 'POST',
            headers,
            body,
          }),
        original,
      );
    } finally {
      if (held && snapshotId) {
        await held`SELECT pg_advisory_unlock(1919606126, hashtext(${snapshotId}::text))`.catch(
          () => {},
        );
        await held.release();
      }
      await Promise.allSettled(requests);
      server?.closeAllConnections();
      if (server)
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      service?.stop();
      await worker?.catch(() => {});
      await lease?.close();
      await apiDb.end({ timeout: 5 });
      await db.end({ timeout: 5 });
      for (const directory of directories)
        await rm(directory, { recursive: true, force: true });
    }
  }, 90_000);
});

async function heldLockTimeout(
  db: Database,
  snapshotId: string,
  request: (signal: AbortSignal) => Promise<Response>,
) {
  const lock = await db.reserve();
  try {
    await lock`SELECT pg_advisory_lock(1919606126, hashtext(${snapshotId}::text))`;
    const signal = AbortSignal.timeout(15_000);
    const blocked = await Promise.all(
      Array.from({ length: 4 }, () => request(signal)),
    );
    expect(blocked.map(({ status }) => status)).toEqual([500, 500, 500, 500]);
    for (const response of blocked)
      expect(await response.json()).toMatchObject({
        error: { code: 'INTERNAL_ERROR' },
      });
  } finally {
    await lock`SELECT pg_advisory_unlock(1919606126, hashtext(${snapshotId}::text))`;
    await lock.release();
  }
  const recovered = await request(AbortSignal.timeout(15_000));
  expect(recovered.status).toBe(200);
  await recovered.json();
}
