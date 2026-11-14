import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { connect } from '../scripts/backend/database.ts';
import { makeApi } from '../scripts/backend/http.ts';
import { applyMigrations } from '../scripts/backend/migrations.ts';
import { ScanService } from '../scripts/backend/service.ts';
import { loadSnapshot } from '../scripts/backend/snapshot-persistence.ts';
import { acquireWorkerLease } from '../scripts/backend/worker-lease.ts';
import { createGitRepository } from './helpers/git-fixture.ts';

const databaseUrl = process.env.CODETHREAD_TEST_DATABASE_URL;
const token = 'query-admission-test-token-000000';

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
        { root: tmpdir(), analyzerBuildHash: 'f'.repeat(64) },
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
