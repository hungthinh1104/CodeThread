import { analyzerBuildHash as currentAnalyzerBuildHash } from '@codethread/symbol-indexer';
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
import { startWorkspaceFrontend } from './browser/workspace-app.ts';
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
      CODETHREAD_ANALYZER_BUILD_HASH: currentAnalyzerBuildHash(),
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
  method?: 'GET' | 'POST',
): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok)
    throw new Error(`Backend request returned ${response.status}`);
  return (await response.json()) as T;
}

async function expectPublishedScan(
  port: number,
  token: string,
  scanId: string,
  commit: string,
) {
  await expect
    .poll(
      () =>
        request<{ state: string; git_commit_oid: string | null }>(
          port,
          token,
          `/v1/scans/${scanId}`,
        ),
      { timeout: 45_000 },
    )
    .toMatchObject({ state: 'succeeded', git_commit_oid: commit });
}

async function inspectViewer(
  browser: Browser,
  url: string,
  projectId: string,
  sourceHash: string,
  backendToken: string,
) {
  const page = await openPage(
    browser,
    new URL(url).origin,
    url,
    'project-select',
  );
  try {
    expect(new URL(url).hash.slice(1)).not.toBe(backendToken);
    expect(
      await page.locator('html').evaluate((node) => node.innerHTML),
    ).not.toContain(backendToken);
    const browserAuthorizationHeaders: string[] = [];
    page.on('request', (request) => {
      const authorization = request.headers().authorization;
      if (authorization) browserAuthorizationHeaders.push(authorization);
    });
    expect(
      await page
        .getByRole('tab', { name: 'Source' })
        .getAttribute('aria-selected'),
    ).toBe('true');
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
      .locator('#source-evidence pre')
      .getByText('function entry', { exact: false })
      .waitFor();
    expect(await page.locator('#source-evidence').innerText()).toContain(
      sourceHash,
    );
    await page.getByRole('tab', { name: 'Trace' }).click();
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
    expect(await page.locator('#source-evidence pre').innerText()).toBe(
      referenceEvidence,
    );
    expect(browserAuthorizationHeaders).toEqual([]);
    assertLocalOnly(page);
    return { callEvidence, referenceEvidence };
  } finally {
    await page.context().close();
  }
}

async function inspectWorkspaceFrontend(
  browser: Browser,
  origin: string,
  repositoryId: string,
  expectedProjectId: string,
  sourceHash: string,
  backendToken: string,
  comparison?: { repositoryId: string; path: string },
) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const outside: string[] = [];
  const expectedHost = new URL(origin).host;
  await context.route('**/*', async (route) => {
    const actual = new URL(route.request().url());
    if (actual.host !== expectedHost) {
      outside.push(route.request().url());
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  const browserAuthorizationHeaders: string[] = [];
  page.on('request', (request) => {
    const authorization = request.headers().authorization;
    if (authorization) browserAuthorizationHeaders.push(authorization);
  });
  try {
    if (comparison)
      await page.route(
        '**/api/workspace/files',
        (route) => route.abort('failed'),
        { times: 1 },
      );
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page
      .getByRole('heading', { name: 'Investigation Workspace' })
      .waitFor();
    await page.getByLabel('Repository and scan').selectOption(repositoryId);
    await page.waitForFunction(
      () =>
        !document.querySelector<HTMLInputElement>('#symbol-query')?.disabled,
    );
    expect(await page.locator('.context-summary').innerText()).toMatch(
      /Revision\s+HEAD/,
    );
    expect(await page.locator('.coverage-checks').innerText()).toMatch(
      /Git inventory:\s*complete/,
    );
    expect(await page.locator('.coverage-checks').innerText()).toMatch(
      /Source coverage:\s*incomplete/,
    );
    expect(await page.locator('.coverage-checks').innerText()).toMatch(
      /Project analysis:\s*incomplete/,
    );
    expect(await page.locator('.coverage-checks').innerText()).toMatch(
      /Compiler contexts:\s*incomplete/,
    );
    const projectOptions = await page
      .locator('#project-select option')
      .allTextContents();
    expect(projectOptions.some((text) => /failed/i.test(text))).toBe(true);
    const unavailable = page
      .locator('.diagnostics')
      .filter({ hasText: /Unavailable project contexts/ });
    await unavailable.locator('summary').click();
    expect(await unavailable.innerText()).toMatch(/MALFORMED_SOURCE/);

    await page.getByLabel('Name or source path').fill('entry');
    await page
      .getByRole('button', { name: /entry.*function/ })
      .first()
      .click();
    await page.locator('.source-excerpt').waitFor();
    expect(await page.locator('.source-excerpt').innerText()).toContain(
      sourceHash,
    );
    expect(await page.locator('.source-excerpt').innerText()).toMatch(
      /function entry/,
    );
    expect(await page.getByLabel('Project context').inputValue()).toBe(
      expectedProjectId,
    );
    await page.getByRole('tab', { name: 'Trace' }).click();
    await page.getByText('Evidence basis: static', { exact: true }).waitFor();
    const call = page
      .locator('.relationship-list li')
      .filter({ hasText: /CALLS.*exact/ })
      .filter({ hasText: 'target' })
      .first();
    await call.waitFor();
    await call
      .getByRole('button', { name: 'Inspect occurrence evidence' })
      .click();
    await page
      .locator('#evidence-inspector .evidence-card')
      .getByText(sourceHash)
      .waitFor();
    const traceText = await page.locator('#trace-panel').innerText();
    expect(traceText).toContain('Coverage: partial');
    expect(traceText).toContain('Query not truncated');
    for (const status of ['unresolved', 'unsupported']) {
      const uncertain = page
        .locator('#trace-panel .relationship-list li')
        .filter({ hasText: new RegExp('CALLS.*' + status) });
      await uncertain.first().waitFor();
      expect(
        await uncertain.getByRole('button', { name: /^Follow / }).count(),
      ).toBe(0);
    }
    expect(await page.locator('#evidence-inspector').innerText()).toContain(
      sourceHash,
    );
    await page
      .getByRole('checkbox', { name: 'REFERENCES', exact: true })
      .check();
    await page
      .locator('.relationship-list li')
      .filter({ hasText: /REFERENCES.*exact/ })
      .first()
      .waitFor();
    await page.getByRole('tab', { name: 'Source' }).click();
    await page.locator('.source-excerpt').waitFor();
    await page.getByRole('tab', { name: 'Trace' }).click();
    await page.getByLabel('Direction').selectOption('both');
    await page.getByText('Evidence basis: static', { exact: true }).waitFor();
    expect(
      await page.locator('#evidence-inspector .evidence-card').count(),
    ).toBe(1);
    await call
      .getByRole('button', { name: 'Inspect occurrence evidence' })
      .click();
    await page
      .locator('#evidence-inspector')
      .getByText('Occurrence evidence')
      .waitFor();
    await page.route(
      '**/api/workspace/evidence',
      (route) => route.abort('failed'),
      { times: 1 },
    );
    await page.getByRole('tab', { name: 'Source' }).click();
    const retryEvidence = page
      .locator('#source-panel')
      .getByRole('button', { name: 'Retry evidence' });
    await retryEvidence.waitFor();
    expect(await page.locator('.source-excerpt').count()).toBe(0);
    await retryEvidence.click();
    await page.locator('.source-excerpt').getByText(sourceHash).waitFor();

    await page.getByRole('tab', { name: 'Trace' }).click();
    await call
      .getByRole('button', { name: 'Follow target', exact: true })
      .click();
    const root = page.locator('.selected-symbol');
    await root.getByText('function target', { exact: true }).waitFor();
    await page.locator('.source-excerpt').getByText(sourceHash).waitFor();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await root.getByText('function entry', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Forward', exact: true }).click();
    await root.getByText('function target', { exact: true }).waitFor();
    await page.getByRole('tab', { name: 'Trace' }).click();
    await page.route(
      '**/api/workspace/neighbors',
      (route) => route.abort('failed'),
      { times: 1 },
    );
    await page.getByLabel('Direction').selectOption('incoming');
    const retryTrace = page.getByRole('button', { name: 'Retry trace' });
    await retryTrace.waitFor();
    expect(await page.getByText(/No returned relationships/).count()).toBe(0);
    await retryTrace.click();
    await page
      .locator('.relationship-list li')
      .filter({ hasText: /entry.*target/ })
      .filter({ hasText: /CALLS.*exact/ })
      .first()
      .waitFor();
    if (comparison) {
      for (let index = 0; index < 5; index++) {
        const reopened = await context.newPage();
        try {
          await reopened.goto(origin, { waitUntil: 'domcontentloaded' });
          await reopened
            .getByLabel('Repository and scan')
            .selectOption(repositoryId);
          await reopened
            .getByRole('region', { name: 'Source inventory' })
            .getByText('packages/good/index.ts', { exact: true })
            .waitFor();
        } finally {
          await reopened.close();
        }
      }
      const otherTab = await context.newPage();
      await otherTab.goto(origin, { waitUntil: 'domcontentloaded' });
      await otherTab
        .getByLabel('Repository and scan')
        .selectOption(comparison.repositoryId);
      await otherTab
        .getByRole('region', { name: 'Source inventory' })
        .getByText(comparison.path, { exact: true })
        .waitFor();
      await otherTab.getByLabel('Name or source path').fill('fanout');
      await otherTab.getByRole('button', { name: /fanout.*function/ }).click();
      await otherTab.getByRole('tab', { name: 'Trace' }).click();
      await otherTab
        .getByText('Evidence basis: static', { exact: true })
        .waitFor();
      expect(
        await otherTab.locator('#trace-panel .coverage-summary').innerText(),
      ).toContain('Truncated: result_limit');
      // One root and at most 49 target declarations fit the 50-node request.
      expect(
        await otherTab
          .locator('#trace-panel .relationship-list')
          .getByRole('button', { name: /^Follow callee/ })
          .count(),
      ).toBe(49);
      const retried = page.waitForResponse((response) =>
        response.url().endsWith('/api/workspace/files'),
      );
      await page.getByRole('button', { name: 'Retry file inventory' }).click();
      const response = await retried;
      expect(response.status()).toBe(200);
      const inventory = await response.json();
      expect(
        inventory.items.map((item: { path: string }) => item.path),
      ).toEqual(['packages/bad/index.ts', 'packages/good/index.ts']);
      await page
        .getByRole('region', { name: 'Source inventory' })
        .getByText('packages/good/index.ts', { exact: true })
        .waitFor();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page
        .getByRole('region', { name: 'Source inventory' })
        .getByText('packages/good/index.ts', { exact: true })
        .waitFor();
      await otherTab.close();
    }
    expect(browserAuthorizationHeaders).toEqual([]);
    expect(await page.locator('html').innerText()).not.toContain(backendToken);
    expect(outside).toEqual([]);
    expect(new URL(page.url()).host).toBe(expectedHost);
  } finally {
    await context.close();
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
      let child: ChildProcess | undefined,
        browser: Browser | undefined,
        workspaceFrontend:
          Awaited<ReturnType<typeof startWorkspaceFrontend>> | undefined;
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
        await expectPublishedScan(port, token, job.id, fixture.revision);
        const comparisonPath = 'second-only.ts',
          callees = Array.from({ length: 52 }, (_, index) => `callee${index}`),
          comparison = await createGitRepository(
            [
              {
                path: comparisonPath,
                source: [
                  `export function fanout() { return ${callees.map((name) => `${name}()`).join(' + ')}; }`,
                  ...callees.map(
                    (name, index) => `function ${name}() { return ${index}; }`,
                  ),
                ].join('\n'),
              },
            ],
            directories,
          ),
          comparisonRepository = await request<{ id: string }>(
            port,
            token,
            '/v1/repositories',
            { locator: comparison.directory },
          ),
          comparisonScan = await request<{ id: string }>(
            port,
            token,
            `/v1/repositories/${comparisonRepository.id}/scans`,
            {
              revision: comparison.revision,
              idempotencyKey: 'workspace-comparison',
            },
          );
        await expectPublishedScan(
          port,
          token,
          comparisonScan.id,
          comparison.revision,
        );
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
          undefined,
          'POST',
        );
        browser = await chromium.launch({ headless: true });
        workspaceFrontend = await startWorkspaceFrontend(
          `http://127.0.0.1:${port}`,
          token,
        );
        await inspectWorkspaceFrontend(
          browser,
          workspaceFrontend.origin,
          repository.id,
          good.project.id,
          sourceHash,
          token,
          { repositoryId: comparisonRepository.id, path: comparisonPath },
        );
        const before = await inspectViewer(
          browser,
          viewer.url,
          good.project.id,
          sourceHash,
          token,
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
          undefined,
          'POST',
        );
        await inspectWorkspaceFrontend(
          browser,
          workspaceFrontend.origin,
          repository.id,
          good.project.id,
          sourceHash,
          token,
        );
        expect(
          await inspectViewer(
            browser,
            reopened.url,
            good.project.id,
            sourceHash,
            token,
          ),
        ).toEqual(before);
        expect((await loadRepositorySession(db, job.id)).commitId).toBe(
          fixture.revision,
        );
      } finally {
        await workspaceFrontend?.close();
        await browser?.close();
        await stop(child);
        await db.end({ timeout: 5 });
        for (const directory of directories)
          await rm(directory, { recursive: true, force: true });
      }
    }, 120_000);
  },
);
