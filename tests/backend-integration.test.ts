import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { connect, assertMigrations } from '../scripts/backend/database.ts';
import { applyMigrations } from '../scripts/backend/migrations.ts';
import { ScanService } from '../scripts/backend/service.ts';
import { persistScan } from '../scripts/backend/scan-persistence.ts';
import { loadSnapshot } from '../scripts/backend/snapshot-persistence.ts';
import {
  persistScanInputs,
  persistScanPin,
} from '../scripts/backend/scan-provenance.ts';
import { acquireGitRepository } from '../scripts/git-source/repository-intake.ts';
import { analyzeGitRepository } from '../scripts/investigation/repository-session.ts';
import { makeApi } from '../scripts/backend/http.ts';
import { PersistentViewerManager } from '../scripts/backend/viewer-adapter.ts';
import { storeSourceObjects } from '../scripts/backend/source-objects.ts';

const dbUrl = process.env.CODETHREAD_TEST_DATABASE_URL;
const digest = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');

async function createGitFixture(parent: string, source: string) {
  const folder = join(parent, 'repo');
  await mkdir(folder);
  await writeFile(join(folder, 'index.ts'), source);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', folder, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
    });
  git('init', '-q');
  git(
    '-c',
    'user.name=CodeThread Test',
    '-c',
    'user.email=test@example.invalid',
    'add',
    'index.ts',
  );
  git(
    '-c',
    'user.name=CodeThread Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-qm',
    'Pinned semantic source',
  );
  return { folder, git, commit: git('rev-parse', 'HEAD').trim() };
}

async function waitForTerminalJob(service: ScanService, jobId: string) {
  const deadline = Date.now() + 30_000;
  let last: Awaited<ReturnType<ScanService['job']>> | undefined;
  while (Date.now() < deadline) {
    last = await service.job(jobId);
    if (['succeeded', 'failed', 'cancelled'].includes(last.state)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Timed out waiting for scan ${jobId}; last state=${last?.state}`,
  );
}

async function prepareClaimedScan(
  db: ReturnType<typeof connect>,
  service: ScanService,
  fixture: Awaited<ReturnType<typeof createGitFixture>>,
  repositoryId?: string,
) {
  const registered = repositoryId
      ? { id: repositoryId }
      : await service.register(fixture.folder),
    queued = await service.accept(registered.id, 'HEAD', randomUUID()),
    row = await service.job(queued.id),
    generation = String(row.generation),
    attempt = 1;
  await db`UPDATE codethread.scan_job SET state='running',attempt=${attempt}
    WHERE id=${queued.id} AND state='queued'`;
  const request = {
    repositoryPath: fixture.folder,
    repositoryId: registered.id,
    revision: 'HEAD',
  };
  let pin: {
    commitId: string;
    rootTreeId: string;
    objectFormat: 'sha1' | 'sha256';
  } | null = null;
  const acquired = await acquireGitRepository(request, () => {}, {
    onPinned: async (resolved) => {
      pin = resolved;
      await persistScanPin(
        db,
        queued.id,
        registered.id,
        generation,
        attempt,
        resolved,
      );
    },
    onFilesAcquired: async (files, sourcePaths) => {
      if (!pin) throw new Error('Missing pinned revision in test setup');
      await persistScanInputs(
        db,
        queued.id,
        registered.id,
        generation,
        attempt,
        pin,
        files,
        new Set(sourcePaths),
      );
    },
  });
  expect(acquired.commitId).toBe(fixture.commit);
  return {
    registered,
    queued,
    generation,
    attempt,
    request,
    acquired,
    pin: pin!,
  };
}
describe.skipIf(!dbUrl)('PostgreSQL backend integration', () => {
  it('preserves scan idempotency, pinned source, publication and authenticated API', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'ct-backend-'));
    const folder = join(parent, 'repo');
    await mkdir(folder);
    const source =
      'export function getValue() { return 1; }\nexport function consumer() { return getValue(); }\nexport function caf\u00e9() { return 3; }\n';
    await writeFile(join(folder, 'index.ts'), source);
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', folder, ...args], {
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
      });
    git('init', '-q');
    git(
      '-c',
      'user.name=CodeThread Test',
      '-c',
      'user.email=test@example.invalid',
      'add',
      'index.ts',
    );
    git(
      '-c',
      'user.name=CodeThread Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'Pinned semantic source',
    );
    const commit = git('rev-parse', 'HEAD').trim();
    const db = connect(dbUrl!);
    let service: ScanService | undefined;
    let server: ReturnType<typeof makeApi> | undefined;
    let viewers: PersistentViewerManager | undefined;
    try {
      await applyMigrations(db);
      await applyMigrations(db);
      await db.unsafe(
        await readFile(new URL('../db/roles.sql', import.meta.url), 'utf8'),
      );
      await assertMigrations(db);
      const grants = await db`SELECT
        has_table_privilege('codethread_runtime','codethread.scan_job','SELECT') AS can_read,
        has_table_privilege('codethread_runtime','codethread.scan_job','INSERT') AS can_insert,
        has_table_privilege('codethread_runtime','codethread.scan_job','DELETE') AS can_delete,
        has_schema_privilege('codethread_runtime','codethread','CREATE') AS can_ddl,
        has_function_privilege('codethread_runtime',
          'codethread.prune_inactive_data(timestamp with time zone,integer,integer,integer)',
          'EXECUTE') AS can_prune,
        has_function_privilege('codethread_retention',
          'codethread.prune_inactive_data(timestamp with time zone,integer,integer,integer)',
          'EXECUTE') AS retention_can_prune`;
      expect(grants[0]).toMatchObject({
        can_read: true,
        can_insert: true,
        can_delete: false,
        can_ddl: false,
        can_prune: false,
        retention_can_prune: true,
      });
      service = new ScanService(db, {
        root: parent,
        analyzerBuildHash: digest('integration-build'),
      });
      const repo = await service.register(folder);
      await db`UPDATE codethread.repository
        SET desired_generation='9007199254740991' WHERE id=${repo.id}`;
      const sameRequests = await Promise.all([
        service.accept(repo.id, commit, 'same-request'),
        service.accept(repo.id, commit, 'same-request'),
      ]);
      const [first, again] = sameRequests;
      expect(again.id).toBe(first.id);
      expect(sameRequests.filter((item) => item.reused)).toHaveLength(1);
      await expect(
        service.accept(repo.id, 'HEAD', 'same-request'),
      ).rejects.toMatchObject({
        code: 'IDEMPOTENCY_CONFLICT',
        status: 409,
      });
      // A newer accepted generation must win activation even when older work completes.
      const second = await service.accept(repo.id, commit, 'new-generation');
      expect(second.id).not.toBe(first.id);
      const generations = await db`SELECT generation::text AS value
        FROM codethread.scan_job WHERE id IN (${first.id},${second.id})
        ORDER BY generation`;
      expect(generations.map((row) => row.value)).toEqual([
        '9007199254740992',
        '9007199254740993',
      ]);
      const running = service.run();
      const deadline = Date.now() + 90_000;
      let last: Awaited<ReturnType<ScanService['job']>> | undefined;
      while (Date.now() < deadline) {
        last = await service.job(second.id);
        if (['succeeded', 'failed', 'cancelled'].includes(last.state)) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(last?.state).toBe('succeeded');
      const older = await service.job(first.id);
      expect(older.state).toBe('succeeded');
      expect(older.activation_result).toBe('stale');
      expect(last?.activation_result).toBe('activated');
      expect(last?.git_commit_oid).toBe(commit);
      const active = await service.repository(repo.id);
      expect(active.active_job_id).toBe(second.id);
      const projects = await service.projects(second.id);
      const usable = projects.find((p) => p.status === 'ready');
      expect(usable).toBeDefined();
      const snapshot = await loadSnapshot(db, usable!.snapshot_id as string);
      expect(snapshot.facts.files.some((f) => f.path === 'index.ts')).toBe(
        true,
      );
      expect(snapshot.facts.symbols.some((s) => s.name === 'getValue')).toBe(
        true,
      );
      const stored =
        await db`SELECT count(*)::integer AS n FROM codethread.source_object
        WHERE sha256=${digest(source)}`;
      expect(stored[0]?.n).toBe(1);
      await expect(db`UPDATE codethread.repository_snapshot SET coverage='complete'
        WHERE id=${snapshot.facts.snapshotId}`).rejects.toThrow();
      await expect(db`INSERT INTO codethread.code_relation
        (snapshot_id,id,canonical_key,source_symbol_id,target_symbol_id,kind,resolution,site_evidence_id)
        VALUES(${snapshot.facts.snapshotId},${randomUUID()},'invalid',
          ${randomUUID()},NULL,'calls','exact',${randomUUID()})`).rejects.toThrow();
      const stagingId = randomUUID();
      await db`INSERT INTO codethread.repository_snapshot
        (id,repository_id,source_fingerprint,analyzer_version,analyzer_build_hash,
         configuration_hash,coverage,facts_json)
        VALUES(${stagingId},${repo.id},${digest('staging-source')},'test',
          ${digest('staging-build')},${digest('staging-config')},'complete',
          ${db.json({ snapshotId: stagingId })}::jsonb)`;
      const capability = (
        await db`SELECT capability_key FROM codethread.snapshot_capability
        WHERE snapshot_id=${snapshot.facts.snapshotId} LIMIT 1`
      )[0];
      expect(capability).toBeDefined();
      await expect(db`UPDATE codethread.snapshot_capability
        SET snapshot_id=${stagingId}
        WHERE snapshot_id=${snapshot.facts.snapshotId}
          AND capability_key=${capability!.capability_key}`).rejects.toThrow();
      const [firstBytes, secondBytes] = [
          Buffer.from('export const first = 1;\n'),
          Buffer.from('export const second = 2;\n'),
        ],
        firstHash = digest(firstBytes),
        secondHash = digest(secondBytes),
        firstFileId = randomUUID(),
        secondFileId = randomUUID(),
        evidenceId = randomUUID();
      await storeSourceObjects(db, [
        { sha256: firstHash, bytes: firstBytes },
        { sha256: secondHash, bytes: secondBytes },
      ]);
      await db`INSERT INTO codethread.snapshot_file
        (snapshot_id,id,path,content_hash,byte_length)
        VALUES(${stagingId},${firstFileId},'one.ts',${firstHash},${firstBytes.length}),
          (${stagingId},${secondFileId},'two.ts',${secondHash},${secondBytes.length})`;
      await db`INSERT INTO codethread.source_evidence
        (snapshot_id,id,file_id,content_hash,start_utf16,end_utf16,range_json,
         kind,extractor_name,extractor_version)
        VALUES(${stagingId},${evidenceId},${firstFileId},${firstHash},0,1,
          ${db.json({ start: { offset: 0 }, end: { offset: 1 } })},
          'declaration','test','1')`;
      const wrongSymbolId = randomUUID();
      await expect(db`INSERT INTO codethread.code_symbol
        (snapshot_id,id,file_id,canonical_key,name,kind,declaration_evidence_id,symbol_json)
        VALUES(${stagingId},${wrongSymbolId},${secondFileId},'wrong-owner',
          'second','function',${evidenceId},
          ${db.json({ snapshotId: stagingId, id: wrongSymbolId })}::jsonb)`).rejects.toThrow();
      const oldSnapshotId = randomUUID();
      await db`INSERT INTO codethread.repository_snapshot
        (id,repository_id,source_fingerprint,analyzer_version,analyzer_build_hash,
         configuration_hash,coverage,facts_json,created_at)
        VALUES(${oldSnapshotId},${repo.id},${digest('retention-source')},'test',
          ${digest('retention-build')},${digest('retention-config')},'complete',
          ${db.json({ snapshotId: oldSnapshotId })}::jsonb,
          now()-interval '60 days')`;
      await db`INSERT INTO codethread.snapshot_capability
        (snapshot_id,capability_key,coverage)
        VALUES(${oldSnapshotId},'calls','complete')`;
      await db`UPDATE codethread.repository_snapshot SET state='published',
        published_at=now() WHERE id=${oldSnapshotId}`;
      const activeSnapshotId = String(
        (
          await db`SELECT snapshot_id FROM codethread.scan_project
          WHERE scan_job_id=${second.id} AND status='ready' LIMIT 1`
        )[0]?.snapshot_id,
      );
      const oldTimestamp = (
        await db`SELECT created_at FROM codethread.repository_snapshot
        WHERE id=${activeSnapshotId}`
      )[0]!.created_at;
      await db.unsafe(`ALTER TABLE codethread.repository_snapshot
        DISABLE TRIGGER immutable_snapshot`);
      try {
        await db`UPDATE codethread.repository_snapshot
          SET created_at=now()-interval '60 days' WHERE id=${activeSnapshotId}`;
        const retained = await db.begin(async (transaction) => {
          const reader = transaction as unknown as typeof db;
          await reader`SELECT pg_advisory_xact_lock_shared(
            1919606126,hashtext(${oldSnapshotId}::text))`;
          return db`SELECT * FROM codethread.prune_inactive_data(
            now()-interval '1 day',0,10,10)`;
        });
        expect(Number(retained[0]?.deleted_snapshots)).toBe(0);
        expect(
          Number(
            (
              await db`SELECT count(*)::integer AS total
          FROM codethread.repository_snapshot WHERE id=${oldSnapshotId}`
            )[0]?.total,
          ),
        ).toBe(1);
        const pruned = await db`SELECT * FROM codethread.prune_inactive_data(
          now()-interval '1 day',0,10,10)`;
        expect(Number(pruned[0]?.deleted_snapshots)).toBe(1);
        expect(
          Number(
            (
              await db`SELECT count(*)::integer AS total
              FROM codethread.repository_snapshot WHERE id=${activeSnapshotId}`
            )[0]?.total,
          ),
        ).toBe(1);
        await expect(
          db`SELECT * FROM codethread.prune_inactive_data(
            now()+interval '1 minute',0,10,10)`,
        ).rejects.toThrow(/invalid retention cutoff/);
      } finally {
        await db`UPDATE codethread.repository_snapshot
          SET created_at=${oldTimestamp} WHERE id=${activeSnapshotId}`;
        await db.unsafe(`ALTER TABLE codethread.repository_snapshot
          ENABLE TRIGGER immutable_snapshot`);
      }
      service.stop();
      await running;
      const token = 'a'.repeat(48),
        port = 8765;
      viewers = new PersistentViewerManager(db);
      server = makeApi(db, service, token, port, viewers);
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(port, '127.0.0.1', resolve);
      });
      const base = 'http://127.0.0.1:' + port + '/v1/scans/' + second.id;
      const unauthorized = await fetch(base);
      expect(unauthorized.status).toBe(401);
      const headers = { authorization: 'Bearer ' + token };
      const job = await fetch(base, { headers });
      expect(job.status).toBe(200);
      const payload = await job.json();
      expect(payload.git_commit_oid).toBe(commit);
      const inventory = await fetch(base + '/files', { headers });
      expect(inventory.status).toBe(200);
      expect((await inventory.json()).total).toBe(1);
      const symbols = await fetch(
        base + '/projects/' + usable!.project_id + '/symbols?query=getValue',
        { headers },
      );
      expect(symbols.status).toBe(200);
      expect((await symbols.json()).items.length).toBeGreaterThan(0);
      const unicodeSymbols = await fetch(
        base + '/projects/' + usable!.project_id + '/symbols?query=CAF%C3%89',
        { headers: { authorization: 'Bearer ' + token } },
      );
      expect(unicodeSymbols.status).toBe(200);
      expect(
        (await unicodeSymbols.json()).items.map(
          (item: { name: string }) => item.name,
        ),
      ).toEqual(['café']);
      const blockedOrigin = await fetch(base, {
        headers: { ...headers, origin: 'https://external.invalid' },
      });
      expect(blockedOrigin.status).toBe(403);

      const viewerResponse = await fetch(
        'http://127.0.0.1:' + port + '/v1/scans/' + second.id + '/viewer',
        { method: 'POST', headers },
      );
      expect(viewerResponse.status).toBe(200);
      const viewerLink = await viewerResponse.json(),
        viewerUrl = new URL(viewerLink.url),
        viewerToken = viewerUrl.hash.slice(1);
      expect(viewerToken).toMatch(/^[a-f0-9]{64}$/);
      expect(viewerLink.url).not.toContain(token);
      const viewerOrigin = viewerUrl.origin;
      viewerUrl.hash = '';
      const viewerPage = await fetch(viewerUrl);
      expect(viewerPage.status).toBe(200);
      expect(await viewerPage.text()).toContain('CodeThread investigation');
      const viewerProjects = await fetch(new URL('/api/projects', viewerUrl), {
        method: 'POST',
        headers: {
          'X-CodeThread-Token': viewerToken,
          'Content-Type': 'application/json',
          origin: viewerOrigin,
        },
        body: '{}',
      });
      expect(viewerProjects.status).toBe(200);
      const viewerCatalog = await viewerProjects.json();
      expect(viewerCatalog.commitId).toBe(commit);
      expect(
        viewerCatalog.items.some(
          (item: { id: string; snapshotId: string | null }) =>
            item.id === usable!.project_id &&
            item.snapshotId === usable!.snapshot_id,
        ),
      ).toBe(true);

      const storedSource = (
        await db`SELECT bytes FROM codethread.source_object
        WHERE sha256=${snapshot.facts.files[0]!.contentHash}`
      )[0];
      expect(storedSource).toBeDefined();
      await db.unsafe(`ALTER TABLE codethread.source_object
        DISABLE TRIGGER immutable_source_object`);
      try {
        await db`UPDATE codethread.source_object SET bytes=${Buffer.from('corrupt')},
          byte_length=7 WHERE sha256=${snapshot.facts.files[0]!.contentHash}`;
        await expect(
          loadSnapshot(db, snapshot.facts.snapshotId),
        ).rejects.toThrow(/integrity mismatch/);
        await db`UPDATE codethread.source_object SET bytes=${storedSource!.bytes},
          byte_length=${Buffer.from(storedSource!.bytes as Uint8Array).byteLength}
          WHERE sha256=${snapshot.facts.files[0]!.contentHash}`;
      } finally {
        await db.unsafe(`ALTER TABLE codethread.source_object
          ENABLE TRIGGER immutable_source_object`);
      }

      const symbol = snapshot.facts.symbols[0]!;
      await db.unsafe(
        `ALTER TABLE codethread.code_symbol DISABLE TRIGGER immutable_symbol`,
      );
      try {
        await db`UPDATE codethread.code_symbol SET name='tampered'
          WHERE snapshot_id=${snapshot.facts.snapshotId} AND id=${symbol.id}`;
        await expect(
          loadSnapshot(db, snapshot.facts.snapshotId),
        ).rejects.toThrow(/Stored snapshot symbols differ/);
        await db`UPDATE codethread.code_symbol SET name=${symbol.name}
          WHERE snapshot_id=${snapshot.facts.snapshotId} AND id=${symbol.id}`;
      } finally {
        await db.unsafe(`ALTER TABLE codethread.code_symbol
          ENABLE TRIGGER immutable_symbol`);
      }
    } finally {
      service?.stop();
      if (server)
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      await viewers?.closeAll();
      await db.end({ timeout: 5 });
      await rm(parent, { recursive: true, force: true });
    }
  }, 120_000);

  it('recovers a pinned scan from its original commit after HEAD moves', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'ct-backend-recovery-')),
      fixture = await createGitFixture(
        parent,
        'export function readPinned() { return "before"; }\n',
      ),
      db = connect(dbUrl!);
    const firstWorker = new ScanService(db, {
      root: parent,
      analyzerBuildHash: digest('recovery-build'),
    });
    let restartedWorker: ScanService | undefined,
      running: Promise<void> | undefined;
    try {
      await applyMigrations(db);
      const setup = await prepareClaimedScan(db, firstWorker, fixture);
      const pinnedCommit = setup.acquired.commitId;
      await writeFile(
        join(fixture.folder, 'index.ts'),
        'export function readPinned() { return "after"; }\n',
      );
      fixture.git('add', 'index.ts');
      fixture.git(
        '-c',
        'user.name=CodeThread Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-qm',
        'Move HEAD after durable pin',
      );
      expect(fixture.git('rev-parse', 'HEAD').trim()).not.toBe(pinnedCommit);

      await firstWorker.recover();
      restartedWorker = new ScanService(db, {
        root: parent,
        analyzerBuildHash: digest('recovery-build'),
      });
      running = restartedWorker.run();
      const recovered = await waitForTerminalJob(
        restartedWorker,
        setup.queued.id,
      );
      expect(recovered.state).toBe('succeeded');
      expect(recovered.git_commit_oid).toBe(pinnedCommit);
      expect(recovered.git_tree_oid).toBe(setup.acquired.rootTreeId);
      const projects = await restartedWorker.projects(setup.queued.id),
        project = projects.find((item) => item.status === 'ready');
      expect(project?.snapshot_id).toBeTruthy();
      const snapshot = await loadSnapshot(db, project!.snapshot_id as string),
        source = snapshot.source.readFile(snapshot.facts.files[0]!.id);
      expect(source).not.toBeNull();
      expect(new TextDecoder().decode(source!)).toContain('"before"');
      expect(new TextDecoder().decode(source!)).not.toContain('"after"');
      const inputs =
        await db`SELECT content_hash FROM codethread.scan_input_file
        WHERE scan_job_id=${setup.queued.id} AND path='index.ts'`;
      expect(inputs[0]?.content_hash).toBe(
        digest('export function readPinned() { return "before"; }\n'),
      );
    } finally {
      firstWorker.stop();
      restartedWorker?.stop();
      await running;
      await db.end({ timeout: 5 });
      await rm(parent, { recursive: true, force: true });
    }
  }, 60_000);

  it('rolls back every staged row when publication fails late', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'ct-backend-rollback-')),
      fixture = await createGitFixture(
        parent,
        'export function version() { return 1; }\n',
      ),
      db = connect(dbUrl!),
      service = new ScanService(db, {
        root: parent,
        analyzerBuildHash: digest('rollback-build'),
      });
    let running: Promise<void> | undefined;
    try {
      await applyMigrations(db);
      const registered = await service.register(fixture.folder),
        first = await service.accept(registered.id, fixture.commit, 'active');
      running = service.run();
      expect((await waitForTerminalJob(service, first.id)).state).toBe(
        'succeeded',
      );
      service.stop();
      await running;
      running = undefined;

      await writeFile(
        join(fixture.folder, 'index.ts'),
        'export function version() { return 2; }\n',
      );
      fixture.git('add', 'index.ts');
      fixture.git(
        '-c',
        'user.name=CodeThread Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-qm',
        'Changed source for rollback',
      );
      fixture.commit = fixture.git('rev-parse', 'HEAD').trim();
      const failedService = new ScanService(db, {
          root: parent,
          analyzerBuildHash: digest('rollback-build'),
        }),
        setup = await prepareClaimedScan(
          db,
          failedService,
          fixture,
          registered.id,
        ),
        session = await analyzeGitRepository(
          { ...setup.request, revision: setup.acquired.commitId },
          setup.acquired,
        );
      await db.unsafe(`CREATE FUNCTION codethread.test_fail_publication()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'injected publication failure' USING ERRCODE='23514';
        END $$`);
      await db.unsafe(`CREATE TRIGGER test_fail_publication
        BEFORE UPDATE OF state ON codethread.repository_snapshot
        FOR EACH ROW WHEN (NEW.state='published')
        EXECUTE FUNCTION codethread.test_fail_publication()`);
      try {
        await expect(
          persistScan(
            db,
            setup.queued.id,
            registered.id,
            setup.acquired,
            session,
            setup.generation,
            setup.attempt,
          ),
        ).rejects.toThrow(/injected publication failure/);
      } finally {
        await db.unsafe(`DROP TRIGGER IF EXISTS test_fail_publication
          ON codethread.repository_snapshot`);
        await db.unsafe(
          `DROP FUNCTION IF EXISTS codethread.test_fail_publication()`,
        );
      }
      expect(
        (await failedService.repository(registered.id)).active_job_id,
      ).toBe(first.id);
      const projectRows = await db`SELECT count(*)::integer AS total
          FROM codethread.scan_project WHERE scan_job_id=${setup.queued.id}`;
      expect(projectRows[0]?.total).toBe(0);
      const newSnapshotId = session.projects.find((item) => item.snapshot)
        ?.snapshot?.facts.snapshotId;
      expect(newSnapshotId).toBeTruthy();
      const snapshotRows = await db`SELECT count(*)::integer AS total
        FROM codethread.repository_snapshot WHERE id=${newSnapshotId!}`;
      expect(snapshotRows[0]?.total).toBe(0);
      expect(await failedService.cancel(setup.queued.id)).toMatchObject({
        state: 'cancelled',
      });
      failedService.stop();
    } finally {
      service.stop();
      await running;
      await db.end({ timeout: 5 });
      await rm(parent, { recursive: true, force: true });
    }
  }, 60_000);

  it('rejects stale attempts and cancellation before publication', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'ct-backend-fence-')),
      fixture = await createGitFixture(
        parent,
        'export function fenced() { return true; }\n',
      ),
      db = connect(dbUrl!),
      service = new ScanService(db, {
        root: parent,
        analyzerBuildHash: digest('fence-build'),
      });
    try {
      await applyMigrations(db);
      const setup = await prepareClaimedScan(db, service, fixture),
        session = await analyzeGitRepository(
          { ...setup.request, revision: setup.acquired.commitId },
          setup.acquired,
        );
      await service.recover();
      const newAttempt = await db`UPDATE codethread.scan_job
        SET state='running',attempt=attempt+1
        WHERE id=${setup.queued.id} AND state='queued' RETURNING attempt`;
      expect(Number(newAttempt[0]?.attempt)).toBe(2);
      await expect(
        persistScan(
          db,
          setup.queued.id,
          setup.registered.id,
          setup.acquired,
          session,
          setup.generation,
          setup.attempt,
        ),
      ).rejects.toThrow(/Stale or cancelled scan/);
      expect(await service.cancel(setup.queued.id)).toMatchObject({
        state: 'cancelled',
      });
      await expect(
        persistScan(
          db,
          setup.queued.id,
          setup.registered.id,
          setup.acquired,
          session,
          setup.generation,
          Number(newAttempt[0]?.attempt),
        ),
      ).rejects.toThrow(/Stale or cancelled scan/);
      const snapshots = await db`SELECT count(*)::integer AS total
        FROM codethread.scan_project WHERE scan_job_id=${setup.queued.id}`;
      expect(snapshots[0]?.total).toBe(0);
    } finally {
      service.stop();
      await db.end({ timeout: 5 });
      await rm(parent, { recursive: true, force: true });
    }
  }, 60_000);

  it('linearizes a cancellation racing with a publication transaction', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'ct-backend-cancel-race-')),
      fixture = await createGitFixture(
        parent,
        'export function race() { return "publish"; }\n',
      ),
      db = connect(dbUrl!),
      observer = connect(dbUrl!),
      service = new ScanService(db, {
        root: parent,
        analyzerBuildHash: digest('cancel-race-build'),
      });
    let publishing: Promise<void> | undefined;
    try {
      await applyMigrations(db);
      const setup = await prepareClaimedScan(db, service, fixture),
        session = await analyzeGitRepository(
          { ...setup.request, revision: setup.acquired.commitId },
          setup.acquired,
        );
      await db.unsafe(`CREATE FUNCTION codethread.test_pause_publication()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.state='published' THEN PERFORM pg_sleep(0.75); END IF;
          RETURN NEW;
        END $$`);
      await db.unsafe(`CREATE TRIGGER test_pause_publication
        BEFORE UPDATE OF state ON codethread.repository_snapshot
        FOR EACH ROW WHEN (NEW.state='published')
        EXECUTE FUNCTION codethread.test_pause_publication()`);
      publishing = persistScan(
        db,
        setup.queued.id,
        setup.registered.id,
        setup.acquired,
        session,
        setup.generation,
        setup.attempt,
      );
      const deadline = Date.now() + 10_000;
      let inPublication = false;
      while (Date.now() < deadline) {
        const rows = await observer`SELECT count(*)::integer AS total
          FROM pg_stat_activity WHERE application_name='codethread-backend'
            AND wait_event='PgSleep'`;
        if (Number(rows[0]?.total) > 0) {
          inPublication = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(inPublication).toBe(true);
      await expect(service.cancel(setup.queued.id)).rejects.toMatchObject({
        code: 'NOT_CANCELLABLE',
        status: 409,
      });
      await publishing;
      expect((await service.job(setup.queued.id)).state).toBe('succeeded');
      expect(
        (await service.repository(setup.registered.id)).active_job_id,
      ).toBe(setup.queued.id);
    } finally {
      await publishing?.catch(() => {});
      await db`DROP TRIGGER IF EXISTS test_pause_publication
        ON codethread.repository_snapshot`;
      await db`DROP FUNCTION IF EXISTS codethread.test_pause_publication()`;
      service.stop();
      await observer.end({ timeout: 5 });
      await db.end({ timeout: 5 });
      await rm(parent, { recursive: true, force: true });
    }
  }, 60_000);

  it('adopts and upgrades the prior candidate schema without losing job data', async () => {
    const admin = connect(dbUrl!),
      databaseName = 'ct_upgrade_' + randomUUID().replaceAll('-', ''),
      target = new URL(dbUrl!);
    target.pathname = '/' + databaseName;
    let legacy: ReturnType<typeof connect> | undefined;
    try {
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
      legacy = connect(target.toString());
      const initialSchema = await readFile(
        new URL('../db/migrations/001_core.sql', import.meta.url),
        'utf8',
      );
      await legacy.unsafe(initialSchema);
      const repositoryId = randomUUID(),
        jobId = randomUUID();
      await legacy`INSERT INTO codethread.repository(id,local_locator)
        VALUES(${repositoryId},'legacy-fixture')`;
      await legacy`INSERT INTO codethread.scan_job
        (id,repository_id,generation,idempotency_key,request_hash,revision_selector,
         configuration_hash,analyzer_version,analyzer_build_hash,state)
        VALUES(${jobId},${repositoryId},1,'legacy-request',${digest('legacy-request')},
          'HEAD',${digest('legacy-config')},'legacy-analyzer',
          ${digest('legacy-build')},'queued')`;

      expect(await applyMigrations(legacy)).toEqual([1, 2, 3, 4, 5]);
      await assertMigrations(legacy);
      const retained = await legacy`SELECT id,state FROM codethread.scan_job
        WHERE id=${jobId}`;
      expect(retained).toHaveLength(1);
      expect(retained[0]).toMatchObject({ id: jobId, state: 'queued' });
    } finally {
      await legacy?.end({ timeout: 5 });
      await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await admin.end({ timeout: 5 });
    }
  }, 30_000);
});
