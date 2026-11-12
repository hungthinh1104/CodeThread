import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { connect, assertMigrations } from '../scripts/backend/database.ts';
import { ScanService } from '../scripts/backend/service.ts';
import { loadSnapshot } from '../scripts/backend/persistence.ts';
import { makeApi } from '../scripts/backend/http.ts';

const dbUrl = process.env.CODETHREAD_TEST_DATABASE_URL;
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
describe.skipIf(!dbUrl)('PostgreSQL backend integration', () => {
  it('preserves scan idempotency, pinned source, publication and authenticated API', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'ct-backend-'));
    const folder = join(parent, 'repo');
    await mkdir(folder);
    const source =
      'export function getValue() { return 1; }\nexport function consumer() { return getValue(); }\n';
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
    try {
      await assertMigrations(db);
      service = new ScanService(db, {
        root: parent,
        analyzerBuildHash: digest('integration-build'),
      });
      const repo = await service.register(folder);
      const first = await service.accept(repo.id, commit, 'same-request');
      const again = await service.accept(repo.id, commit, 'same-request');
      expect(again.id).toBe(first.id);
      expect(again.reused).toBe(true);
      await expect(
        service.accept(repo.id, 'HEAD', 'same-request'),
      ).rejects.toMatchObject({
        code: 'IDEMPOTENCY_CONFLICT',
        status: 409,
      });
      // A newer accepted generation must win activation even when older work completes.
      const second = await service.accept(repo.id, commit, 'new-generation');
      expect(second.id).not.toBe(first.id);
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
      expect(last.activation_result).toBe('activated');
      expect(last.git_commit_oid).toBe(commit);
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
      service.stop();
      await running;
      const token = 'a'.repeat(48),
        port = 8765;
      server = makeApi(db, service, token, port);
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
      const blockedOrigin = await fetch(base, {
        headers: { ...headers, origin: 'https://external.invalid' },
      });
      expect(blockedOrigin.status).toBe(403);
    } finally {
      service?.stop();
      if (server)
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      await db.end({ timeout: 5 });
      await rm(parent, { recursive: true, force: true });
    }
  }, 120_000);
});
