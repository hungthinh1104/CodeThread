import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { connect } from '../scripts/backend/database.ts';
import { applyMigrations } from '../scripts/backend/migrations.ts';
import { ScanService } from '../scripts/backend/service.ts';
import { loadSnapshot } from '../scripts/backend/snapshot-persistence.ts';

const databaseUrl = process.env.CODETHREAD_RESTART_TEST_DATABASE_URL;
const container = process.env.CODETHREAD_RESTART_TEST_CONTAINER;
const workerPath = fileURLToPath(
  new URL('./backend-scan-worker-process.ts', import.meta.url),
);
const buildHash = 'd'.repeat(64);

function assertDisposableContainer(): string {
  if (!databaseUrl || !container)
    throw new Error('Restart test configuration missing');
  const url = new URL(databaseUrl);
  if (
    url.hostname !== '127.0.0.1' ||
    url.pathname !== '/codethread_restart_test'
  )
    throw new Error('Restart test requires its dedicated loopback database');
  const [info] = JSON.parse(
    execFileSync('docker', ['inspect', container], { encoding: 'utf8' }),
  ) as [
    {
      Id: string;
      Config: { Image: string; Labels: Record<string, string> };
      State: { Running: boolean };
      NetworkSettings: { Ports: Record<string, { HostPort: string }[] | null> };
    },
  ];
  if (
    !info ||
    !/^[a-f0-9]{64}$/.test(info.Id) ||
    !info.State.Running ||
    info.Config.Image !== 'postgres:17-alpine' ||
    info.Config.Labels?.['codethread.test'] !== 'restart-only' ||
    !info.NetworkSettings.Ports['5432/tcp']?.some(
      (port) => port.HostPort === url.port,
    )
  )
    throw new Error('Refusing to restart an unverified PostgreSQL container');
  return info.Id;
}

async function waitForPostgres(id: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      execFileSync(
        'docker',
        [
          'exec',
          id,
          'pg_isready',
          '-U',
          'codethread',
          '-d',
          'codethread_restart_test',
        ],
        { stdio: 'ignore' },
      );
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error('Disposable PostgreSQL did not become ready after restart');
}

function startWorker(root: string) {
  return spawn(process.execPath, [workerPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CODETHREAD_DATABASE_URL: databaseUrl!,
      CODETHREAD_ALLOWED_REPO_ROOT: root,
      CODETHREAD_ANALYZER_BUILD_HASH: buildHash,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
}

function ready(child: ChildProcess) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new Error('Worker not ready')),
      20_000,
    );
    const onMessage = (message: unknown) => {
      if (message === 'ready') finish();
    };
    const onExit = () => finish(new Error('Worker exited before ready'));
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

function exited(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error('Worker did not stop'));
    }, 10_000);
    function onExit() {
      clearTimeout(timer);
      resolve();
    }
    child.once('exit', onExit);
  });
}

async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (child.connected) child.send('stop');
  try {
    await exited(child);
  } catch {
    child.kill();
    await exited(child);
  }
}

describe.skipIf(!databaseUrl || !container)(
  'disposable PostgreSQL restart',
  () => {
    it('rolls back publication, fences the worker and recovers its pinned revision', async () => {
      const id = assertDisposableContainer();
      await waitForPostgres(id);
      const root = await mkdtemp(join(tmpdir(), 'ct-db-restart-')),
        folder = join(root, 'repo');
      await mkdir(folder);
      const git = (...args: string[]) =>
        execFileSync('git', ['-C', folder, ...args], {
          encoding: 'utf8',
        }).trim();
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
      let db = connect(databaseUrl!),
        child: ChildProcess | undefined,
        installed = false;
      let service = new ScanService(db, { root, analyzerBuildHash: buildHash });
      try {
        await applyMigrations(db);
        const pinned = await commit('pinnedRevision'),
          registered = await service.register(folder),
          queued = await service.accept(registered.id, 'HEAD', randomUUID());
        await db.unsafe(`CREATE FUNCTION codethread.test_pause_restart() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='published' THEN PERFORM pg_sleep(60); END IF;
        RETURN NEW; END $$`);
        await db.unsafe(`CREATE TRIGGER test_pause_restart BEFORE UPDATE OF state
        ON codethread.repository_snapshot FOR EACH ROW EXECUTE FUNCTION codethread.test_pause_restart()`);
        installed = true;
        child = startWorker(root);
        await ready(child);
        const deadline = Date.now() + 45_000;
        let blocked = false;
        while (Date.now() < deadline) {
          const rows =
            await db`SELECT pid FROM pg_stat_activity WHERE datname=current_database()
          AND application_name='codethread-worker' AND state='active' AND wait_event='PgSleep'
          AND query LIKE '%UPDATE codethread.repository_snapshot%'`;
          if (rows.length === 1) {
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(blocked).toBe(true);
        expect(await service.job(queued.id)).toMatchObject({
          state: 'running',
          git_commit_oid: pinned,
        });
        expect(await commit('movedHead')).not.toBe(pinned);
        execFileSync('docker', ['restart', '--time', '1', id], {
          stdio: 'ignore',
          timeout: 30_000,
        });
        await exited(child);
        expect(child.exitCode).toBe(1);
        child = undefined;
        await db.end({ timeout: 0 }).catch(() => {});
        await waitForPostgres(id);
        db = connect(databaseUrl!);
        service = new ScanService(db, { root, analyzerBuildHash: buildHash });
        const rolledBack = await db`SELECT
        (SELECT count(*)::integer FROM codethread.scan_project WHERE scan_job_id=${queued.id}) AS projects,
        (SELECT count(*)::integer FROM codethread.repository_snapshot WHERE repository_id=${registered.id}) AS snapshots,
        (SELECT active_job_id FROM codethread.repository WHERE id=${registered.id}) AS active_job_id`;
        expect(rolledBack[0]).toMatchObject({
          projects: 0,
          snapshots: 0,
          active_job_id: null,
        });
        expect(await service.job(queued.id)).toMatchObject({
          state: 'running',
          attempt: 1,
          git_commit_oid: pinned,
        });
        await db.unsafe(
          'DROP TRIGGER test_pause_restart ON codethread.repository_snapshot',
        );
        await db.unsafe('DROP FUNCTION codethread.test_pause_restart()');
        installed = false;
        child = startWorker(root);
        await ready(child);
        let job = await service.job(queued.id);
        const recoveryDeadline = Date.now() + 30_000;
        while (
          !['succeeded', 'failed', 'cancelled'].includes(job.state) &&
          Date.now() < recoveryDeadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          job = await service.job(queued.id);
        }
        expect(job).toMatchObject({
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
        const names = snapshot.facts.symbols.map((symbol) => symbol.name);
        expect(names).toContain('pinnedRevision');
        expect(names).not.toContain('movedHead');
      } finally {
        await stop(child);
        if (installed) {
          await waitForPostgres(id);
          await db.unsafe(
            'DROP TRIGGER IF EXISTS test_pause_restart ON codethread.repository_snapshot',
          );
          await db.unsafe(
            'DROP FUNCTION IF EXISTS codethread.test_pause_restart()',
          );
        }
        service.stop();
        await db.end({ timeout: 5 });
        await rm(root, { recursive: true, force: true });
      }
    }, 120_000);
  },
);
