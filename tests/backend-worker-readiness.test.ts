import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzerBuildHash } from '@codethread/symbol-indexer';
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

describe.skipIf(!url)('worker readiness boundaries', () => {
  for (const scenario of ['blocked-input', 'lost-lease'] as const) {
    it(`returns HTTP 503 for ${scenario} while the control database remains available`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'ct-readiness-'));
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
          await db`SELECT pg_cancel_backend(${worker[0]!.pid})`;
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
            AND classid=1919606126::oid AND objid=2::oid AND objsubid=2 AND granted`;
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

  it('backs off after repeated claim failures and recovers when PostgreSQL access returns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ct-claim-readiness-'));
    const folder = join(root, 'repo');
    await mkdir(folder);
    const admin = connect(url!);
    const role = 'ct_claim_' + randomUUID().replaceAll('-', '');
    let roleCreated = false;
    let runtime: BackendRuntime | undefined;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
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
      await runtime.service.register(folder);

      await admin.unsafe(
        'REVOKE SELECT ON TABLE codethread.scan_job FROM codethread_runtime',
      );
      await admin.unsafe(
        'GRANT SELECT (id,state,attempt) ON TABLE codethread.scan_job TO codethread_runtime',
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
      const errorsAtUnavailable = errors.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 1_300));
      expect(errors.mock.calls.length - errorsAtUnavailable).toBe(0);

      await admin.unsafe(
        'GRANT SELECT ON TABLE codethread.scan_job TO codethread_runtime',
      );
      await waitFor(health, (response) => response.status === 200);
    } finally {
      errors.mockRestore();
      await admin
        .unsafe(
          'GRANT SELECT ON TABLE codethread.scan_job TO codethread_runtime',
        )
        .catch(() => {});
      await runtime?.shutdown();
      if (roleCreated) await admin.unsafe(`DROP ROLE "${role}"`);
      await admin.end({ timeout: 5 });
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000);
});
