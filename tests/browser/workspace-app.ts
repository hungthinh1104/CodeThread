import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { summarizeCoverage } from '@codethread/code-model';
import {
  findSymbolPathsRequestSchema,
  getSourceEvidenceRequestSchema,
  graphNeighborsRequestSchema,
  listSymbolsRequestSchema,
  parseFindSymbolPathsResult,
  parseGetSourceEvidenceResult,
  parseGraphNeighborsResult,
  parseListSymbolsResult,
  type AiStatusResponse,
  type AiSynthesisResponse,
} from '@codethread/contracts';
import type { AnalysisSnapshot } from '@codethread/symbol-indexer';
import { createInvestigation, TraceError } from '@codethread/trace-engine';
import type { RepositoryInvestigationSession } from '../../scripts/investigation/repository-session.ts';
import {
  createRepositoryViewer,
  type ViewerHandle,
} from '../../scripts/viewer.ts';

const backendToken = 'workspace-browser-backend-token';
const activeScanId = '33333333-3333-4333-8333-333333333333';
const inactiveRepositoryId = '44444444-4444-4444-8444-444444444444';

type Gate = {
  started: Promise<void>;
  release(): void;
  wait(): Promise<void>;
};

function deferred(): Gate {
  let start = () => {},
    release = () => {};
  const started = new Promise<void>((resolveStarted) => {
    start = resolveStarted;
  });
  const pending = new Promise<void>((resolveReleased) => {
    release = resolveReleased;
  });
  return {
    started,
    release,
    async wait() {
      start();
      await pending;
    },
  };
}

async function reservePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port.');
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return address.port;
}

function sendJson(
  response: import('node:http').ServerResponse,
  value: unknown,
  status = 200,
): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function readRequestJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

type StoredRepo = {
  id: string;
  locator: string;
  desired_generation: string;
  active_job_id: string | null;
};

type StoredScan = {
  id: string;
  repository_id: string;
  generation: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  attempt: number;
  revision_selector: string;
  git_commit_oid: string | null;
  git_tree_oid: string | null;
  activation_result: 'activated' | 'stale' | 'not_eligible' | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

function backendServer(
  viewer: ViewerHandle,
  snapshot: AnalysisSnapshot,
  holdScanRead: boolean,
  repositoryId: string,
  options?: {
    aiStatus?: AiStatusResponse;
    onAiSynthesize?: (
      body: unknown,
    ) => Promise<AiSynthesisResponse> | AiSynthesisResponse;
    holdQueuedScans?: boolean;
  },
) {
  const investigation = createInvestigation(snapshot.facts, snapshot.source);
  const gate = deferred();
  let holdQueuedScans = options?.holdQueuedScans ?? false;
  const now = new Date().toISOString();
  const commitId = 'a'.repeat(40);
  const treeId = 'b'.repeat(40);

  const repos = new Map<string, StoredRepo>([
    [
      repositoryId,
      {
        id: repositoryId,
        locator: 'C:/fixtures/codethread-fixture',
        desired_generation: '1',
        active_job_id: activeScanId,
      },
    ],
    [
      inactiveRepositoryId,
      {
        id: inactiveRepositoryId,
        locator: 'C:/fixtures/no-active-scan',
        desired_generation: '0',
        active_job_id: null,
      },
    ],
  ]);

  const scans = new Map<string, StoredScan>([
    [
      activeScanId,
      {
        id: activeScanId,
        repository_id: repositoryId,
        generation: '1',
        state: 'succeeded',
        attempt: 1,
        revision_selector: 'fixture-commit',
        git_commit_oid: commitId,
        git_tree_oid: treeId,
        activation_result: 'activated',
        error_code: null,
        error_message: null,
        created_at: now,
        updated_at: now,
      },
    ],
  ]);

  const server = createServer((request, response) => {
    void (async () => {
      if (request.headers.authorization !== `Bearer ${backendToken}`) {
        sendJson(
          response,
          { error: { code: 'UNAUTHORIZED', message: 'Denied.' } },
          401,
        );
        return;
      }
      const parsedUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      const parts = parsedUrl.pathname.split('/').filter(Boolean);

      if (request.method === 'GET' && parsedUrl.pathname === '/v1/health') {
        sendJson(response, {
          api: 'ready',
          database: 'ready',
          worker: 'ready',
          ready: true,
        });
        return;
      }
      if (
        request.method === 'GET' &&
        parsedUrl.pathname === '/v1/repositories'
      ) {
        sendJson(response, [...repos.values()]);
        return;
      }
      if (
        request.method === 'POST' &&
        parsedUrl.pathname === '/v1/repositories'
      ) {
        const body = (await readRequestJson(request)) as { locator?: string };
        const id = randomUUID();
        const locator = body.locator ?? 'C:/fixtures/registered';
        repos.set(id, {
          id,
          locator,
          desired_generation: '0',
          active_job_id: null,
        });
        sendJson(response, { id, locator });
        return;
      }
      if (
        request.method === 'GET' &&
        parts.length === 3 &&
        parts[0] === 'v1' &&
        parts[1] === 'repositories'
      ) {
        const repo = repos.get(parts[2]!);
        if (!repo) {
          sendJson(
            response,
            { error: { code: 'NOT_FOUND', message: 'Repository not found.' } },
            404,
          );
          return;
        }
        sendJson(response, repo);
        return;
      }
      if (
        request.method === 'POST' &&
        parts.length === 4 &&
        parts[0] === 'v1' &&
        parts[1] === 'repositories' &&
        parts[3] === 'scans'
      ) {
        const repo = repos.get(parts[2]!);
        if (!repo) {
          sendJson(
            response,
            { error: { code: 'NOT_FOUND', message: 'Repository not found.' } },
            404,
          );
          return;
        }
        const body = (await readRequestJson(request)) as {
          revision?: string;
        };
        const nextGen = String(Number(repo.desired_generation) + 1);
        const scanId = randomUUID();
        const ts = new Date().toISOString();
        const queued = holdQueuedScans;
        const created: StoredScan = {
          id: scanId,
          repository_id: repo.id,
          generation: nextGen,
          state: queued ? 'queued' : 'succeeded',
          attempt: queued ? 0 : 1,
          revision_selector: body.revision ?? 'HEAD',
          git_commit_oid: queued ? null : commitId,
          git_tree_oid: queued ? null : treeId,
          activation_result: queued ? null : 'activated',
          error_code: null,
          error_message: null,
          created_at: ts,
          updated_at: ts,
        };
        scans.set(scanId, created);
        repo.desired_generation = nextGen;
        if (!queued) repo.active_job_id = scanId;
        sendJson(response, {
          id: scanId,
          repositoryId: repo.id,
          state: created.state,
          reused: false,
        });
        return;
      }
      if (
        request.method === 'GET' &&
        parts.length === 3 &&
        parts[0] === 'v1' &&
        parts[1] === 'scans'
      ) {
        const targetScan = scans.get(parts[2]!);
        if (!targetScan) {
          sendJson(
            response,
            { error: { code: 'NOT_FOUND', message: 'Scan not found.' } },
            404,
          );
          return;
        }
        if (targetScan.id === activeScanId && holdScanRead) await gate.wait();
        sendJson(response, targetScan);
        return;
      }
      if (
        request.method === 'POST' &&
        parts.length === 4 &&
        parts[0] === 'v1' &&
        parts[1] === 'scans' &&
        parts[3] === 'cancel'
      ) {
        const targetScan = scans.get(parts[2]!);
        if (
          !targetScan ||
          (targetScan.state !== 'queued' && targetScan.state !== 'running')
        ) {
          sendJson(
            response,
            { error: { code: 'SCAN_NOT_ACTIVE', message: 'Cannot cancel.' } },
            409,
          );
          return;
        }
        targetScan.state = 'cancelled';
        targetScan.updated_at = new Date().toISOString();
        sendJson(response, { id: targetScan.id, state: 'cancelled' });
        return;
      }
      if (
        request.method === 'POST' &&
        parts.length === 4 &&
        parts[0] === 'v1' &&
        parts[1] === 'scans' &&
        parts[3] === 'viewer'
      ) {
        const targetScan = scans.get(parts[2]!);
        if (!targetScan || targetScan.state !== 'succeeded') {
          sendJson(
            response,
            { error: { code: 'VIEWER_NOT_READY', message: 'Not ready.' } },
            409,
          );
          return;
        }
        const scanViewer =
          targetScan.id === activeScanId
            ? viewer
            : await createRepositoryViewer(
                repositorySession(snapshot, targetScan.repository_id),
              );
        extraViewers.push(scanViewer);
        sendJson(response, {
          url: scanViewer.url,
          expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
        });
        return;
      }
      if (
        request.method === 'GET' &&
        parts.length === 4 &&
        parts[0] === 'v1' &&
        parts[1] === 'scans' &&
        parts[3] === 'projects'
      ) {
        sendJson(response, [
          {
            project_id: 'workspace-test-project',
            project_label: 'workspace-test-project',
            status: 'ready',
            snapshot_id: snapshot.facts.snapshotId,
            diagnostics: [],
          },
        ]);
        return;
      }
      if (
        request.method === 'GET' &&
        parts.length === 4 &&
        parts[0] === 'v1' &&
        parts[1] === 'scans' &&
        parts[3] === 'files'
      ) {
        const items = snapshot.facts.files.map((f) => ({
          path: f.path,
          content_hash: f.contentHash,
          git_blob_oid: f.contentHash.slice(0, 40),
          git_mode: '100644' as const,
        }));
        sendJson(response, { items, total: items.length, nextOffset: null });
        return;
      }
      if (
        request.method === 'GET' &&
        parts.length === 6 &&
        parts[0] === 'v1' &&
        parts[1] === 'scans' &&
        parts[3] === 'projects' &&
        parts[5] === 'symbols'
      ) {
        const query = parsedUrl.searchParams.get('query') ?? '';
        const offset = Number(parsedUrl.searchParams.get('offset') ?? '0');
        const req = listSymbolsRequestSchema.parse({
          snapshotId: snapshot.facts.snapshotId,
          query,
          offset,
          limit: 50,
        });
        const matched = snapshot.facts.symbols.filter(
          (sym) =>
            !query ||
            sym.name.toLowerCase().includes(query.toLowerCase()) ||
            sym.filePath.toLowerCase().includes(query.toLowerCase()),
        );
        const pageItems = matched.slice(offset, offset + 50);
        const end = offset + pageItems.length;
        const hasMore = matched.length > end;
        const cov = summarizeCoverage(snapshot.facts.coverageByCapability);
        sendJson(
          response,
          parseListSymbolsResult(req, {
            meta: {
              snapshotId: snapshot.facts.snapshotId,
              evidenceBasis: 'static',
              coverage: cov,
              coverageByCapability: snapshot.facts.coverageByCapability,
              truncated: hasMore,
              truncationReasons: hasMore ? ['result_limit'] : [],
              appliedLimits: { pageSize: 50 },
            },
            items: pageItems,
            total: matched.length,
            nextOffset: hasMore ? end : null,
          }),
        );
        return;
      }
      if (request.method === 'GET' && parsedUrl.pathname === '/v1/ai/status') {
        sendJson(response, options?.aiStatus ?? { enabled: false });
        return;
      }
      if (
        request.method === 'POST' &&
        parts.length === 6 &&
        parts[0] === 'v1' &&
        parts[1] === 'scans' &&
        parts[3] === 'projects' &&
        (parts[5] === 'paths' ||
          parts[5] === 'neighbors' ||
          parts[5] === 'evidence')
      ) {
        const raw = await readRequestJson(request);
        const op = parts[5];
        try {
          if (op === 'paths') {
            const req = findSymbolPathsRequestSchema.parse(raw);
            if (req.snapshotId !== snapshot.facts.snapshotId) {
              sendJson(
                response,
                {
                  error: { code: 'SNAPSHOT_MISMATCH', message: 'Wrong snap.' },
                },
                409,
              );
              return;
            }
            sendJson(
              response,
              parseFindSymbolPathsResult(req, investigation.paths(req)),
            );
            return;
          }
          if (op === 'neighbors') {
            const req = graphNeighborsRequestSchema.parse(raw);
            if (req.snapshotId !== snapshot.facts.snapshotId) {
              sendJson(
                response,
                {
                  error: { code: 'SNAPSHOT_MISMATCH', message: 'Wrong snap.' },
                },
                409,
              );
              return;
            }
            sendJson(
              response,
              parseGraphNeighborsResult(req, investigation.neighbors(req)),
            );
            return;
          }
          const req = getSourceEvidenceRequestSchema.parse(raw);
          if (req.snapshotId !== snapshot.facts.snapshotId) {
            sendJson(
              response,
              { error: { code: 'SNAPSHOT_MISMATCH', message: 'Wrong snap.' } },
              409,
            );
            return;
          }
          sendJson(
            response,
            parseGetSourceEvidenceResult(
              req,
              investigation.sourceEvidence(req),
            ),
          );
          return;
        } catch (error) {
          if (
            error instanceof TraceError &&
            error.code === 'ENTITY_NOT_FOUND'
          ) {
            sendJson(
              response,
              { error: { code: 'NOT_FOUND', message: 'Entity not found.' } },
              404,
            );
            return;
          }
          sendJson(
            response,
            {
              error: { code: 'INVALID_REQUEST', message: 'Invalid query.' },
            },
            400,
          );
          return;
        }
      }
      if (
        request.method === 'POST' &&
        parts.length === 7 &&
        parts[0] === 'v1' &&
        parts[1] === 'scans' &&
        parts[3] === 'projects' &&
        parts[5] === 'ai' &&
        parts[6] === 'synthesize' &&
        options?.onAiSynthesize
      ) {
        const parsed = await readRequestJson(request);
        const synthesized = await options.onAiSynthesize(parsed);
        sendJson(response, synthesized);
        return;
      }
      sendJson(
        response,
        { error: { code: 'NOT_FOUND', message: 'Not found.' } },
        404,
      );
    })().catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : undefined);
    });
  });

  const extraViewers: ViewerHandle[] = [];

  return {
    server,
    gate,
    repositoryId,
    setHoldQueuedScans(value: boolean) {
      holdQueuedScans = value;
    },
    async closeExtraViewers() {
      await Promise.all(
        extraViewers
          .filter((handle) => handle !== viewer)
          .map((handle) => handle.close()),
      );
    },
  };
}

function repositorySession(
  snapshot: AnalysisSnapshot,
  overrideRepositoryId?: string,
): RepositoryInvestigationSession {
  const projectId = 'workspace-test-project';
  const sourceBytes = snapshot.facts.files.reduce(
    (total, file) => total + file.byteLength,
    0,
  );
  const files = snapshot.facts.files.map((file) => ({
    path: file.path,
    sha256: file.contentHash,
    blobId: file.contentHash.slice(0, 40),
    byteLength: file.byteLength,
    status: 'analyzed' as const,
    projectIds: [projectId],
  }));
  return {
    repositoryId: overrideRepositoryId ?? snapshot.facts.identity.repositoryId,
    commitId: 'a'.repeat(40),
    objectFormat: 'sha1',
    inventory: {
      complete: true,
      sourceFiles: files.length,
      sourceBytes,
      metadataFiles: 0,
      excluded: [],
    },
    files,
    projects: [
      {
        project: {
          id: projectId,
          configPath: null,
          rootPaths: files.map((file) => file.path),
          referencePaths: [],
          status: 'ready',
          diagnostics: [],
        },
        status: 'ready',
        snapshot,
      },
    ],
    diagnostics: [],
    sourceCoverageComplete: true,
    analysisComplete: true,
    contextComplete: true,
    metrics: {
      acquisitionMs: 0,
      totalMs: 0,
      resultBytes: 0,
      memberships: files.length,
      contextSourceBytes: sourceBytes,
      parentPeakRssBytes: 0,
      git: {
        subprocesses: 0,
        metadataChecks: 0,
        commitReads: 0,
        treeReads: 0,
        blobReads: files.length,
        metadataBytes: 0,
        blobBytes: sourceBytes,
      },
    },
  };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Backend did not bind to a TCP port.'));
        return;
      }
      resolveListen(address.port);
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise<void>((resolveExit) => child.once('exit', () => resolveExit())),
    delay(5000).then(() => {
      throw new Error(
        'Investigation Workspace development server did not stop.',
      );
    }),
  ]);
}

export type WorkspaceApp = {
  origin: string;
  viewer: ViewerHandle;
  scanReadStarted: Promise<void>;
  releaseScanRead(): void;
  setHoldQueuedScans(value: boolean): void;
  close(): Promise<void>;
};

export type WorkspaceFrontend = {
  origin: string;
  close(): Promise<void>;
};

function testOutputDirectory(workspacePort: number): string {
  return `.next/workspace-test-${workspacePort}`;
}

function testTsconfigFile(workspacePort: number): string {
  return `tsconfig.workspace-test-${workspacePort}.json`;
}

async function prepareTestOutputDirectory(
  workspaceDir: string,
  workspacePort: number,
): Promise<void> {
  await writeFile(
    join(workspaceDir, testTsconfigFile(workspacePort)),
    JSON.stringify({ extends: './tsconfig.json' }),
  );
}

async function removeTestOutputDirectory(
  workspaceDir: string,
  workspacePort: number,
): Promise<void> {
  await Promise.all([
    rm(resolve(workspaceDir, testOutputDirectory(workspacePort)), {
      recursive: true,
      force: true,
    }),
    rm(join(workspaceDir, testTsconfigFile(workspacePort)), { force: true }),
  ]);
}

export async function startWorkspaceFrontend(
  backendOrigin: string,
  token: string,
): Promise<WorkspaceFrontend> {
  const workspacePort = await reservePort();
  const origin = `http://127.0.0.1:${workspacePort}`;
  const workspaceDir = resolve(
    process.cwd(),
    'packages/investigation-workspace',
  );
  const distDir = testOutputDirectory(workspacePort);
  try {
    await prepareTestOutputDirectory(workspaceDir, workspacePort);
  } catch (error) {
    await removeTestOutputDirectory(workspaceDir, workspacePort).catch(
      () => {},
    );
    throw error;
  }
  const nextBin = resolve(
    process.cwd(),
    'packages/investigation-workspace/node_modules/next/dist/bin/next',
  );
  const child = spawn(
    process.execPath,
    [
      nextBin,
      'dev',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(workspacePort),
    ],
    {
      cwd: workspaceDir,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        CODETHREAD_API_ORIGIN: backendOrigin,
        CODETHREAD_API_TOKEN: token,
        CODETHREAD_WORKSPACE_PORT: String(workspacePort),
        CODETHREAD_WORKSPACE_TEST_DIST_DIR: distDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  for (const stream of [child.stdout, child.stderr])
    stream?.on('data', (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-8000);
    });
  try {
    const deadline = Date.now() + 60_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null)
        throw new Error(`Workspace app exited during startup: ${output}`);
      try {
        const response = await fetch(origin, { redirect: 'manual' });
        if (response.status === 200) {
          ready = true;
          break;
        }
      } catch {
        await delay(250);
        continue;
      }
      await delay(250);
    }
    assert.equal(ready, true, `Workspace app did not start: ${output}`);
  } catch (error) {
    await stopProcess(child).catch(() => {});
    await removeTestOutputDirectory(workspaceDir, workspacePort).catch(
      () => {},
    );
    throw error;
  }
  return {
    origin,
    async close() {
      await stopProcess(child);
      await removeTestOutputDirectory(workspaceDir, workspacePort);
    },
  };
}

export async function startWorkspaceApp(
  snapshot: AnalysisSnapshot,
  options: {
    holdScanRead?: boolean;
    holdQueuedScans?: boolean;
    aiStatus?: AiStatusResponse;
    onAiSynthesize?: (
      body: unknown,
    ) => Promise<AiSynthesisResponse> | AiSynthesisResponse;
  } = {},
): Promise<WorkspaceApp> {
  const viewer = await createRepositoryViewer(repositorySession(snapshot));
  const backend = backendServer(
    viewer,
    snapshot,
    options.holdScanRead ?? false,
    snapshot.facts.identity.repositoryId,
    options,
  );
  const backendPort = await listen(backend.server);
  const workspacePort = await reservePort();
  const origin = `http://127.0.0.1:${workspacePort}`;
  const workspaceDir = resolve(
    process.cwd(),
    'packages/investigation-workspace',
  );
  const distDir = testOutputDirectory(workspacePort);
  try {
    await prepareTestOutputDirectory(workspaceDir, workspacePort);
  } catch (error) {
    await closeServer(backend.server).catch(() => {});
    await viewer.close();
    await removeTestOutputDirectory(workspaceDir, workspacePort).catch(
      () => {},
    );
    throw error;
  }
  const nextBin = resolve(
    process.cwd(),
    'packages/investigation-workspace/node_modules/next/dist/bin/next',
  );
  const child = spawn(
    process.execPath,
    [
      nextBin,
      'dev',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(workspacePort),
    ],
    {
      cwd: workspaceDir,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        CODETHREAD_API_ORIGIN: `http://127.0.0.1:${backendPort}`,
        CODETHREAD_API_TOKEN: backendToken,
        CODETHREAD_WORKSPACE_PORT: String(workspacePort),
        CODETHREAD_WORKSPACE_TEST_DIST_DIR: distDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  for (const stream of [child.stdout, child.stderr])
    stream?.on('data', (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-8000);
    });
  try {
    const deadline = Date.now() + 60_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null)
        throw new Error(`Workspace app exited during startup: ${output}`);
      try {
        const response = await fetch(origin, { redirect: 'manual' });
        if (response.status === 200) {
          ready = true;
          break;
        }
      } catch {
        await delay(250);
        continue;
      }
      await delay(250);
    }
    assert.equal(ready, true, `Workspace app did not start: ${output}`);
  } catch (error) {
    await stopProcess(child).catch(() => {});
    await closeServer(backend.server).catch(() => {});
    await backend.closeExtraViewers().catch(() => {});
    await viewer.close();
    await removeTestOutputDirectory(workspaceDir, workspacePort).catch(
      () => {},
    );
    throw error;
  }
  return {
    origin,
    viewer,
    scanReadStarted: backend.gate.started,
    releaseScanRead: backend.gate.release,
    setHoldQueuedScans: backend.setHoldQueuedScans,
    async close() {
      await stopProcess(child);
      await Promise.all([
        closeServer(backend.server),
        backend.closeExtraViewers(),
        viewer.close(),
        removeTestOutputDirectory(workspaceDir, workspacePort),
      ]);
    },
  };
}
