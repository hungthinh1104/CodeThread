import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { connect } from '../scripts/backend/database.ts';
import { applyMigrations } from '../scripts/backend/migrations.ts';

const databaseUrl = process.env.CODETHREAD_TEST_DATABASE_URL;
const workerPath = fileURLToPath(
  new URL('./backend-scan-worker-process.ts', import.meta.url),
);

function startWorker(): ChildProcess {
  return spawn(process.execPath, [workerPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CODETHREAD_DATABASE_URL: databaseUrl!,
      CODETHREAD_ALLOWED_REPO_ROOT: tmpdir(),
      CODETHREAD_ANALYZER_BUILD_HASH: 'a'.repeat(64),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
}

function waitForReady(child: ChildProcess) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new Error('Worker did not start')),
      10_000,
    );
    const onMessage = (value: unknown) => {
      if (value === 'ready') finish();
    };
    const onExit = () => finish(new Error('Worker exited before readiness'));
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve();
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
  });
}

async function exitedWithin(child: ChildProcess, timeoutMs: number) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

async function stopChild(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (child.connected) child.send('stop');
  if (!(await exitedWithin(child, 2000))) child.kill();
  await exitedWithin(child, 2000);
}

describe.skipIf(!databaseUrl)('worker lock connection loss', () => {
  it('stops the old worker when another worker can acquire its lost lock', async () => {
    const db = connect(databaseUrl!);
    let first: ChildProcess | undefined;
    let second: ChildProcess | undefined;
    try {
      await applyMigrations(db);
      first = startWorker();
      await waitForReady(first);
      const locks = await db`SELECT pid FROM pg_locks
        WHERE locktype='advisory' AND classid=1919606126::oid
          AND objid=2::oid AND objsubid=2 AND granted`;
      expect(locks).toHaveLength(1);
      await db`SELECT pg_terminate_backend(${locks[0]!.pid})`;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const held = await db`SELECT pid FROM pg_locks
          WHERE locktype='advisory' AND classid=1919606126::oid
            AND objid=2::oid AND objsubid=2 AND granted`;
        if (!held.length) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      second = startWorker();
      await waitForReady(second);
      expect(await exitedWithin(first, 2000)).toBe(true);
    } finally {
      await stopChild(first);
      await stopChild(second);
      await db.end({ timeout: 5 });
    }
  }, 30_000);
});
