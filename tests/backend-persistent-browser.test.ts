import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { describe, expect, it } from 'vitest';
import { connect } from '../scripts/backend/database.ts';
import { applyMigrations } from '../scripts/backend/migrations.ts';
import { loadRepositorySession } from '../scripts/backend/session-persistence.ts';
import { openPage, assertLocalOnly } from './browser/helpers.ts';
import { createGitRepository, runGitFixture } from './helpers/git-fixture.ts';

const databaseUrl = process.env.CODETHREAD_TEST_DATABASE_URL;
const processPath = fileURLToPath(
  new URL('./backend-http-process.ts', import.meta.url),
);
const source =
  'function register(value:unknown){} export function target(){return 1} export class Box { ping(){return 2} } export function entry(box:Box){register(box.ping); return target()+missing()+box.ping()}';

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

function startBackend(port: number, token: string) {
  return spawn(process.execPath, [processPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CODETHREAD_DATABASE_URL: databaseUrl!,
      CODETHREAD_ALLOWED_REPO_ROOT: tmpdir(),
      CODETHREAD_ANALYZER_BUILD_HASH: 'a'.repeat(64),
      CODETHREAD_API_TOKEN: token,
      CODETHREAD_TEST_API_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
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
    }, 15_000);
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

async function request<T>(
  port: number,
  token: string,
  path: string,
  body?: object,
): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok)
    throw new Error(`Backend request returned ${response.status}`);
  return (await response.json()) as T;
}

async function inspectViewer(
  browser: Browser,
  url: string,
  projectId: string,
  sourceHash: string,
) {
  const page = await openPage(
    browser,
    new URL(url).origin,
    url,
    'project-select',
  );
  try {
    expect(await page.locator('#repository-summary').innerText()).toMatch(
      /Inventory complete=true; source analyzed=false; projects finished=false/,
    );
    await page
      .getByText('Source inventory and project diagnostics', { exact: true })
      .click();
    await page
      .locator('#source-files')
      .getByText(/packages\/bad\/index.ts: not_analyzed.*MALFORMED_SOURCE/)
      .waitFor();
    await page
      .getByText('Source inventory and project diagnostics', { exact: true })
      .click();
    const search = page.getByLabel('Name or source path');
    await search.fill('entry');
    await search.press('Enter');
    await page
      .locator(`#symbol-results button[data-project-id="${projectId}"]`)
      .first()
      .click();
    await page
      .getByRole('heading', { name: 'function entry', exact: true })
      .waitFor();
    await page
      .getByLabel('Direction', { exact: true })
      .selectOption('outgoing');
    const call = page
      .locator('#relationships .relationship-item')
      .filter({ hasText: 'CALLS exact' })
      .filter({ hasText: 'Target: target' })
      .first();
    await call
      .getByRole('button', { name: 'View occurrence evidence', exact: true })
      .click();
    const uncertainText =
      (await page.locator('#relationships').innerText()) +
      (await page.locator('#unknowns').innerText());
    expect(uncertainText).toMatch(/unresolved|unsupported/i);
    await page
      .locator('#evidence pre')
      .getByText('target()', { exact: true })
      .waitFor();
    expect(await page.locator('#evidence').innerText()).toContain(sourceHash);
    const callEvidence = await page.locator('#evidence pre').innerText();
    await page.getByRole('checkbox', { name: 'REFERENCES' }).check();
    await page.getByRole('checkbox', { name: 'CALLS' }).uncheck();
    const reference = page
      .locator('#relationships .relationship-item')
      .filter({ hasText: 'REFERENCES exact' })
      .first();
    await reference
      .getByRole('button', { name: 'View occurrence evidence', exact: true })
      .click();
    await page
      .locator('#evidence pre')
      .getByText('box.ping', { exact: true })
      .waitFor();
    expect(await page.locator('#evidence').innerText()).toContain(sourceHash);
    const referenceEvidence = await page.locator('#evidence pre').innerText();
    assertLocalOnly(page);
    return { callEvidence, referenceEvidence };
  } finally {
    await page.context().close();
  }
}

describe.skipIf(!databaseUrl)(
  'persistent repository viewer in a browser',
  () => {
    it('reopens pinned partial PostgreSQL results and source evidence after backend restart', async () => {
      const directories: string[] = [],
        fixture = await createGitRepository(
          [
            { path: 'package.json', source: '{"workspaces":["packages/*"]}' },
            {
              path: 'tsconfig.json',
              source:
                '{"files":[],"references":[{"path":"packages/good"},{"path":"packages/bad"}]}',
            },
            ...['good', 'bad'].flatMap((name) => [
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
                source: name === 'good' ? source : 'export function broken( {',
              },
            ]),
          ],
          directories,
        ),
        sourceHash = createHash('sha256').update(source).digest('hex'),
        token = randomBytes(32).toString('hex'),
        port = await reservePort(),
        db = connect(databaseUrl!);
      let child: ChildProcess | undefined, browser: Browser | undefined;
      try {
        await applyMigrations(db);
        child = startBackend(port, token);
        await ready(child);
        const repository = await request<{ id: string }>(
            port,
            token,
            '/v1/repositories',
            { locator: fixture.directory },
          ),
          job = await request<{ id: string }>(
            port,
            token,
            `/v1/repositories/${repository.id}/scans`,
            { revision: 'HEAD', idempotencyKey: 'persistent-browser' },
          );
        const deadline = Date.now() + 45_000;
        let state = await request<{
          state: string;
          git_commit_oid: string | null;
        }>(port, token, `/v1/scans/${job.id}`);
        while (
          !['succeeded', 'failed', 'cancelled'].includes(state.state) &&
          Date.now() < deadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          state = await request(port, token, `/v1/scans/${job.id}`);
        }
        expect(state).toMatchObject({
          state: 'succeeded',
          git_commit_oid: fixture.revision,
        });
        const session = await loadRepositorySession(db, job.id),
          good = session.projects.find(
            (project) =>
              project.project.configPath === 'packages/good/tsconfig.json',
          ),
          bad = session.projects.find(
            (project) =>
              project.project.configPath === 'packages/bad/tsconfig.json',
          );
        expect(session).toMatchObject({
          commitId: fixture.revision,
          sourceCoverageComplete: false,
          contextComplete: false,
          analysisComplete: false,
        });
        expect(session.inventory.sourceFiles).toBe(2);
        expect(
          session.files.filter((file) => file.status === 'analyzed'),
        ).toHaveLength(1);
        expect(
          session.files.filter((file) => file.status === 'not_analyzed'),
        ).toHaveLength(1);
        expect(bad).toMatchObject({
          status: 'failed',
          error: { code: 'MALFORMED_SOURCE' },
        });
        expect(good?.status).toBe('ready');
        expect(
          good?.snapshot?.facts.relations.some(
            (relation) =>
              relation.kind === 'calls' &&
              relation.resolution.status === 'exact',
          ),
        ).toBe(true);
        expect(
          good?.snapshot?.facts.relations.some(
            (relation) =>
              relation.kind === 'references' &&
              relation.resolution.status === 'exact',
          ),
        ).toBe(true);
        expect(good?.snapshot?.facts.counts.unresolved).toBeGreaterThan(0);
        expect(good?.snapshot?.facts.counts.unsupported).toBeGreaterThan(0);
        if (!good?.snapshot) throw new Error('Pinned ready project is missing');
        const counts = good.snapshot.facts.counts;
        expect(counts.callSites).toBe(
          counts.exact +
            counts.unresolved +
            counts.ambiguous +
            counts.unsupported,
        );
        const viewer = await request<{ url: string }>(
          port,
          token,
          `/v1/scans/${job.id}/viewer`,
          {},
        );
        browser = await chromium.launch({ headless: true });
        const before = await inspectViewer(
          browser,
          viewer.url,
          good.project.id,
          sourceHash,
        );
        await writeFile(
          join(fixture.directory, 'packages/good/index.ts'),
          'export function changedHead(){return 2}',
        );
        await runGitFixture(fixture.directory, [
          'add',
          '--',
          'packages/good/index.ts',
        ]);
        await runGitFixture(fixture.directory, [
          '-c',
          'user.name=CodeThread Test',
          '-c',
          'user.email=test@example.invalid',
          'commit',
          '-qm',
          'move HEAD',
        ]);
        expect(
          (
            await runGitFixture(fixture.directory, ['rev-parse', 'HEAD'])
          ).trim(),
        ).not.toBe(fixture.revision);
        await rm(fixture.directory, { recursive: true, force: true });
        await stop(child);
        expect(child.exitCode).toBe(0);
        child = startBackend(port, token);
        await ready(child);
        const reopened = await request<{ url: string }>(
          port,
          token,
          `/v1/scans/${job.id}/viewer`,
          {},
        );
        expect(
          await inspectViewer(
            browser,
            reopened.url,
            good.project.id,
            sourceHash,
          ),
        ).toEqual(before);
        expect((await loadRepositorySession(db, job.id)).commitId).toBe(
          fixture.revision,
        );
      } finally {
        await browser?.close();
        await stop(child);
        await db.end({ timeout: 5 });
        for (const directory of directories)
          await rm(directory, { recursive: true, force: true });
      }
    }, 120_000);
  },
);
