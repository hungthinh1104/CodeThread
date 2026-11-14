import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzerBuildHash } from '@codethread/symbol-indexer';
import { describe, expect, it } from 'vitest';
import { connect } from '../scripts/backend/database.ts';
import { applyMigrations } from '../scripts/backend/migrations.ts';
import {
  startBackend,
  type BackendRuntime,
} from '../scripts/backend/runtime.ts';
import { ScanService } from '../scripts/backend/service.ts';

const databaseUrl = process.env.CODETHREAD_TEST_DATABASE_URL;
const token = 'probe-readiness-test-token-000000000000000';

async function waitFor<T>(
  work: () => Promise<T>,
  matches: (value: T) => boolean,
) {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const value = await work();
    if (matches(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for recovery probe');
}

async function reservePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
  return address.port;
}

describe.skipIf(!databaseUrl)('least-privilege worker recovery probes', () => {
  it('checks publication writes and deferred constraints without retaining probe rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ct-probe-test-'));
    const folder = join(root, 'repo');
    await mkdir(folder);
    await writeFile(
      join(folder, 'index.ts'),
      'export function actual() { return 1; }\n',
    );
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
    const admin = connect(databaseUrl!);
    const role = 'ct_probe_' + randomUUID().replaceAll('-', '');
    const emptyHash = createHash('sha256').update('').digest('hex');
    let runtime: BackendRuntime | undefined;
    let roleCreated = false;
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
      await admin.unsafe('CREATE SEQUENCE codethread.probe_symbol_failures');
      await admin.unsafe('CREATE SEQUENCE codethread.probe_deferred_failures');
      await admin.unsafe(
        'GRANT USAGE, SELECT ON SEQUENCE codethread.probe_symbol_failures, codethread.probe_deferred_failures TO codethread_runtime',
      );
      await admin.unsafe(`CREATE FUNCTION codethread.probe_reject_symbol() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM nextval('codethread.probe_symbol_failures'); RAISE EXCEPTION 'symbol write unavailable'; END $$`);
      await admin.unsafe(`CREATE TRIGGER probe_reject_symbol BEFORE INSERT ON codethread.code_symbol
        FOR EACH ROW EXECUTE FUNCTION codethread.probe_reject_symbol()`);
      await admin.unsafe(`CREATE FUNCTION codethread.probe_reject_deferred() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM nextval('codethread.probe_deferred_failures'); RAISE EXCEPTION 'deferred activation unavailable'; END $$`);
      await admin.unsafe(`CREATE CONSTRAINT TRIGGER probe_reject_deferred AFTER UPDATE ON codethread.repository
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.local_locator='readiness-probe')
        EXECUTE FUNCTION codethread.probe_reject_deferred()`);
      const before =
        await admin`SELECT count(*)::integer AS total FROM codethread.source_object WHERE sha256=${emptyHash}`;
      const runtimeUrl = new URL(databaseUrl!);
      runtimeUrl.username = role;
      runtimeUrl.password = 'integration-only-password';
      const port = await reservePort();
      runtime = await startBackend({
        url: runtimeUrl.toString(),
        root,
        port,
        secret: token,
        analyzerBuildHash: analyzerBuildHash(),
      });
      const health = () =>
        fetch(`http://127.0.0.1:${port}/v1/health`, {
          headers: { Authorization: `Bearer ${token}` },
        });
      await waitFor(
        () => admin`SELECT is_called FROM codethread.probe_symbol_failures`,
        (rows) => !!rows[0]!.is_called,
      );
      expect((await health()).status).toBe(503);
      await admin.unsafe(
        'DROP TRIGGER probe_reject_symbol ON codethread.code_symbol',
      );
      await admin.unsafe(
        'DROP TRIGGER probe_reject_deferred ON codethread.repository',
      );
      await waitFor(health, (response) => response.status === 200);
      await admin.unsafe(
        'ALTER SEQUENCE codethread.probe_symbol_failures RESTART WITH 1',
      );
      await admin.unsafe(
        'ALTER SEQUENCE codethread.probe_deferred_failures RESTART WITH 1',
      );
      await admin.unsafe(`CREATE TRIGGER probe_reject_symbol BEFORE INSERT ON codethread.code_symbol
        FOR EACH ROW EXECUTE FUNCTION codethread.probe_reject_symbol()`);
      await admin.unsafe(`CREATE CONSTRAINT TRIGGER probe_reject_deferred AFTER UPDATE ON codethread.repository
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.local_locator='readiness-probe')
        EXECUTE FUNCTION codethread.probe_reject_deferred()`);
      const repo = await runtime.service.register(folder);
      const job = await runtime.service.accept(repo.id, 'HEAD', randomUUID());
      const terminal = await waitFor(
        () => runtime!.service.job(job.id),
        (row) => row.state === 'failed',
      );
      expect(terminal.attempt).toBe(5);
      await waitFor(
        () =>
          admin`SELECT last_value,is_called FROM codethread.probe_symbol_failures`,
        (rows) => rows[0]!.is_called && Number(rows[0]!.last_value) >= 6,
      );
      expect((await health()).status).toBe(503);
      await admin.unsafe(
        'DROP TRIGGER probe_reject_symbol ON codethread.code_symbol',
      );
      await admin.unsafe('DROP FUNCTION codethread.probe_reject_symbol()');
      await waitFor(
        () => admin`SELECT is_called FROM codethread.probe_deferred_failures`,
        (rows) => !!rows[0]!.is_called,
      );
      expect((await health()).status).toBe(503);
      await admin.unsafe(
        'DROP TRIGGER probe_reject_deferred ON codethread.repository',
      );
      await admin.unsafe('DROP FUNCTION codethread.probe_reject_deferred()');
      await waitFor(health, (response) => response.status === 200);
      expect(
        (
          await admin`SELECT count(*)::integer AS total FROM codethread.repository WHERE local_locator='readiness-probe'`
        )[0]?.total,
      ).toBe(0);
      const after =
        await admin`SELECT count(*)::integer AS total FROM codethread.source_object WHERE sha256=${emptyHash}`;
      expect(after[0]?.total).toBe(before[0]?.total);
    } finally {
      await runtime?.shutdown();
      await admin.unsafe(
        'DROP TRIGGER IF EXISTS probe_reject_symbol ON codethread.code_symbol',
      );
      await admin.unsafe(
        'DROP FUNCTION IF EXISTS codethread.probe_reject_symbol()',
      );
      await admin.unsafe(
        'DROP TRIGGER IF EXISTS probe_reject_deferred ON codethread.repository',
      );
      await admin.unsafe(
        'DROP FUNCTION IF EXISTS codethread.probe_reject_deferred()',
      );
      await admin.unsafe(
        'DROP SEQUENCE IF EXISTS codethread.probe_symbol_failures',
      );
      await admin.unsafe(
        'DROP SEQUENCE IF EXISTS codethread.probe_deferred_failures',
      );
      if (roleCreated) await admin.unsafe(`DROP ROLE "${role}"`);
      await admin.end({ timeout: 5 });
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('does not restart pinned jobs that already exhausted five attempts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ct-retry-bound-'));
    const folder = join(root, 'repo');
    await mkdir(folder);
    const db = connect(databaseUrl!);
    let runtime: BackendRuntime | undefined;
    try {
      await applyMigrations(db);
      const service = new ScanService(db, {
        root,
        analyzerBuildHash: analyzerBuildHash(),
      });
      const repo = await service.register(folder);
      const jobs = [
        await service.accept(repo.id, 'HEAD', randomUUID()),
        await service.accept(repo.id, 'HEAD', randomUUID()),
      ];
      const oid = 'a'.repeat(40);
      for (const job of jobs) {
        await db`UPDATE codethread.scan_job SET state='running',attempt=1 WHERE id=${job.id}`;
        await db`UPDATE codethread.scan_job SET git_object_format='sha1',git_commit_oid=${oid},git_tree_oid=${oid} WHERE id=${job.id}`;
        for (let attempt = 2; attempt <= 5; attempt++) {
          await db`UPDATE codethread.scan_job SET state='queued' WHERE id=${job.id}`;
          await db`UPDATE codethread.scan_job SET state='running',attempt=${attempt} WHERE id=${job.id}`;
        }
      }
      await db`UPDATE codethread.scan_job SET state='queued' WHERE id=${jobs[1]!.id}`;
      const port = await reservePort();
      runtime = await startBackend({
        url: databaseUrl!,
        root,
        port,
        secret: token,
        analyzerBuildHash: analyzerBuildHash(),
      });
      for (const job of jobs)
        expect(await runtime.service.job(job.id)).toMatchObject({
          state: 'failed',
          attempt: 5,
          error_code: 'RETRY_LIMIT_EXCEEDED',
          git_commit_oid: oid,
        });
    } finally {
      await runtime?.shutdown();
      await db.end({ timeout: 5 });
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000);

  it('detects a changed installed analyzer while idle and recovers when restored', async () => {
    await mkdir(join(process.cwd(), '.tooling'), { recursive: true });
    const root = await mkdtemp(
      join(process.cwd(), '.tooling', 'ct-install-test-'),
    );
    const db = connect(databaseUrl!);
    let child: ChildProcess | undefined;
    try {
      await applyMigrations(db);
      await cp('scripts', join(root, 'scripts'), { recursive: true });
      await mkdir(join(root, 'db'), { recursive: true });
      await cp('db/migrations', join(root, 'db', 'migrations'), {
        recursive: true,
      });
      await mkdir(join(root, 'tests'), { recursive: true });
      await cp(
        'tests/backend-http-process.ts',
        join(root, 'tests', 'backend-http-process.ts'),
      );
      for (const name of ['symbol-indexer', 'code-model']) {
        const destination = join(root, 'node_modules', '@codethread', name);
        await mkdir(destination, { recursive: true });
        await cp(
          join('packages', name, 'package.json'),
          join(destination, 'package.json'),
        );
        await cp(join('packages', name, 'dist'), join(destination, 'dist'), {
          recursive: true,
        });
      }
      const port = await reservePort();
      child = spawn(
        process.execPath,
        [join(root, 'tests', 'backend-http-process.ts')],
        {
          cwd: root,
          env: {
            ...process.env,
            CODETHREAD_DATABASE_URL: databaseUrl!,
            CODETHREAD_ALLOWED_REPO_ROOT: tmpdir(),
            CODETHREAD_API_TOKEN: token,
            CODETHREAD_ANALYZER_BUILD_HASH: analyzerBuildHash(),
            CODETHREAD_TEST_API_PORT: String(port),
          },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        },
      );
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Copied backend did not start')),
          20_000,
        );
        child!.once('exit', () => {
          clearTimeout(timer);
          reject(new Error('Copied backend exited'));
        });
        child!.on('message', (message) => {
          if (message === 'ready') {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      const health = () =>
        fetch(`http://127.0.0.1:${port}/v1/health`, {
          headers: { Authorization: `Bearer ${token}` },
        });
      await waitFor(health, (response) => response.status === 200);
      const worker = join(
        root,
        'node_modules',
        '@codethread',
        'symbol-indexer',
        'dist',
        'worker.js',
      );
      const original = await readFile(worker);
      await writeFile(
        worker,
        Buffer.concat([original, Buffer.from('\n// tampered\n')]),
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
      await writeFile(worker, original);
      await waitFor(health, (response) => response.status === 200);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exiting = new Promise<void>((resolve) =>
          child!.once('exit', () => resolve()),
        );
        child.send('stop');
        await exiting;
      }
      await db.end({ timeout: 5 });
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000);
});
