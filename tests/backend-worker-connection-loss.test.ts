import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, connect as connectSocket, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { connect, type Database } from '../scripts/backend/database.ts';
import { applyMigrations } from '../scripts/backend/migrations.ts';
import { ScanService } from '../scripts/backend/service.ts';
import { loadSnapshot } from '../scripts/backend/snapshot-persistence.ts';

const databaseUrl = process.env.CODETHREAD_TEST_DATABASE_URL;
const workerPath = fileURLToPath(
  new URL('./backend-scan-worker-process.ts', import.meta.url),
);
const buildHash = 'b'.repeat(64);

async function fixture(root: string) {
  const folder = join(root, 'repo');
  await mkdir(folder);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', folder, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  async function commit(name: string) {
    await writeFile(
      join(folder, 'index.ts'),
      `export function ${name}() { return '${randomUUID()}'; }\n`,
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

function startWorker(root: string, url = databaseUrl!) {
  return spawn(process.execPath, [workerPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CODETHREAD_DATABASE_URL: url,
      CODETHREAD_ALLOWED_REPO_ROOT: root,
      CODETHREAD_ANALYZER_BUILD_HASH: buildHash,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
}

async function createProxy(raw: string) {
  const target = new URL(raw);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))
    throw new Error('Connection-loss proxy requires loopback PostgreSQL');
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = connectSocket(
      Number(target.port || '5432'),
      target.hostname.replace(/^\[|\]$/g, ''),
    );
    sockets.add(client);
    sockets.add(upstream);
    client.pipe(upstream).pipe(client);
    const close = () => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on('error', close).on('close', close);
    upstream.on('error', close).on('close', close);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No proxy port');
  const proxyUrl = new URL(raw);
  proxyUrl.hostname = '127.0.0.1';
  proxyUrl.port = String(address.port);
  let closed: Promise<void> | undefined;
  return {
    url: proxyUrl.toString(),
    close() {
      if (!closed) {
        for (const socket of sockets) socket.destroy();
        closed = new Promise<void>((resolve) => server.close(() => resolve()));
      }
      return closed;
    },
  };
}

function ready(child: ChildProcess) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => finish(new Error('Worker not ready')),
      20_000,
    );
    const onMessage = (message: unknown) => {
      if (message === 'ready') finish();
    };
    const onExit = () => finish(new Error('Worker exited before ready'));
    function finish(error?: Error) {
      clearTimeout(timeout);
      child.off('message', onMessage);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve();
    }
    child.on('message', onMessage);
    child.once('exit', onExit);
  });
}

function waitForExit(child: ChildProcess, ms = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error('Worker did not exit'));
    }, ms);
    function onExit() {
      clearTimeout(timeout);
      resolve();
    }
    child.once('exit', onExit);
  });
}

async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (child.connected) child.send('stop');
  try {
    await waitForExit(child, 3000);
  } catch {
    child.kill();
    await waitForExit(child);
  }
}

async function terminal(service: ScanService, id: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const job = await service.job(id);
    if (['succeeded', 'failed', 'cancelled'].includes(job.state)) return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Scan did not reach a terminal state');
}

type Stage = 'inputs' | 'publication' | 'activation';

async function installPause(
  db: Database,
  stage: Stage,
  jobId: string,
  seconds: number,
) {
  const spec = {
    inputs: {
      table: 'scan_input_file',
      event: 'INSERT',
      condition: `NEW.scan_job_id='${jobId}'::uuid`,
      query: '%INSERT INTO codethread.scan_input_file%',
    },
    publication: {
      table: 'repository_snapshot',
      event: 'UPDATE OF state',
      condition: "NEW.state='published'",
      query: '%UPDATE codethread.repository_snapshot%',
    },
    activation: {
      table: 'repository',
      event: 'UPDATE OF active_job_id',
      condition: `NEW.active_job_id='${jobId}'::uuid`,
      query: '%UPDATE codethread.repository%',
    },
  }[stage];
  await db.unsafe(`CREATE FUNCTION codethread.test_pause_connection_loss()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF ${spec.condition} THEN PERFORM pg_sleep(${seconds}); END IF;
      RETURN NEW; END $$`);
  await db.unsafe(`CREATE TRIGGER test_pause_connection_loss
    BEFORE ${spec.event} ON codethread.${spec.table}
    FOR EACH ROW EXECUTE FUNCTION codethread.test_pause_connection_loss()`);
  return spec;
}

async function blockedPid(db: Database, query: string) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const rows = await db`SELECT pid FROM pg_stat_activity
      WHERE datname=current_database() AND application_name='codethread-worker'
        AND state='active' AND wait_event='PgSleep' AND query LIKE ${query}`;
    if (rows.length === 1) return Number(rows[0]!.pid);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Worker did not reach the connection-loss barrier');
}

describe.skipIf(!databaseUrl)('worker transaction connection loss', () => {
  for (const mode of ['terminate', 'network'] as const) {
    for (const stage of ['inputs', 'publication', 'activation'] as const) {
      it(`${mode} rolls back ${stage} and recovers only the pinned revision`, async () => {
        const root = await mkdtemp(join(tmpdir(), 'ct-worker-loss-')),
          repo = await fixture(root),
          db = connect(databaseUrl!),
          service = new ScanService(db, { root, analyzerBuildHash: buildHash });
        let child: ChildProcess | undefined;
        let pause: Awaited<ReturnType<typeof installPause>> | undefined;
        let proxy: Awaited<ReturnType<typeof createProxy>> | undefined;
        let pid: number | undefined;
        try {
          await applyMigrations(db);
          await repo.commit('previousRevision');
          const registered = await service.register(repo.folder);
          let previousJob: string | null = null;
          if (stage === 'activation') {
            const initial = await service.accept(
              registered.id,
              'HEAD',
              randomUUID(),
            );
            child = startWorker(root);
            await ready(child);
            expect((await terminal(service, initial.id)).state).toBe(
              'succeeded',
            );
            previousJob = initial.id;
            await stop(child);
            child = undefined;
          }
          const pinned = await repo.commit('pinnedRevision'),
            queued = await service.accept(registered.id, 'HEAD', randomUUID());
          pause = await installPause(
            db,
            stage,
            queued.id,
            mode === 'network' ? 8 : 60,
          );
          if (mode === 'network') proxy = await createProxy(databaseUrl!);
          child = startWorker(root, proxy?.url);
          await ready(child);
          pid = await blockedPid(db, pause.query);
          expect(await service.job(queued.id)).toMatchObject({
            state: 'running',
            attempt: 1,
            git_commit_oid: pinned,
          });
          const moved = await repo.commit('movedHead');
          expect(moved).not.toBe(pinned);
          if (mode === 'terminate') {
            const terminated =
              await db`SELECT pg_terminate_backend(${pid}) AS killed`;
            expect(terminated[0]?.killed).toBe(true);
          } else {
            await proxy!.close();
          }
          await waitForExit(child);
          expect(child.exitCode).toBe(1);
          child = undefined;
          if (mode === 'network') {
            const contender = await db.reserve();
            try {
              const attempt =
                await contender`SELECT pg_try_advisory_lock(1919606126, 2) AS acquired`;
              if (attempt[0]?.acquired) {
                const oldLock = await db`SELECT pid FROM pg_locks
                WHERE pid=${pid} AND locktype='advisory' AND classid=1919606126::oid
                  AND objid=2::oid AND objsubid=2 AND granted`;
                expect(oldLock).toHaveLength(0);
                await contender`SELECT pg_advisory_unlock(1919606126, 2)`;
              }
            } finally {
              await contender.release();
            }
          }
          const disconnectDeadline = Date.now() + 15_000;
          let gone = false;
          while (Date.now() < disconnectDeadline) {
            const rows =
              await db`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid=${pid}`;
            if (!rows.length) {
              gone = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          expect(gone).toBe(true);
          const partial = await db`SELECT
          (SELECT count(*)::integer FROM codethread.scan_input_file
            WHERE scan_job_id=${queued.id}) AS inputs,
          (SELECT count(*)::integer FROM codethread.scan_project
            WHERE scan_job_id=${queued.id}) AS projects,
          (SELECT count(*)::integer FROM codethread.repository_snapshot
            WHERE repository_id=${registered.id}) AS snapshots,
          (SELECT active_job_id FROM codethread.repository
            WHERE id=${registered.id}) AS active_job_id`;
          expect(partial[0]).toMatchObject({
            ...(stage === 'inputs' ? { inputs: 0 } : {}),
            projects: 0,
            snapshots: previousJob ? 1 : 0,
            active_job_id: previousJob,
          });
          await db.unsafe(
            `DROP TRIGGER test_pause_connection_loss ON codethread.${pause.table}`,
          );
          await db.unsafe(
            'DROP FUNCTION codethread.test_pause_connection_loss()',
          );
          pause = undefined;
          child = startWorker(root);
          await ready(child);
          expect(await terminal(service, queued.id)).toMatchObject({
            state: 'succeeded',
            attempt: 2,
            git_commit_oid: pinned,
          });
          expect((await service.repository(registered.id)).active_job_id).toBe(
            queued.id,
          );
          const projects = await service.projects(queued.id),
            snapshotId = projects.find(
              (project) => project.snapshot_id,
            )?.snapshot_id;
          expect(snapshotId).toBeTruthy();
          const snapshot = await loadSnapshot(db, String(snapshotId));
          const names = snapshot.facts.symbols.map((symbol) => symbol.name);
          expect(names).toContain('pinnedRevision');
          expect(names).not.toContain('movedHead');
        } finally {
          await proxy?.close();
          await stop(child);
          if (pause) {
            if (pid)
              await db`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE datname=current_database() AND pid=${pid} AND application_name='codethread-worker'
              AND wait_event='PgSleep' AND query LIKE ${pause.query}`;
            await db.unsafe(
              `DROP TRIGGER IF EXISTS test_pause_connection_loss ON codethread.${pause.table}`,
            );
            await db.unsafe(
              'DROP FUNCTION IF EXISTS codethread.test_pause_connection_loss()',
            );
          }
          service.stop();
          await db.end({ timeout: 5 });
          await rm(root, { recursive: true, force: true });
        }
      }, 120_000);
    }
  }
});
