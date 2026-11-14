import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { connect, type Database } from '../scripts/backend/database.ts';
import { applyMigrations } from '../scripts/backend/migrations.ts';
import { ScanService } from '../scripts/backend/service.ts';
import { loadSnapshot } from '../scripts/backend/snapshot-persistence.ts';

const databaseUrl = process.env.CODETHREAD_TEST_DATABASE_URL;
const processPath = fileURLToPath(
  new URL('./backend-http-process.ts', import.meta.url),
);
const buildHash = 'c'.repeat(64),
  token = 'integration-only-token';

async function fixture(root: string) {
  const folder = join(root, 'repo');
  await mkdir(folder);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', folder, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  async function commit(name: string) {
    await writeFile(
      join(folder, 'index.ts'),
      `export function ${name}() { return true; }\n`,
    );
    git('add', 'index.ts');
    git(
      '-c',
      'user.name=CodeThread Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      name,
    );
    return git('rev-parse', 'HEAD');
  }
  return { folder, commit };
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

function start(root: string, port: number) {
  return spawn(process.execPath, [processPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CODETHREAD_DATABASE_URL: databaseUrl!,
      CODETHREAD_ALLOWED_REPO_ROOT: root,
      CODETHREAD_ANALYZER_BUILD_HASH: buildHash,
      CODETHREAD_API_TOKEN: token,
      CODETHREAD_TEST_API_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
}

function ready(child: ChildProcess) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new Error('Backend not ready')),
      20_000,
    );
    const onMessage = (message: unknown) => {
      if (message === 'ready') finish();
    };
    const onExit = () => finish(new Error('Backend exited before ready'));
    function finish(error?: Error) {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve();
    }
    child.on('message', onMessage);
    child.once('exit', onExit);
  });
}

function exited(child: ChildProcess, ms = 12_000) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error('Backend shutdown timed out'));
    }, ms);
    function onExit() {
      clearTimeout(timer);
      resolve();
    }
    child.once('exit', onExit);
  });
}

async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await exited(child);
}

async function waitForBarrier(db: Database, query: string) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const rows = await db`SELECT pid FROM pg_stat_activity
      WHERE datname=current_database() AND application_name='codethread-worker'
        AND state='active' AND wait_event='PgSleep' AND query LIKE ${query}`;
    if (rows.length === 1) return Number(rows[0]!.pid);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Backend did not reach shutdown barrier');
}

async function waitForSessionRelease(db: Database, pid: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const rows = await db`SELECT pid FROM pg_stat_activity
      WHERE datname=current_database() AND pid=${pid}`;
    if (!rows.length) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

async function terminal(service: ScanService, id: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const job = await service.job(id);
    if (['succeeded', 'failed', 'cancelled'].includes(job.state)) return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Interrupted scan did not finish recovery');
}

describe.skipIf(!databaseUrl || process.platform === 'win32')(
  'POSIX graceful shutdown',
  () => {
    for (const scenario of [
      { stage: 'unpinned', signal: 'SIGINT' },
      { stage: 'unpinned', signal: 'SIGTERM' },
      { stage: 'pinned', signal: 'SIGINT' },
      { stage: 'pinned', signal: 'SIGTERM' },
    ] as const) {
      it(`${scenario.signal} preserves ${scenario.stage} recovery semantics`, async () => {
        const root = await mkdtemp(join(tmpdir(), 'ct-shutdown-')),
          repo = await fixture(root),
          db = connect(databaseUrl!),
          service = new ScanService(db, { root, analyzerBuildHash: buildHash }),
          port = await reservePort();
        let child: ChildProcess | undefined,
          pid: number | undefined,
          installed = false;
        const table =
          scenario.stage === 'pinned' ? 'scan_input_file' : 'scan_job';
        try {
          await applyMigrations(db);
          const pinned = await repo.commit('originalRevision'),
            registered = await service.register(repo.folder),
            queued = await service.accept(registered.id, 'HEAD', randomUUID());
          const event =
            scenario.stage === 'pinned' ? 'INSERT' : 'UPDATE OF git_commit_oid';
          const condition =
            scenario.stage === 'pinned'
              ? `NEW.scan_job_id='${queued.id}'::uuid`
              : `NEW.id='${queued.id}'::uuid AND NEW.git_commit_oid IS NOT NULL`;
          await db.unsafe(`CREATE FUNCTION codethread.test_pause_shutdown()
          RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF ${condition} THEN PERFORM pg_sleep(60); END IF; RETURN NEW; END $$`);
          await db.unsafe(`CREATE TRIGGER test_pause_shutdown BEFORE ${event}
          ON codethread.${table} FOR EACH ROW EXECUTE FUNCTION codethread.test_pause_shutdown()`);
          installed = true;
          child = start(root, port);
          await ready(child);
          pid = await waitForBarrier(
            db,
            scenario.stage === 'pinned'
              ? '%INSERT INTO codethread.scan_input_file%'
              : '%UPDATE codethread.scan_job%',
          );
          const interrupted = await service.job(queued.id);
          expect(interrupted.state).toBe('running');
          expect(interrupted.git_commit_oid).toBe(
            scenario.stage === 'pinned' ? pinned : null,
          );
          expect(await repo.commit('movedHead')).not.toBe(pinned);
          expect(child.kill(scenario.signal)).toBe(true);
          child.kill(scenario.signal);
          await exited(child);
          expect(child.exitCode).toBe(0);
          expect(await waitForSessionRelease(db, pid)).toBe(true);
          await db.unsafe(
            `DROP TRIGGER test_pause_shutdown ON codethread.${table}`,
          );
          await db.unsafe('DROP FUNCTION codethread.test_pause_shutdown()');
          installed = false;
          child = start(root, port);
          await ready(child);
          const recovered = await terminal(service, queued.id);
          if (scenario.stage === 'unpinned') {
            expect(recovered).toMatchObject({
              state: 'failed',
              attempt: 1,
              error_code: 'REVISION_NOT_PINNED',
              git_commit_oid: null,
            });
            expect(
              (await service.repository(registered.id)).active_job_id,
            ).toBeNull();
          } else {
            expect(recovered).toMatchObject({
              state: 'succeeded',
              attempt: 2,
              git_commit_oid: pinned,
            });
            const projects = await service.projects(queued.id),
              snapshotId = projects.find(
                (project) => project.snapshot_id,
              )?.snapshot_id;
            expect(snapshotId).toBeTruthy();
            const snapshot = await loadSnapshot(db, String(snapshotId));
            expect(
              snapshot.facts.symbols.map((symbol) => symbol.name),
            ).toContain('originalRevision');
            expect(
              snapshot.facts.symbols.map((symbol) => symbol.name),
            ).not.toContain('movedHead');
          }
        } finally {
          await stop(child);
          if (pid)
            await db`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname=current_database() AND pid=${pid} AND application_name='codethread-worker'`;
          if (installed) {
            await db.unsafe(
              `DROP TRIGGER IF EXISTS test_pause_shutdown ON codethread.${table}`,
            );
            await db.unsafe(
              'DROP FUNCTION IF EXISTS codethread.test_pause_shutdown()',
            );
          }
          service.stop();
          await db.end({ timeout: 5 });
          await rm(root, { recursive: true, force: true });
        }
      }, 120_000);
    }

    it('bounds repeated signals while an HTTP request is still receiving its body', async () => {
      const root = await mkdtemp(join(tmpdir(), 'ct-http-shutdown-')),
        db = connect(databaseUrl!),
        port = await reservePort();
      let child: ChildProcess | undefined;
      try {
        await applyMigrations(db);
        child = start(root, port);
        await ready(child);
        const request = httpRequest({
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/v1/repositories',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Content-Length': '1000',
          },
        });
        request.on('error', () => {});
        request.write('{');
        await new Promise<void>((resolve) =>
          request.once('socket', (socket) => {
            if (socket.connecting) socket.once('connect', resolve);
            else resolve();
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(request.destroyed).toBe(false);
        const started = Date.now();
        expect(child.kill('SIGTERM')).toBe(true);
        child.kill('SIGTERM');
        await exited(child);
        const elapsed = Date.now() - started;
        expect(child.exitCode).toBe(0);
        expect(elapsed).toBeGreaterThanOrEqual(2500);
        expect(elapsed).toBeLessThan(10_000);
        request.destroy();
      } finally {
        await stop(child);
        await db.end({ timeout: 5 });
        await rm(root, { recursive: true, force: true });
      }
    }, 30_000);
  },
);
