import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { join, resolve } from 'node:path';
import type { AnalysisSnapshot } from '@codethread/symbol-indexer';
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

function backendServer(
  viewer: ViewerHandle,
  holdScanRead: boolean,
  repositoryId: string,
) {
  const gate = deferred();
  const now = new Date().toISOString();
  const commitId = 'a'.repeat(40);
  const scan = {
    id: activeScanId,
    repository_id: repositoryId,
    generation: '1',
    state: 'succeeded',
    attempt: 1,
    revision_selector: 'fixture-commit',
    git_commit_oid: commitId,
    git_tree_oid: 'b'.repeat(40),
    activation_result: 'activated',
    error_code: null,
    error_message: null,
    created_at: now,
    updated_at: now,
  };
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
      if (request.method === 'GET' && request.url === '/v1/repositories') {
        sendJson(response, [
          {
            id: repositoryId,
            locator: 'C:/fixtures/codethread-fixture',
            desired_generation: '1',
            active_job_id: activeScanId,
          },
          {
            id: inactiveRepositoryId,
            locator: 'C:/fixtures/no-active-scan',
            desired_generation: '0',
            active_job_id: null,
          },
        ]);
        return;
      }
      if (
        request.method === 'GET' &&
        request.url === `/v1/scans/${activeScanId}`
      ) {
        if (holdScanRead) await gate.wait();
        sendJson(response, scan);
        return;
      }
      if (
        request.method === 'POST' &&
        request.url === `/v1/scans/${activeScanId}/viewer`
      ) {
        sendJson(response, {
          url: viewer.url,
          expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
        });
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
  return {
    server,
    gate,
    repositoryId,
    scan,
  };
}

function repositorySession(
  snapshot: AnalysisSnapshot,
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
    repositoryId: snapshot.facts.identity.repositoryId,
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
  options: { holdScanRead?: boolean } = {},
): Promise<WorkspaceApp> {
  const viewer = await createRepositoryViewer(repositorySession(snapshot));
  const backend = backendServer(
    viewer,
    options.holdScanRead ?? false,
    snapshot.facts.identity.repositoryId,
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
    async close() {
      await stopProcess(child);
      await Promise.all([
        closeServer(backend.server),
        viewer.close(),
        removeTestOutputDirectory(workspaceDir, workspacePort),
      ]);
    },
  };
}
