import { spawn, type ChildProcess } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as codeModel from '@codethread/code-model';
import * as symbolIndexer from '@codethread/symbol-indexer';
import { AnalysisError } from '@codethread/symbol-indexer';
import { describe, expect, it, vi } from 'vitest';
import { connect } from '../scripts/backend/database.ts';
import { makeApi } from '../scripts/backend/http.ts';
import { applyMigrations } from '../scripts/backend/migrations.ts';
import { ScanService } from '../scripts/backend/service.ts';
import { loadRepositorySession } from '../scripts/backend/session-persistence.ts';
import { acquireWorkerLease } from '../scripts/backend/worker-lease.ts';
import { createGitRepository } from './helpers/git-fixture.ts';

const databaseUrl = process.env.CODETHREAD_TEST_DATABASE_URL;
const buildHash = 'e'.repeat(64),
  token = 'partial-session-test-token-000000';

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

function exited(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error('Backend did not exit'));
    }, 12_000);
    function onExit() {
      clearTimeout(timer);
      resolve();
    }
    child.once('exit', onExit);
  });
}

async function readInvestigation(
  port: number,
  jobId: string,
  projectId: string,
  snapshotId: string,
) {
  const base = `http://127.0.0.1:${port}/v1/scans/${jobId}/projects/${projectId}`;
  async function request<T>(path: string, body?: object): Promise<T> {
    const response = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok)
      throw new Error(
        `Partial-session HTTP request returned ${response.status}`,
      );
    return (await response.json()) as T;
  }
  const symbols = await request<{
      items: { id: string; name: string; declarationEvidenceId: string }[];
    }>('/symbols'),
    entry = symbols.items.find((symbol) => symbol.name === 'entry'),
    target = symbols.items.find((symbol) => symbol.name === 'target');
  if (!entry || !target) throw new Error('Expected pinned symbols are missing');
  return {
    symbols,
    neighbors: await request('/neighbors', {
      snapshotId,
      symbolId: entry.id,
      direction: 'outgoing',
      depth: 1,
      nodeLimit: 20,
    }),
    evidence: await request('/evidence', {
      snapshotId,
      evidenceIds: [target.declarationEvidenceId],
    }),
  };
}

describe.skipIf(!databaseUrl)('persistent partial repository sessions', () => {
  for (const failure of ['deadline', 'resource'] as const) {
    it(`preserves ${failure} coverage, graph and evidence after backend restart`, async () => {
      const directories: string[] = [];
      const fixture = await createGitRepository(
        [
          { path: 'package.json', source: '{"workspaces":["packages/*"]}' },
          {
            path: 'tsconfig.json',
            source:
              '{"files":[],"references":[{"path":"packages/a-fast"},{"path":"packages/b-fail"},{"path":"packages/c-later"}]}',
          },
          ...['a-fast', 'b-fail', 'c-later'].flatMap((name) => [
            {
              path: `packages/${name}/package.json`,
              source: JSON.stringify({ name: `@fixture/${name}` }),
            },
            {
              path: `packages/${name}/tsconfig.json`,
              source:
                '{"compilerOptions":{"types":[],"target":"ES2023"},"files":["index.ts"]}',
            },
            {
              path: `packages/${name}/index.ts`,
              source:
                name === 'a-fast'
                  ? 'export function target(){return 1} export class Box { ping(){return 2} } export function entry(box:Box){const method=box.ping; return target()+missing()+box.ping()}'
                  : `export function ${name.replace('-', '')}(){return 1}`,
            },
          ]),
        ],
        directories,
      );
      const db = connect(databaseUrl!),
        lease = await acquireWorkerLease(databaseUrl!),
        service = new ScanService(
          db,
          { root: tmpdir(), analyzerBuildHash: buildHash },
          lease,
        ),
        port = await reservePort();
      let worker: Promise<void> | undefined,
        server: ReturnType<typeof makeApi> | undefined,
        child: ChildProcess | undefined;
      try {
        await applyMigrations(db);
        const originalLimits = codeModel.analysisResourceLimits,
          originalAnalyze = symbolIndexer.analyzeProject;
        if (failure === 'deadline')
          vi.spyOn(codeModel, 'analysisResourceLimits').mockImplementation(
            (profile = 'selected') =>
              profile === 'repository'
                ? { ...originalLimits(profile), maxDeadlineMs: 8000 }
                : originalLimits(profile),
          );
        const injected = vi.fn();
        vi.spyOn(symbolIndexer, 'analyzeProject').mockImplementation(
          async (input) => {
            if (input.configPath !== 'packages/b-fail/tsconfig.json')
              return originalAnalyze(input);
            injected();
            if (failure === 'resource')
              throw new AnalysisError(
                'RESOURCE_LIMIT',
                'Injected project resource limit',
              );
            return new Promise<never>((_resolve, reject) => {
              const onAbort = () =>
                reject(
                  new AnalysisError(
                    'ANALYSIS_TIMEOUT',
                    'Repository deadline elapsed',
                  ),
                );
              if (input.signal?.aborted) onAbort();
              else
                input.signal?.addEventListener('abort', onAbort, {
                  once: true,
                });
            });
          },
        );
        await service.recover();
        worker = service.run();
        const registered = await service.register(fixture.directory),
          accepted = await service.accept(
            registered.id,
            fixture.revision,
            `partial-${failure}`,
          );
        const deadline = Date.now() + 45_000;
        let job = await service.job(accepted.id);
        while (
          !['succeeded', 'failed', 'cancelled'].includes(job.state) &&
          Date.now() < deadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          job = await service.job(accepted.id);
        }
        expect(job).toMatchObject({
          state: 'succeeded',
          git_commit_oid: fixture.revision,
        });
        expect(injected).toHaveBeenCalledOnce();
        const session = await loadRepositorySession(db, accepted.id),
          good = session.projects.find(
            (project) =>
              project.project.configPath === 'packages/a-fast/tsconfig.json',
          ),
          failed = session.projects.find(
            (project) =>
              project.project.configPath === 'packages/b-fail/tsconfig.json',
          ),
          later = session.projects.find(
            (project) =>
              project.project.configPath === 'packages/c-later/tsconfig.json',
          );
        expect(session).toMatchObject({
          commitId: fixture.revision,
          sourceCoverageComplete: false,
          contextComplete: false,
          analysisComplete: false,
        });
        expect(session.inventory.sourceFiles).toBe(3);
        expect(good?.status).toBe('ready');
        expect(good?.snapshot?.facts.counts.exact).toBeGreaterThan(0);
        expect(good?.snapshot?.facts.counts.unresolved).toBeGreaterThan(0);
        expect(good?.snapshot?.facts.counts.unsupported).toBeGreaterThan(0);
        expect(failed).toMatchObject({
          status: failure === 'deadline' ? 'not_analyzed' : 'failed',
          error: {
            code:
              failure === 'deadline' ? 'ANALYSIS_TIMEOUT' : 'RESOURCE_LIMIT',
          },
        });
        expect(later?.status).toBe(
          failure === 'deadline' ? 'not_analyzed' : 'ready',
        );
        expect(
          session.files.find(
            (file) => file.path === 'packages/b-fail/index.ts',
          ),
        ).toMatchObject({
          status: 'not_analyzed',
          analysisReason: expect.stringContaining(
            failure === 'deadline' ? 'ANALYSIS_TIMEOUT' : 'RESOURCE_LIMIT',
          ),
        });
        const snapshotId = good?.snapshot?.facts.snapshotId;
        if (!good || !snapshotId)
          throw new Error('Completed context is missing');
        server = makeApi(db, service, token, port);
        await new Promise<void>((resolve) =>
          server!.listen(port, '127.0.0.1', resolve),
        );
        const before = await readInvestigation(
          port,
          accepted.id,
          good.project.id,
          snapshotId,
        );
        expect(before.evidence).toMatchObject({
          items: [
            {
              status: 'available',
              filePath: 'packages/a-fast/index.ts',
              text: expect.stringContaining('function target'),
            },
          ],
        });
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = undefined;
        service.stop();
        await worker;
        worker = undefined;
        await lease.close();
        vi.restoreAllMocks();
        const workerPath = fileURLToPath(
          new URL('./backend-http-process.ts', import.meta.url),
        );
        child = spawn(process.execPath, [workerPath], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            CODETHREAD_DATABASE_URL: databaseUrl!,
            CODETHREAD_ALLOWED_REPO_ROOT: tmpdir(),
            CODETHREAD_ANALYZER_BUILD_HASH: buildHash,
            CODETHREAD_API_TOKEN: token,
            CODETHREAD_TEST_API_PORT: String(port),
          },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        await ready(child);
        expect(
          await readInvestigation(
            port,
            accepted.id,
            good.project.id,
            snapshotId,
          ),
        ).toEqual(before);
        expect(
          (await loadRepositorySession(db, accepted.id)).projects.find(
            (project) => project.project.id === failed?.project.id,
          ),
        ).toMatchObject({ status: failed?.status, error: failed?.error });
      } finally {
        vi.restoreAllMocks();
        if (server) {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server!.close(() => resolve()));
        }
        service.stop();
        await worker?.catch(() => {});
        await lease.close();
        if (child && child.exitCode === null && child.signalCode === null) {
          if (child.connected) child.send('stop');
          try {
            await exited(child);
          } catch {
            child.kill();
            await exited(child);
          }
        }
        await db.end({ timeout: 5 });
        for (const directory of directories)
          await rm(directory, { recursive: true, force: true });
      }
    }, 120_000);
  }
});
