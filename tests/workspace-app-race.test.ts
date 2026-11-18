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
  it('keeps Back within the retained navigation history after many selections', async () => {
    const app = await startWorkspaceApp(snapshot);
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    try {
      await page.goto(app.origin, { waitUntil: 'domcontentloaded' });
      await page.getByLabel('Repository and scan').selectOption(repositoryId);
      await page.waitForFunction(
        () =>
          !document.querySelector<HTMLInputElement>('#symbol-query')?.disabled,
      );
      await page.getByLabel('Name or source path').fill('root');
      const rootResult = page.getByRole('button', { name: /root.*function/ });
      await rootResult.click();
      await page.locator('.source-excerpt').waitFor();

      const history = page.getByRole('navigation', {
        name: 'Investigation history',
      });
      const startVersion = Number(
        await history.getAttribute('data-history-version'),
      );
      for (let selection = 1; selection <= 40; selection++) {
        const previousVersion = Number(
          await history.getAttribute('data-history-version'),
        );
        await rootResult.click();
        await page.waitForFunction((version) => {
          const current = document.querySelector<HTMLElement>(
            'nav[aria-label="Investigation history"]',
          );
          return Number(current?.dataset.historyVersion) > version;
        }, previousVersion);
      }
      assert.equal(
        Number(await history.getAttribute('data-history-version')) -
          startVersion,
        40,
        'each repeated selection must append a browser history entry',
      );
      assert.equal(
        await history.count(),
        1,
        `history controls must remain present after repeated selection: ${await page.locator('body').innerText()}`,
      );
      const historyButtons = await history.locator('button').allTextContents();
      assert.equal(
        historyButtons.length,
        2,
        `history controls must expose Back and Forward: ${JSON.stringify(historyButtons)}; body=${await page.locator('body').innerText()}`,
      );
      const back = history.getByRole('button', { name: 'Back', exact: true });
      let backSteps = 0;
      while (!(await back.isDisabled()) && backSteps < 50) {
        const historyVersion = Number(
          await history.getAttribute('data-history-version'),
        );
        await back.click();
        await page.waitForFunction(
          (previousVersion) => {
            const current = document.querySelector<HTMLElement>(
              'nav[aria-label="Investigation history"]',
            );
            return Number(current?.dataset.historyVersion) > previousVersion;
          },
          historyVersion,
          { timeout: 5_000 },
        );
        backSteps++;
      }
      assert.equal(
        backSteps,
        39,
        'Back must stop at the oldest of the 40 retained workspace states',
      );
      assert.equal(await back.isDisabled(), true);
    } finally {
      await context.close();
      await browser.close();
      await app.close();
    }
  }, 120_000);

  it('clears the selected source and evidence when repository selection is cleared', async () => {
    const app = await startWorkspaceApp(snapshot);
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    try {
      await page.goto(app.origin, { waitUntil: 'domcontentloaded' });
      const repository = page.getByLabel('Repository and scan');
      await repository.selectOption(repositoryId);
      await page.waitForFunction(
        () =>
          !document.querySelector<HTMLInputElement>('#symbol-query')?.disabled,
      );
      await page.getByLabel('Name or source path').fill('root');
      await page.getByRole('button', { name: /root.*function/ }).click();
      await page.locator('.source-excerpt').waitFor();
      await page.locator('#evidence-inspector .evidence-card').waitFor();

      await repository.selectOption('');
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLInputElement>('#symbol-query')?.disabled,
      );
      assert.equal(
        await page.locator('.source-excerpt').count(),
        0,
        'a source from the previous repository must not remain visible',
      );
      assert.equal(
        await page.locator('#evidence-inspector .evidence-card').count(),
        0,
        'evidence from the previous repository must not remain visible',
      );
      assert.equal(
        await page.getByLabel('Name or source path').inputValue(),
        '',
        'the prior repository search must be cleared',
      );
    } finally {
      await context.close();
      await browser.close();
      await app.close();
    }
  }, 90_000);

  it('clears invalidated loading state and resets project pagination on context switch', async () => {
    const app = await startWorkspaceApp(snapshot);
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const secondProjectId = 'workspace-test-project-2';
    let sessionProjection: Record<string, unknown> | null = null;
    let rootSearchProjection: Record<string, unknown> | null = null;
    let secondProjectOffset: number | null = null;
    let resolveSecondProjectSearch = () => {};
    const secondProjectSearch = new Promise<void>((resolveSearch) => {
      resolveSecondProjectSearch = resolveSearch;
    });
    let markGraphStarted = () => {};
    let releaseGraph = () => {};
    let markGraphFinished = () => {};
    const graphStarted = new Promise<void>((resolveStarted) => {
      markGraphStarted = resolveStarted;
    });
    const graphFinished = new Promise<void>((resolveFinished) => {
      markGraphFinished = resolveFinished;
    });
    const graphGate = new Promise<void>((resolveGate) => {
      releaseGraph = resolveGate;
    });
    let markEvidenceStarted = () => {};
    let releaseEvidence = () => {};
    let markEvidenceFinished = () => {};
    const evidenceStarted = new Promise<void>((resolveStarted) => {
      markEvidenceStarted = resolveStarted;
    });
    const evidenceFinished = new Promise<void>((resolveFinished) => {
      markEvidenceFinished = resolveFinished;
    });
    const evidenceGate = new Promise<void>((resolveGate) => {
      releaseEvidence = resolveGate;
    });
    const gateResolved: string[] = [];
    try {
      await page.route('**/api/workspace/projects', async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as {
          items: Array<Record<string, unknown>>;
        };
        const first = body.items[0];
        assert.ok(first);
        body.items.push({
          ...first,
          id: secondProjectId,
          label: 'Second test context',
        });
        await route.fulfill({ response, body: JSON.stringify(body) });
      });
      await page.route('**/api/workspace/session', async (route) => {
        const request = route.request().postDataJSON() as {
          projectId: string;
        };
        if (request.projectId === secondProjectId) {
          assert.ok(sessionProjection);
          const response = structuredClone(sessionProjection);
          response.projectId = secondProjectId;
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(response),
          });
          return;
        }
        const upstream = await route.fetch();
        sessionProjection = (await upstream.json()) as Record<string, unknown>;
        await route.fulfill({
          response: upstream,
          body: JSON.stringify(sessionProjection),
        });
      });
      await page.route('**/api/workspace/symbols', async (route) => {
        const request = route.request().postDataJSON() as {
          projectId: string;
          request: { offset: number; query: string };
        };
        if (request.projectId === secondProjectId) {
          secondProjectOffset = request.request.offset;
          resolveSecondProjectSearch();
          assert.ok(rootSearchProjection);
          const response = structuredClone(rootSearchProjection);
          response.projectId = secondProjectId;
          const result = response.result as Record<string, unknown>;
          result.offset = request.request.offset;
          result.nextOffset = null;
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(response),
          });
          return;
        }
        const upstream = await route.fetch();
        const body = (await upstream.json()) as Record<string, unknown>;
        if (request.request.query === 'root') {
          rootSearchProjection = structuredClone(body);
          const result = body.result as Record<string, unknown>;
          result.total = 51;
          result.nextOffset = request.request.offset === 0 ? 50 : null;
          await route.fulfill({
            response: upstream,
            body: JSON.stringify(body),
          });
          return;
        }
        await route.fulfill({ response: upstream });
      });
      await page.route('**/api/workspace/neighbors', async (route) => {
        const response = await route.fetch();
        markGraphStarted();
        await graphGate;
        gateResolved.push('graph');
        await route.fulfill({ response });
        markGraphFinished();
      });
      await page.route('**/api/workspace/evidence', async (route) => {
        const response = await route.fetch();
        markEvidenceStarted();
        await evidenceGate;
        gateResolved.push('evidence');
        await route.fulfill({ response });
        markEvidenceFinished();
      });

      await page.goto(app.origin, { waitUntil: 'domcontentloaded' });
      await page.getByLabel('Repository and scan').selectOption(repositoryId);
      await page.waitForFunction(
        () =>
          !document.querySelector<HTMLInputElement>('#symbol-query')?.disabled,
      );
      await page.getByLabel('Name or source path').fill('root');
      const firstPageNext = page
        .locator('.explorer-section .pager')
        .first()
        .getByRole('button', { name: 'Next' });
      await firstPageNext.click();
      await page.getByRole('button', { name: /root.*function/ }).waitFor();
      await page.getByRole('button', { name: /root.*function/ }).click();
      await Promise.all([graphStarted, evidenceStarted]);

      await page.getByLabel('Project context').selectOption(secondProjectId);
      await secondProjectSearch;
      await page.getByText('Choose a source-backed symbol to begin.').waitFor();
      releaseGraph();
      releaseEvidence();
      await Promise.all([graphFinished, evidenceFinished]);
      await page.evaluate(
        () =>
          new Promise<void>((resolveFrame) =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() => resolveFrame()),
            ),
          ),
      );

      const loadingState = await page
        .locator('#evidence-inspector')
        .getByText(/Loading verified evidence/)
        .count();
      assert.deepEqual(
        {
          projectOffset: secondProjectOffset,
          loadingState,
          released: gateResolved.sort(),
        },
        { projectOffset: 0, loadingState: 0, released: ['evidence', 'graph'] },
        'changing projects must reset project-local paging and finish obsolete loading indicators',
      );
    } finally {
      releaseGraph();
      releaseEvidence();
      await context.close();
      await browser.close();
      await app.close();
    }
  }, 120_000);

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
