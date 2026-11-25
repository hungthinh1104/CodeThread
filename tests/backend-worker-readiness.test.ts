import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzerBuildHash } from '@codethread/symbol-indexer';
import { PostgresError } from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import { connect } from '../scripts/backend/database.ts';
import { applyMigrations } from '../scripts/backend/migrations.ts';
import {
  startBackend,
  type BackendRuntime,
} from '../scripts/backend/runtime.ts';

const url = process.env.CODETHREAD_TEST_DATABASE_URL;
const token = 'worker-readiness-test-token-000000000000';

async function waitFor<T>(
  work: () => Promise<T>,
  matches: (value: T) => boolean,
) {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    const result = await work();
    if (matches(result)) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for worker readiness');
}

async function port() {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('No local port');
  await new Promise<void>((resolve, reject) =>
    probe.close((e) => (e ? reject(e) : resolve())),
  );
  return address.port;
}

async function fixtureRepository(root: string) {
  const folder = join(root, 'repo');
  await mkdir(folder);
  await writeFile(join(folder, 'index.ts'), 'export const value = 1;\n');
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', folder, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('add', 'index.ts');
  git(
    '-c',
    'user.name=CodeThread Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-qm',
    'fixture',
  );
  return folder;
}

describe.skipIf(!url)('worker readiness boundaries', () => {
  for (const scenario of ['blocked-input', 'lost-lease'] as const) {
    it(`returns HTTP 503 for ${scenario} while the control database remains available`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'ct-readiness-'));
      const folder = await fixtureRepository(root);
      const db = connect(url!);
      let runtime: BackendRuntime | undefined;
      try {
        await applyMigrations(db);
        const apiPort = await port();
        runtime = await startBackend({
          url: url!,
          root,
          port: apiPort,
          secret: token,
          analyzerBuildHash: analyzerBuildHash(),
        });
        const health = () =>
          fetch(`http://127.0.0.1:${apiPort}/v1/health`, {
            headers: { Authorization: `Bearer ${token}` },
          });
        await waitFor(health, (response) => response.status === 200);
        if (scenario === 'blocked-input') {
          const [settings] = await runtime.lease.db`
            SELECT current_setting('statement_timeout') AS statement_timeout,
                   current_setting('lock_timeout') AS lock_timeout`;
          expect(settings).toMatchObject({
            statement_timeout: '1min',
            lock_timeout: '5s',
          });
          // Exercise database-initiated recovery after the readiness deadline.
          await runtime.lease.db`SET statement_timeout = '20s'`;
          const repo = await runtime.service.register(folder);
          await db.unsafe(`CREATE FUNCTION codethread.readiness_pause() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN PERFORM pg_sleep(25); RETURN NEW; END $$`);
          await db.unsafe(`CREATE TRIGGER readiness_pause BEFORE INSERT ON codethread.scan_input_file
            FOR EACH ROW EXECUTE FUNCTION codethread.readiness_pause()`);
          const job = await runtime.service.accept(
            repo.id,
            'HEAD',
            randomUUID(),
          );
          const worker = await waitFor(
            () =>
              db`SELECT pid FROM pg_stat_activity WHERE application_name='codethread-worker' AND wait_event='PgSleep'`,
            (rows) => rows.length === 1,
          );
          const unavailable = await waitFor(
            health,
            (response) => response.status === 503,
          );
          expect(await unavailable.json()).toMatchObject({
            database: 'ready',
            worker: 'unavailable',
            ready: false,
          });
          await waitFor(
            () => db`SELECT pid FROM pg_stat_activity WHERE pid=${worker[0]!.pid}
              AND wait_event='PgSleep'`,
            (rows) => rows.length === 0,
          );
          await db.unsafe(
            'DROP TRIGGER readiness_pause ON codethread.scan_input_file',
          );
          await db.unsafe('DROP FUNCTION codethread.readiness_pause()');
          const completed = await waitFor(
            () => runtime!.service.job(job.id),
            (row) => ['succeeded', 'failed'].includes(row.state),
          );
          expect(completed.state).toBe('succeeded');
          await waitFor(health, (response) => response.status === 200);
        } else {
          const locks =
            await db`SELECT pid FROM pg_locks WHERE locktype='advisory'
            AND classid=1919606129::oid AND objid=2::oid AND objsubid=2 AND granted`;
          expect(locks).toHaveLength(1);
          await db`SELECT pg_terminate_backend(${locks[0]!.pid})`;
          const unavailable = await waitFor(
            health,
            (response) => response.status === 503,
          );
          expect(await unavailable.json()).toMatchObject({
            database: 'ready',
            worker: 'unavailable',
            ready: false,
          });
        }
      } finally {
        await db`SELECT pg_cancel_backend(pid) FROM pg_stat_activity
          WHERE application_name='codethread-worker' AND wait_event='PgSleep'`;
        await db.unsafe(
          'DROP TRIGGER IF EXISTS readiness_pause ON codethread.scan_input_file',
        );
        await db.unsafe('DROP FUNCTION IF EXISTS codethread.readiness_pause()');
        await runtime?.shutdown();
        await db.end({ timeout: 5 });
        await rm(root, { recursive: true, force: true });
      }
    }, 90_000);
  }

  it('backs off after a rejected claim and checks the failed write on a synthetic job', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ct-claim-readiness-'));
    const admin = connect(url!);
    const role = 'ct_claim_' + randomUUID().replaceAll('-', '');
    let roleCreated = false;
    let claimPermissionRevoked = false;
    let runtime: BackendRuntime | undefined;
    const failures: { at: number; target: unknown }[] = [];
    const errors = vi
      .spyOn(console, 'error')
      .mockImplementation((label, error) => {
        if (
          label === 'Scan worker error' &&
          error instanceof PostgresError &&
          error.code === '42501' &&
          Array.isArray(error.parameters)
        ) {
          failures.push({ at: performance.now(), target: error.parameters[0] });
        }
      });
    const restoreClaimPermission = () =>
      admin.unsafe(
        'GRANT UPDATE (error_message) ON codethread.scan_job TO codethread_runtime',
      );
    try {
      const folder = await fixtureRepository(root);
      await applyMigrations(admin);
      await admin.unsafe(
        await readFile(new URL('../db/roles.sql', import.meta.url), 'utf8'),
      );
      await admin.unsafe(
        `CREATE ROLE "${role}" LOGIN PASSWORD 'integration-only-password'`,
      );
      roleCreated = true;
      await admin.unsafe(`GRANT codethread_runtime TO "${role}"`);
      const runtimeUrl = new URL(url!);
      runtimeUrl.username = role;
      runtimeUrl.password = 'integration-only-password';
      const apiPort = await port();
      runtime = await startBackend({
        url: runtimeUrl.toString(),
        root,
        port: apiPort,
        secret: token,
        analyzerBuildHash: analyzerBuildHash(),
      });
      const health = () =>
        fetch(`http://127.0.0.1:${apiPort}/v1/health`, {
          headers: { Authorization: `Bearer ${token}` },
        });
      await waitFor(health, (response) => response.status === 200);
      const repo = await runtime.service.register(folder);

      await admin.unsafe(
        'REVOKE UPDATE (error_message) ON codethread.scan_job FROM codethread_runtime',
      );
      claimPermissionRevoked = true;
      const job = await runtime.service.accept(repo.id, 'HEAD', randomUUID());
      const unavailable = await waitFor(
        health,
        (response) => response.status === 503,
      );
      expect(await unavailable.json()).toMatchObject({
        database: 'ready',
        worker: 'unavailable',
        ready: false,
      });
      await waitFor(
        () => Promise.resolve(failures.length),
        (count) => count >= 2,
      );
      const [initial, recovery] = failures;
      expect(initial!.target).toBe(job.id);
      expect(recovery!.at - initial!.at).toBeGreaterThanOrEqual(4_900);
      expect(recovery!.target).toEqual(expect.any(String));
      expect(recovery!.target).not.toBe(job.id);
      expect((await health()).status).toBe(503);
      expect(await runtime.service.job(job.id)).toMatchObject({
        state: 'queued',
        attempt: 0,
      });

      await restoreClaimPermission();
      claimPermissionRevoked = false;
      const completed = await waitFor(
        () => runtime!.service.job(job.id),
        (row) => ['succeeded', 'failed'].includes(row.state),
      );
      expect(completed).toMatchObject({ state: 'succeeded', attempt: 1 });
      await waitFor(health, (response) => response.status === 200);
    } finally {
      errors.mockRestore();
      if (claimPermissionRevoked) await restoreClaimPermission();
      await runtime?.shutdown();
      if (roleCreated) await admin.unsafe(`DROP ROLE "${role}"`);
      await admin.end({ timeout: 5 });
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000);
});
