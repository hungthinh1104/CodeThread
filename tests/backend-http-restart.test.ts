import { randomBytes } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { connect } from '../scripts/backend/database.ts';
import { applyMigrations } from '../scripts/backend/migrations.ts';

const databaseUrl = process.env.CODETHREAD_TEST_DATABASE_URL;

async function createFixture(root: string) {
  const folder = join(root, 'repo');
  await mkdir(join(folder, 'src'), { recursive: true });
  await writeFile(
    join(folder, 'src', 'index.ts'),
    'export function target() { return 3; }\nexport function consumer() { return target(); }\n',
  );
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
    '--all',
  );
  git(
    '-c',
    'user.name=CodeThread Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-qm',
    'Pinned persistent HTTP fixture',
  );
  return { folder, commit: git('rev-parse', 'HEAD').trim() };
}

async function reservePort() {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  if (!address || typeof address === 'string')
    throw new Error('Could not reserve an API port');
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function waitForMessage(child: ChildProcess, expected: string) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`HTTP worker did not send ${expected}`));
    }, 20_000);
    const onMessage = (message: unknown) => {
      if (message !== expected) return;
      cleanup();
      resolve();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(`HTTP worker exited before ${expected}: ${code ?? signal}`),
      );
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
  });
}

function waitForExit(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

function startApiProcess(input: {
  root: string;
  buildHash: string;
  token: string;
  port: number;
}) {
  const workerPath = fileURLToPath(
    new URL('./backend-http-process.ts', import.meta.url),
  );
  return spawn(process.execPath, [workerPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CODETHREAD_DATABASE_URL: databaseUrl!,
      CODETHREAD_ALLOWED_REPO_ROOT: input.root,
      CODETHREAD_ANALYZER_BUILD_HASH: input.buildHash,
      CODETHREAD_API_TOKEN: input.token,
      CODETHREAD_TEST_API_PORT: String(input.port),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
}

async function request<T>(
  port: number,
  token: string,
  path: string,
  method: 'GET' | 'POST' = 'GET',
  body?: object,
): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok)
    throw new Error(`Persistent API request returned ${response.status}`);
  return (await response.json()) as T;
}

async function readInvestigation(
  port: number,
  token: string,
  scanId: string,
  projectId: string,
  snapshotId: string,
) {
  const base = `/v1/scans/${scanId}/projects/${projectId}`,
    consumers = await request<{
      items: { id: string; name: string }[];
    }>(port, token, `${base}/symbols?query=consumer`),
    targets = await request<{
      items: { id: string; name: string; declarationEvidenceId: string }[];
    }>(port, token, `${base}/symbols?query=target`),
    consumer = consumers.items.find((symbol) => symbol.name === 'consumer'),
    target = targets.items.find((symbol) => symbol.name === 'target');
  if (!consumer || !target)
    throw new Error('Symbols could not be reopened through the API');
  return {
    consumers,
    targets,
    neighbors: await request(port, token, `${base}/neighbors`, 'POST', {
      snapshotId,
      symbolId: consumer.id,
      direction: 'outgoing',
      depth: 1,
      nodeLimit: 20,
    }),
    paths: await request(port, token, `${base}/paths`, 'POST', {
      snapshotId,
      fromSymbolId: consumer.id,
      toSymbolId: target.id,
      depth: 1,
      nodeLimit: 20,
      pathLimit: 5,
    }),
    evidence: await request(port, token, `${base}/evidence`, 'POST', {
      snapshotId,
      evidenceIds: [target.declarationEvidenceId],
    }),
  };
}

describe.skipIf(!databaseUrl)('PostgreSQL HTTP restart recovery', () => {
  it('reopens the identical investigation after a real API process restart', async () => {
    const root = await mkdtemp(join(process.cwd(), '.tooling-http-restart-')),
      fixture = await createFixture(root),
      db = connect(databaseUrl!),
      token = randomBytes(32).toString('hex'),
      buildHash = randomBytes(32).toString('hex'),
      port = await reservePort();
    let first: ChildProcess | undefined, second: ChildProcess | undefined;
    try {
      await applyMigrations(db);
      first = startApiProcess({ root, buildHash, token, port });
      await waitForMessage(first, 'ready');
      const registered = await request<{ id: string }>(
          port,
          token,
          '/v1/repositories',
          'POST',
          { locator: fixture.folder },
        ),
        accepted = await request<{ id: string }>(
          port,
          token,
          `/v1/repositories/${registered.id}/scans`,
          'POST',
          {
            revision: 'HEAD',
            idempotencyKey: 'http-process-persisted-investigation',
          },
        ),
        deadline = Date.now() + 60_000;
      let job: { state: string; git_commit_oid: string | null } | undefined;
      while (Date.now() < deadline) {
        const current = await request<{
          state: string;
          git_commit_oid: string | null;
        }>(port, token, `/v1/scans/${accepted.id}`);
        job = current;
        if (['succeeded', 'failed', 'cancelled'].includes(current.state)) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (job?.state !== 'succeeded')
        throw new Error(
          `HTTP scan ended ${job?.state ?? 'without a response'}`,
        );
      expect(job.git_commit_oid).toBe(fixture.commit);
      const projects = await request<
          { project_id: string; status: string; snapshot_id: string | null }[]
        >(port, token, `/v1/scans/${accepted.id}/projects`),
        project = projects.find((item) => item.status === 'ready');
      expect(project?.snapshot_id).toBeTruthy();
      const original = await readInvestigation(
        port,
        token,
        accepted.id,
        project!.project_id,
        project!.snapshot_id!,
      );
      expect(original.paths).toMatchObject({ paths: expect.any(Array) });
      expect(original.evidence).toMatchObject({
        items: [{ status: 'available', filePath: 'src/index.ts' }],
      });

      first.send('crash');
      await waitForMessage(first, 'crash-received');
      await waitForExit(first);
      expect(first.exitCode).toBe(86);
      second = startApiProcess({ root, buildHash, token, port });
      await waitForMessage(second, 'ready');
      const reopened = await readInvestigation(
        port,
        token,
        accepted.id,
        project!.project_id,
        project!.snapshot_id!,
      );
      expect(reopened).toEqual(original);
      expect(job.git_commit_oid).toBe(fixture.commit);
      second.send('stop');
      await waitForExit(second);
      second = undefined;
    } finally {
      for (const child of [first, second])
        if (child && child.exitCode === null && child.signalCode === null) {
          child.send('crash');
          await waitForExit(child);
        }
      await db.end({ timeout: 5 });
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
