import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { describe, it } from 'vitest';
import { analyzeManifest, COMPILER_PROFILE } from '@codethread/symbol-indexer';
import { startWorkspaceApp } from './browser/workspace-app.ts';

const repositoryId = '22222222-2222-4222-8222-222222222222';
const source = Buffer.from('export function root() { return 1; }');
const snapshot = await analyzeManifest({
  repositoryId,
  compilerOptions: COMPILER_PROFILE,
  files: [
    {
      path: 'src/root.ts',
      bytes: source,
      sha256: createHash('sha256').update(source).digest('hex'),
    },
  ],
});

describe('Investigation Workspace asynchronous context guards', () => {
  it('ignores a delayed scan open after selecting a repository with no active scan', async () => {
    const app = await startWorkspaceApp(snapshot, { holdScanRead: true });
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    try {
      await page.goto(app.origin, { waitUntil: 'domcontentloaded' });
      const repository = page.getByLabel('Repository and scan');
      await repository.selectOption(repositoryId);
      await app.scanReadStarted;
      await repository.selectOption('44444444-4444-4444-8444-444444444444');
      await page.getByText(/This repository has no active scan/).waitFor();
      const openResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/workspace/open',
      );
      app.releaseScanRead();
      await openResponse;
      await page.evaluate(
        () =>
          new Promise<void>((resolveFrame) =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() => resolveFrame()),
            ),
          ),
      );
      assert.equal(
        await page.locator('.context-summary').count(),
        0,
        'the old scan response must not replace the repository selected later',
      );
      assert.equal(
        await page.getByText(/This repository has no active scan/).count(),
        1,
      );
    } finally {
      app.releaseScanRead();
      await context.close();
      await browser.close();
      await app.close();
    }
  }, 90_000);

  it('rejects a session projection whose snapshot identity differs from the selected context', async () => {
    const app = await startWorkspaceApp(snapshot);
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    try {
      await page.route('**/api/workspace/session', async (route) => {
        const response = await route.fetch();
        const payload = (await response.json()) as {
          result: { snapshotId: string };
        };
        payload.result.snapshotId = '55555555-5555-4555-8555-555555555555';
        await route.fulfill({ response, body: JSON.stringify(payload) });
      });
      await page.goto(app.origin, { waitUntil: 'domcontentloaded' });
      await page.getByLabel('Repository and scan').selectOption(repositoryId);
      await page
        .getByRole('alert')
        .getByText(/WORKSPACE_SNAPSHOT_MISMATCH/)
        .waitFor();
      assert.equal(
        await page.getByLabel('Name or source path').isDisabled(),
        true,
        'symbol queries stay disabled after an identity mismatch',
      );
    } finally {
      await context.close();
      await browser.close();
      await app.close();
    }
  }, 90_000);

  it('rejects project inventory whose repository revision differs from the opened scan', async () => {
    const app = await startWorkspaceApp(snapshot);
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    try {
      await page.route('**/api/workspace/projects', async (route) => {
        const response = await route.fetch();
        const payload = (await response.json()) as { commitId: string };
        payload.commitId = 'b'.repeat(40);
        await route.fulfill({ response, body: JSON.stringify(payload) });
      });
      await page.goto(app.origin, { waitUntil: 'domcontentloaded' });
      await page.getByLabel('Repository and scan').selectOption(repositoryId);
      await page
        .getByRole('alert')
        .getByText(/WORKSPACE_SCAN_MISMATCH/)
        .waitFor();
      assert.equal(
        await page.getByLabel('Name or source path').isDisabled(),
        true,
        'catalog queries stay disabled when the opened scan revision is inconsistent',
      );
    } finally {
      await context.close();
      await browser.close();
      await app.close();
    }
  }, 90_000);

  it('ignores delayed symbol results and errors after the search query changes', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      for (const outcome of ['success', 'error'] as const) {
        const app = await startWorkspaceApp(snapshot);
        const context = await browser.newContext();
        const page = await context.newPage();
        page.setDefaultTimeout(15_000);
        let markStarted = () => {};
        let releaseGate = () => {};
        const started = new Promise<void>((resolveStarted) => {
          markStarted = resolveStarted;
        });
        const gate = new Promise<void>((resolveGate) => {
          releaseGate = resolveGate;
        });
        try {
          await page.route('**/api/workspace/symbols', async (route) => {
            const body = route.request().postDataJSON() as {
              request?: { query?: string };
            };
            if (body.request?.query !== 'root') {
              await route.continue();
              return;
            }
            markStarted();
            await gate;
            if (outcome === 'error') {
              await route.fulfill({
                status: 503,
                contentType: 'application/json',
                body: JSON.stringify({
                  error: {
                    code: 'DELAYED_SEARCH_FAILURE',
                    message: 'Delayed search failed.',
                  },
                }),
              });
            } else {
              await route.continue();
            }
          });
          await page.goto(app.origin, { waitUntil: 'domcontentloaded' });
          await page
            .getByLabel('Repository and scan')
            .selectOption(repositoryId);
          await page.waitForFunction(
            () =>
              !document.querySelector<HTMLInputElement>('#symbol-query')
                ?.disabled,
          );
          await page.getByLabel('Name or source path').fill('root');
          await started;
          const staleResponse = page.waitForResponse(
            (response) =>
              new URL(response.url()).pathname === '/api/workspace/symbols' &&
              response.request().postDataJSON()?.request?.query === 'root',
          );
          await page.getByLabel('Name or source path').fill('absent');
          await page.getByText('0 matching symbols', { exact: true }).waitFor();
          releaseGate();
          const response = await staleResponse;
          assert.equal(response.status(), outcome === 'error' ? 503 : 200);
          await page.evaluate(
            () =>
              new Promise<void>((resolveFrame) =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => resolveFrame()),
                ),
              ),
          );
          assert.equal(
            await page.getByRole('button', { name: /root.*function/ }).count(),
            0,
            'the prior query result must not repopulate the current results',
          );
          assert.equal(
            await page
              .getByRole('alert')
              .getByText(/DELAYED_SEARCH_FAILURE/)
              .count(),
            0,
            'the prior query error must not replace the current query state',
          );
        } finally {
          releaseGate();
          await context.close();
          await app.close();
        }
      }
    } finally {
      await browser.close();
    }
  }, 120_000);
});
