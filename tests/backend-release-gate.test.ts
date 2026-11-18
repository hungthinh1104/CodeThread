import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzerBuildHash } from '@codethread/symbol-indexer';
import { describe, expect, it } from 'vitest';
import {
  connect,
  requestHash,
  type Database,
} from '../scripts/backend/database.ts';
import { applyMigrations } from '../scripts/backend/migrations.ts';
import {
  startBackend,
  type BackendRuntime,
} from '../scripts/backend/runtime.ts';
import { ScanService } from '../scripts/backend/service.ts';
import { makeApi } from '../scripts/backend/http.ts';
import { storeSourceObjects } from '../scripts/backend/source-objects.ts';
import { persistScan } from '../scripts/backend/scan-persistence.ts';
import {
  persistScanInputs,
  persistScanPin,
} from '../scripts/backend/scan-provenance.ts';
import { acquireGitRepository } from '../scripts/git-source/repository-intake.ts';
import { analyzeGitRepository } from '../scripts/investigation/repository-session.ts';

const databaseUrl = process.env.CODETHREAD_TEST_DATABASE_URL;
const token = 'release-gate-test-token-0000000000000000';
const digest = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');

async function waitFor<T>(
  work: () => Promise<T>,
  accept: (value: T) => boolean,
) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = await work();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('Timed out waiting for release-gate condition');
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
  return address.port;
}

async function fixture(
  source = 'export function actualSource() { return 1; }\n',
) {
  const root = await mkdtemp(join(tmpdir(), 'ct-release-gate-'));
  const folder = join(root, 'repo');
  await mkdir(folder);
  await writeFile(join(folder, 'index.ts'), source);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', folder, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '--object-format=sha1');
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
  const db = connect(databaseUrl!);
  await applyMigrations(db);
  return {
    root,
    folder,
    db,
    git,
    commit: git('rev-parse', 'HEAD'),
    tree: git('rev-parse', 'HEAD^{tree}'),
    blob: git('rev-parse', 'HEAD:index.ts'),
  };
}

async function start(root: string) {
  const port = await freePort();
  const runtime = await startBackend({
    url: databaseUrl!,
    root,
    port,
    secret: token,
    analyzerBuildHash: analyzerBuildHash(),
  });
  const health = () =>
    fetch(`http://127.0.0.1:${port}/v1/health`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  await waitFor(health, (response) => response.status === 200);
  return { runtime, health, base: `http://127.0.0.1:${port}` };
}

async function terminal(service: ScanService, id: string) {
  return waitFor(
    () => service.job(id),
    (row) => ['succeeded', 'failed', 'cancelled'].includes(row.state),
  );
}

async function installTrigger(
  db: Database,
  table: 'scan_job' | 'scan_input_file',
  condition: string,
  action: string,
) {
  await db.unsafe(`CREATE FUNCTION codethread.release_gate_fault() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF ${condition} THEN ${action}; END IF; RETURN NEW; END $$`);
  await db.unsafe(`CREATE TRIGGER release_gate_fault BEFORE ${table === 'scan_job' ? 'UPDATE' : 'INSERT'}
    ON codethread.${table} FOR EACH ROW EXECUTE FUNCTION codethread.release_gate_fault()`);
}

async function dropTrigger(
  db: Database,
  table: 'scan_job' | 'scan_input_file',
) {
  await db.unsafe(
    `DROP TRIGGER IF EXISTS release_gate_fault ON codethread.${table}`,
  );
  await db.unsafe('DROP FUNCTION IF EXISTS codethread.release_gate_fault()');
}

describe.skipIf(!databaseUrl)('backend release gate with PostgreSQL', () => {
  it('reports claim failures and recovers, while user scan failures leave idle readiness healthy', async () => {
    const f = await fixture();
    let runtime: BackendRuntime | undefined;
    try {
      const started = await start(f.root);
      runtime = started.runtime;
      const repo = await runtime.service.register(f.folder);
      const invalid = await runtime.service.accept(
        repo.id,
        'missing-ref',
        randomUUID(),
      );
      expect((await terminal(runtime.service, invalid.id)).state).toBe(
        'failed',
      );
      expect((await started.health()).status).toBe(200);
      await installTrigger(
        f.db,
        'scan_job',
        `NEW.state='running' AND NEW.repository_id='${repo.id}'`,
        "PERFORM pg_sleep(2); RAISE EXCEPTION 'claim unavailable'",
      );
      const queued = await runtime.service.accept(
        repo.id,
        'HEAD',
        randomUUID(),
      );
      await waitFor(started.health, (response) => response.status === 503);
      await waitFor(
        () => f.db`SELECT pid FROM pg_stat_activity
          WHERE application_name='codethread-worker' AND wait_event='PgSleep'`,
        (rows) => rows.length === 1,
      );
      expect((await started.health()).status).toBe(503);
      expect((await runtime.service.job(queued.id)).state).toBe('queued');
      await dropTrigger(f.db, 'scan_job');
      expect((await terminal(runtime.service, queued.id)).state).toBe(
        'succeeded',
      );
      await waitFor(started.health, (response) => response.status === 200);
    } finally {
      await dropTrigger(f.db, 'scan_job');
      await runtime?.shutdown();
      await f.db.end({ timeout: 5 });
      await rm(f.root, { recursive: true, force: true });
    }
  }, 90_000);

  it('settles a failed job after a temporary PostgreSQL error without restarting', async () => {
    const f = await fixture();
    let runtime: BackendRuntime | undefined;
    try {
      const started = await start(f.root);
      runtime = started.runtime;
      const repo = await runtime.service.register(f.folder);
      await installTrigger(
        f.db,
        'scan_job',
        "OLD.state='running' AND NEW.state='failed'",
        "RAISE EXCEPTION 'settlement unavailable'",
      );
      const job = await runtime.service.accept(
        repo.id,
        'missing-ref',
        randomUUID(),
      );
      await waitFor(started.health, (response) => response.status === 503);
      expect((await runtime.service.job(job.id)).state).toBe('running');
      await dropTrigger(f.db, 'scan_job');
      expect((await terminal(runtime.service, job.id)).state).toBe('failed');
      await waitFor(started.health, (response) => response.status === 200);
    } finally {
      await dropTrigger(f.db, 'scan_job');
      await runtime?.shutdown();
      await f.db.end({ timeout: 5 });
      await rm(f.root, { recursive: true, force: true });
    }
  }, 90_000);

  it('retries a pinned database failure a bounded number of times and recovers readiness', async () => {
    const f = await fixture();
    let runtime: BackendRuntime | undefined;
    let barrier: Awaited<ReturnType<typeof f.db.reserve>> | undefined;
    try {
      const started = await start(f.root);
      runtime = started.runtime;
      const repo = await runtime.service.register(f.folder);
      barrier = await f.db.reserve();
      await barrier`SELECT pg_advisory_lock(1919606130,1)`;
      await f.db
        .unsafe(`CREATE FUNCTION codethread.release_gate_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.state='running' AND NEW.attempt>=4 THEN PERFORM pg_advisory_xact_lock(1919606130,1); END IF; RETURN NEW; END $$`);
      await f.db
        .unsafe(`CREATE TRIGGER release_gate_barrier BEFORE UPDATE ON codethread.scan_job
        FOR EACH ROW EXECUTE FUNCTION codethread.release_gate_barrier()`);
      await installTrigger(
        f.db,
        'scan_input_file',
        'TRUE',
        "RAISE EXCEPTION 'input persistence unavailable'",
      );
      const job = await runtime.service.accept(repo.id, 'HEAD', randomUUID());
      await waitFor(started.health, (response) => response.status === 503);
      expect(
        (await runtime.service.job(job.id)).attempt,
      ).toBeGreaterThanOrEqual(3);
      await dropTrigger(f.db, 'scan_input_file');
      await barrier`SELECT pg_advisory_unlock(1919606130,1)`;
      await barrier.release();
      barrier = undefined;
      const completed = await terminal(runtime.service, job.id);
      expect(completed.state).toBe('succeeded');
      expect(completed.git_commit_oid).toBe(f.commit);
      expect(completed.attempt).toBeGreaterThanOrEqual(4);
      expect(completed.error_code).toBeNull();
      await waitFor(started.health, (response) => response.status === 200);
    } finally {
      if (barrier) {
        await barrier`SELECT pg_advisory_unlock(1919606130,1)`;
        await barrier.release();
      }
      await dropTrigger(f.db, 'scan_input_file');
      await f.db.unsafe(
        'DROP TRIGGER IF EXISTS release_gate_barrier ON codethread.scan_job',
      );
      await f.db.unsafe(
        'DROP FUNCTION IF EXISTS codethread.release_gate_barrier()',
      );
      await runtime?.shutdown();
      await f.db.end({ timeout: 5 });
      await rm(f.root, { recursive: true, force: true });
    }
  }, 90_000);

  it('stops retrying a persistently failing pinned job after five attempts', async () => {
    const f = await fixture();
    let runtime: BackendRuntime | undefined;
    try {
      const started = await start(f.root);
      runtime = started.runtime;
      const repo = await runtime.service.register(f.folder);
      await installTrigger(
        f.db,
        'scan_input_file',
        'TRUE',
        "RAISE EXCEPTION 'persistent database failure'",
      );
      const job = await runtime.service.accept(repo.id, 'HEAD', randomUUID());
      expect(await terminal(runtime.service, job.id)).toMatchObject({
        state: 'failed',
        attempt: 5,
      });
      expect((await started.health()).status).toBe(503);
      await dropTrigger(f.db, 'scan_input_file');
      await waitFor(started.health, (response) => response.status === 200);
      const probes =
        await f.db`SELECT count(*)::integer AS total FROM codethread.repository WHERE local_locator='readiness-probe'`;
      expect(probes[0]?.total).toBe(0);
      expect((await runtime.service.job(job.id)).state).toBe('failed');
      const next = await runtime.service.accept(repo.id, 'HEAD', randomUUID());
      expect((await terminal(runtime.service, next.id)).state).toBe(
        'succeeded',
      );
      await waitFor(started.health, (response) => response.status === 200);
    } finally {
      await dropTrigger(f.db, 'scan_input_file');
      await runtime?.shutdown();
      await f.db.end({ timeout: 5 });
      await rm(f.root, { recursive: true, force: true });
    }
  }, 90_000);

  it('marks a blocked failure settlement unavailable and resumes after cancellation', async () => {
    const f = await fixture();
    let runtime: BackendRuntime | undefined;
    try {
      const started = await start(f.root);
      runtime = started.runtime;
      const repo = await runtime.service.register(f.folder);
      await installTrigger(
        f.db,
        'scan_job',
        "OLD.state='running' AND NEW.state='failed'",
        'PERFORM pg_sleep(20)',
      );
      const job = await runtime.service.accept(
        repo.id,
        'missing-ref',
        randomUUID(),
      );
      const worker = await waitFor(
        () =>
          f.db`SELECT pid FROM pg_stat_activity WHERE application_name='codethread-worker' AND wait_event='PgSleep'`,
        (rows) => rows.length === 1,
      );
      await waitFor(started.health, (response) => response.status === 503);
      await f.db`SELECT pg_cancel_backend(${worker[0]!.pid})`;
      await dropTrigger(f.db, 'scan_job');
      expect((await terminal(runtime.service, job.id)).state).toBe('failed');
      await waitFor(started.health, (response) => response.status === 200);
    } finally {
      await f.db`SELECT pg_cancel_backend(pid) FROM pg_stat_activity
        WHERE application_name='codethread-worker' AND wait_event='PgSleep'`;
      await dropTrigger(f.db, 'scan_job');
      await runtime?.shutdown();
      await f.db.end({ timeout: 5 });
      await rm(f.root, { recursive: true, force: true });
    }
  }, 90_000);

  it('marks a blocked database claim unavailable and recovers after cancellation', async () => {
    const f = await fixture();
    let runtime: BackendRuntime | undefined;
    try {
      const started = await start(f.root);
      runtime = started.runtime;
      const repo = await runtime.service.register(f.folder);
      await installTrigger(
        f.db,
        'scan_job',
        "NEW.state='running'",
        'PERFORM pg_sleep(20)',
      );
      const job = await runtime.service.accept(repo.id, 'HEAD', randomUUID());
      const worker = await waitFor(
        () =>
          f.db`SELECT pid FROM pg_stat_activity WHERE application_name='codethread-worker' AND wait_event='PgSleep'`,
        (rows) => rows.length === 1,
      );
      await waitFor(started.health, (response) => response.status === 503);
      expect((await runtime.service.job(job.id)).state).toBe('queued');
      await f.db`SELECT pg_cancel_backend(${worker[0]!.pid})`;
      await dropTrigger(f.db, 'scan_job');
      expect((await terminal(runtime.service, job.id)).state).toBe('succeeded');
      await waitFor(started.health, (response) => response.status === 200);
    } finally {
      await f.db`SELECT pg_cancel_backend(pid) FROM pg_stat_activity
        WHERE application_name='codethread-worker' AND wait_event='PgSleep'`;
      await dropTrigger(f.db, 'scan_job');
      await runtime?.shutdown();
      await f.db.end({ timeout: 5 });
      await rm(f.root, { recursive: true, force: true });
    }
  }, 90_000);

  it('uses the same Unicode matching rules for PostgreSQL search and result validation', async () => {
    const f = await fixture('export function i() {}\nexport function İ() {}\n');
    let runtime: BackendRuntime | undefined;
    try {
      const started = await start(f.root);
      runtime = started.runtime;
      const repo = await runtime.service.register(f.folder);
      const job = await runtime.service.accept(repo.id, 'HEAD', randomUUID());
      expect((await terminal(runtime.service, job.id)).state).toBe('succeeded');
      const project = (await runtime.service.projects(job.id)).find(
        (item) => item.status === 'ready',
      )!;
      const endpoint = `${started.base}/v1/scans/${job.id}/projects/${encodeURIComponent(String(project.project_id))}/symbols`;
      const search = async (query: string, offset = 0) => {
        const response = await fetch(
          `${endpoint}?query=${encodeURIComponent(query)}&offset=${offset}`,
          {
            headers: { Authorization: `Bearer ${token}` },
          },
        );
        expect(response.status).toBe(200);
        return response.json() as Promise<{
          total: number;
          items: { name: string }[];
          nextOffset: number | null;
        }>;
      };
      expect((await search('İ')).items.map((item) => item.name)).toEqual(['İ']);
      expect((await search('i\u0307')).items.map((item) => item.name)).toEqual([
        'İ',
      ]);
      expect(await search('i\u0307', 50)).toMatchObject({
        total: 1,
        items: [],
        nextOffset: null,
      });
    } finally {
      await runtime?.shutdown();
      await f.db.end({ timeout: 5 });
      await rm(f.root, { recursive: true, force: true });
    }
  }, 90_000);

  it('accepts every advertised input continuation within the source and metadata bounds', async () => {
    const f = await fixture();
    const port = await freePort();
    const service = new ScanService(f.db, {
      root: f.root,
      analyzerBuildHash: analyzerBuildHash(),
    });
    const api = makeApi(f.db, service, token, port);
    try {
      const repo = await service.register(f.folder),
        job = await service.accept(repo.id, 'HEAD', randomUUID());
      await f.db`UPDATE codethread.scan_job SET state='running',attempt=1 WHERE id=${job.id}`;
      await persistScanPin(f.db, job.id, repo.id, '1', 1, {
        commitId: f.commit,
        rootTreeId: f.tree,
        objectFormat: 'sha1',
      });
      const bytes = Buffer.from('fixture');
      const hash = digest(bytes);
      await storeSourceObjects(f.db, [{ sha256: hash, bytes }]);
      await f.db`INSERT INTO codethread.scan_input_file
        (scan_job_id,path,git_blob_oid,git_mode,content_hash,input_kind)
        SELECT ${job.id}, 'input/' || lpad(n::text,4,'0') || CASE WHEN n <= 1000 THEN '.ts' ELSE '.json' END,
          ${f.blob},'100644',${hash},CASE WHEN n <= 1000 THEN 'source' ELSE 'metadata' END
        FROM generate_series(1,1101) AS n`;
      await new Promise<void>((resolve) =>
        api.listen(port, '127.0.0.1', resolve),
      );
      const page = async (offset: number) => {
        const response = await fetch(
          `http://127.0.0.1:${port}/v1/scans/${job.id}/files?offset=${offset}`,
          {
            headers: { Authorization: `Bearer ${token}` },
          },
        );
        expect(response.status).toBe(200);
        return response.json() as Promise<{
          total: number;
          nextOffset: number | null;
          items: unknown[];
        }>;
      };
      expect(await page(1000)).toMatchObject({ total: 1101, nextOffset: 1050 });
      expect(await page(1050)).toMatchObject({ total: 1101, nextOffset: 1100 });
      expect(await page(1100)).toMatchObject({
        total: 1101,
        nextOffset: null,
        items: [{}],
      });
    } finally {
      if (api.listening)
        await new Promise<void>((resolve) => api.close(() => resolve()));
      service.stop();
      await f.db.end({ timeout: 5 });
      await rm(f.root, { recursive: true, force: true });
    }
  }, 90_000);

  it('fails a recovered old build and keeps identical idempotent retries stable', async () => {
    const f = await fixture();
    let runtime: BackendRuntime | undefined;
    try {
      const oldBuild = '0'.repeat(64);
      expect(oldBuild).not.toBe(analyzerBuildHash());
      const service = new ScanService(f.db, {
        root: f.root,
        analyzerBuildHash: analyzerBuildHash(),
      });
      const repo = await service.register(f.folder),
        id = randomUUID(),
        key = randomUUID();
      const current = await service.accept(repo.id, 'HEAD', randomUUID());
      const original = (
        await f.db`SELECT configuration_hash,analyzer_version FROM codethread.scan_job WHERE id=${current.id}`
      )[0]!;
      await service.cancel(current.id);
      const request = requestHash({
        repositoryId: repo.id,
        revision: 'HEAD',
        configurationHash: original.configuration_hash,
        analyzerVersion: original.analyzer_version,
        analyzerBuildHash: oldBuild,
        scope: 'repository',
      });
      await f.db`UPDATE codethread.repository SET desired_generation=2 WHERE id=${repo.id}`;
      await f.db`INSERT INTO codethread.scan_job
        (id,repository_id,generation,idempotency_key,request_hash,revision_selector,
         configuration_hash,analyzer_version,analyzer_build_hash,state,attempt,
         git_object_format,git_commit_oid,git_tree_oid)
        VALUES (${id},${repo.id},2,${key},${request},'HEAD',${original.configuration_hash},
          ${original.analyzer_version},${oldBuild},'running',1,'sha1',${f.commit},${f.tree})`;
      expect(await service.accept(repo.id, 'HEAD', key)).toMatchObject({
        id,
        reused: true,
      });
      await expect(
        service.accept(repo.id, 'different-ref', key),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      const started = await start(f.root);
      runtime = started.runtime;
      expect(await terminal(runtime.service, id)).toMatchObject({
        state: 'failed',
        error_code: 'ANALYZER_BUILD_MISMATCH',
      });
      const state = await f.db`SELECT active_job_id,
        (SELECT count(*)::integer FROM codethread.repository_snapshot WHERE repository_id=${repo.id}) AS snapshots
        FROM codethread.repository WHERE id=${repo.id}`;
      expect(state[0]).toMatchObject({ active_job_id: null, snapshots: 0 });
    } finally {
      await runtime?.shutdown();
      await f.db.end({ timeout: 5 });
      await rm(f.root, { recursive: true, force: true });
    }
  }, 90_000);

  it('rejects forged session bytes and snapshot identities before publication', async () => {
    const f = await fixture();
    try {
      const service = new ScanService(f.db, {
        root: f.root,
        analyzerBuildHash: analyzerBuildHash(),
      });
      const repo = await service.register(f.folder),
        job = await service.accept(repo.id, 'HEAD', randomUUID());
      await f.db`UPDATE codethread.scan_job SET state='running',attempt=1 WHERE id=${job.id}`;
      const request = {
        repositoryPath: f.folder,
        repositoryId: repo.id,
        revision: 'HEAD',
      };
      const acquired = await acquireGitRepository(request, () => {}, {
        onPinned: (pin) => persistScanPin(f.db, job.id, repo.id, '1', 1, pin),
        onFilesAcquired: (files, sourcePaths) =>
          persistScanInputs(
            f.db,
            job.id,
            repo.id,
            '1',
            1,
            { commitId: f.commit, rootTreeId: f.tree, objectFormat: 'sha1' },
            files,
            new Set(sourcePaths),
          ),
      });
      const pinnedRequest = { ...request, revision: acquired.commitId };
      const valid = await analyzeGitRepository(pinnedRequest, acquired);
      const file = acquired.files[0]!,
        bytes = Buffer.from('export function forgedSource() { return 9; }\n');
      const forged = {
        ...acquired,
        files: [{ ...file, bytes, sha256: digest(bytes) }],
      };
      const wrong = await analyzeGitRepository(pinnedRequest, forged);
      await expect(
        persistScan(f.db, job.id, repo.id, acquired, wrong, '1', 1),
      ).rejects.toThrow('Session source manifest');
      await expect(
        persistScan(
          f.db,
          job.id,
          repo.id,
          acquired,
          { ...wrong, files: valid.files },
          '1',
          1,
        ),
      ).rejects.toThrow('Snapshot identity');
      const wrongProject = wrong.projects.find((item) => item.snapshot)!;
      const validProject = valid.projects.find((item) => item.snapshot)!;
      const forgedProject = {
        ...wrongProject,
        snapshot: {
          ...wrongProject.snapshot!,
          facts: {
            ...wrongProject.snapshot!.facts,
            identity: {
              ...wrongProject.snapshot!.facts.identity,
              sourceFingerprint:
                validProject.snapshot!.facts.identity.sourceFingerprint,
            },
          },
        },
      };
      await expect(
        persistScan(
          f.db,
          job.id,
          repo.id,
          acquired,
          {
            ...wrong,
            files: valid.files,
            projects: wrong.projects.map((item) =>
              item === wrongProject ? forgedProject : item,
            ),
          },
          '1',
          1,
        ),
      ).rejects.toThrow('Snapshot source');
      const project = valid.projects.find((item) => item.snapshot)!;
      const changed = {
        ...project,
        snapshot: {
          ...project.snapshot!,
          facts: {
            ...project.snapshot!.facts,
            identity: {
              ...project.snapshot!.facts.identity,
              analyzerBuildHash: '0'.repeat(64),
            },
          },
        },
      };
      await expect(
        persistScan(
          f.db,
          job.id,
          repo.id,
          acquired,
          {
            ...valid,
            projects: valid.projects.map((item) =>
              item === project ? changed : item,
            ),
          },
          '1',
          1,
        ),
      ).rejects.toMatchObject({ code: 'ANALYZER_BUILD_MISMATCH' });
      await f.db`INSERT INTO codethread.scan_project
        (repository_id,scan_job_id,project_id,project_label,project_json,status,diagnostics)
        VALUES (${repo.id},${job.id},'extra-project','extra','{}'::jsonb,'failed','[]'::jsonb)`;
      await expect(
        persistScan(f.db, job.id, repo.id, acquired, valid, '1', 1),
      ).rejects.toThrow('Scan already has project mappings');
      await f.db`DELETE FROM codethread.scan_project WHERE scan_job_id=${job.id} AND project_id='extra-project'`;
      await persistScan(f.db, job.id, repo.id, acquired, valid, '1', 1);
      expect((await service.job(job.id)).state).toBe('succeeded');
      const input =
        await f.db`SELECT * FROM codethread.scan_input_file WHERE scan_job_id=${job.id} LIMIT 1`;
      await expect(f.db`INSERT INTO codethread.scan_input_file
        (scan_job_id,path,git_blob_oid,git_mode,content_hash,input_kind)
        VALUES (${job.id},'late.ts',${input[0]!.git_blob_oid},${input[0]!.git_mode},${input[0]!.content_hash},'source')`).rejects.toThrow(
        'scan inputs require a running job',
      );
      await expect(f.db`INSERT INTO codethread.scan_project
        (repository_id,scan_job_id,project_id,project_label,project_json,status,snapshot_id,diagnostics)
        SELECT repository_id,scan_job_id,'late-project',project_label,project_json,status,snapshot_id,diagnostics
        FROM codethread.scan_project WHERE scan_job_id=${job.id} LIMIT 1`).rejects.toThrow(
        'scan projects require a running job',
      );
      await expect(
        f.db`UPDATE codethread.scan_job SET activation_result='stale' WHERE id=${job.id}`,
      ).rejects.toThrow('terminal scan result is immutable');
    } finally {
      await f.db.end({ timeout: 5 });
      await rm(f.root, { recursive: true, force: true });
    }
  }, 120_000);
});
