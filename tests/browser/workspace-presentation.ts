import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import type { AnalysisSnapshot } from '@codethread/symbol-indexer';
import { startWorkspaceApp } from './workspace-app.ts';

type OpenPage = { context: BrowserContext; page: Page; outside: string[] };

async function openWorkspacePage(
  browser: Browser,
  origin: string,
): Promise<OpenPage> {
  const context = await browser.newContext({
    viewport: { width: 1100, height: 900 },
  });
  const outside: string[] = [];
  const expected = new URL(origin);
  await context.route('**/*', async (route) => {
    const actual = new URL(route.request().url());
    if (actual.host !== expected.host) {
      outside.push(route.request().url());
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page
    .getByRole('heading', { name: 'Investigation Workspace' })
    .waitFor();
  await page.getByLabel('Repository and scan').waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLOptionElement>(
        '#repository-select option[value]',
      )?.value === '',
  );
  return { context, page, outside };
}

async function chooseRepository(
  page: Page,
  repositoryId: string,
): Promise<void> {
  await page.getByLabel('Repository and scan').selectOption(repositoryId);
  await page.waitForFunction(() =>
    !document.querySelector<HTMLInputElement>('#symbol-query')?.disabled &&
    document.querySelector<HTMLSelectElement>('#project-select')?.options.length
      ? document.querySelector<HTMLSelectElement>('#project-select')!.options
          .length > 1
      : false,
  );
}

async function chooseTodoRouter(page: Page): Promise<void> {
  await page.getByLabel('Name or source path').fill('todoRouter');
  try {
    await page.getByRole('button', { name: /todoRouter.*function/ }).click();
    await page
      .getByText('Verified declaration excerpt', { exact: true })
      .waitFor();
  } catch (error) {
    throw new Error(
      `Could not select todoRouter from the workspace API: ${await page.locator('body').innerText()}`,
      { cause: error },
    );
  }
}

function assertLocalOnly(page: Page, outside: string[], origin: string): void {
  assert.deepEqual(
    outside,
    [],
    'workspace browser must not request external origins',
  );
  const expectedHost = new URL(origin).host;
  assert.equal(new URL(page.url()).host, expectedHost);
}

async function assertNoHorizontalOverflow(page: Page, width: number) {
  const result = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
    clipped: [
      ...document.querySelectorAll<HTMLElement>('.region, .page-header'),
    ]
      .filter((element) => element.scrollWidth > element.clientWidth + 1)
      .map((element) => element.className),
  }));
  assert.ok(
    result.documentWidth <= result.viewportWidth,
    `${width}px viewport overflows: ${JSON.stringify(result)}`,
  );
  assert.deepEqual(
    result.clipped,
    [],
    `${width}px content clips within a region`,
  );
}

async function layoutAt(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  return page.evaluate(() => {
    const grid = document.querySelector('.workspace-grid');
    if (!grid) throw new Error('Investigation workspace grid is missing.');
    return {
      columns: getComputedStyle(grid).gridTemplateColumns,
      gap: getComputedStyle(grid).columnGap,
      hasHorizontalOverflow:
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    };
  });
}

async function waitForCompactInspector(page: Page, compact: boolean) {
  await page.waitForFunction(
    (isCompact) =>
      document.getElementById('evidence-inspector')?.hidden === isCompact &&
      document.getElementById('inspector-toggle')?.hidden === !isCompact,
    compact,
  );
}

async function captureStates(
  browser: Browser,
  origin: string,
  repositoryId: string,
  directory: string,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  const { context, page } = await openWorkspacePage(browser, origin);
  const widths = [1440, 1280, 768] as const;
  const themes = ['light', 'dark'] as const;
  const states = [
    'empty',
    'loading',
    'partial',
    'error',
    'selected-evidence',
  ] as const;
  try {
    for (const width of widths)
      for (const theme of themes)
        for (const state of states) {
          let releaseLoading = async () => {};
          try {
            await page.setViewportSize({ width, height: 900 });
            await page.emulateMedia({ colorScheme: theme });
            await waitForCompactInspector(page, width <= 900);
            if (state !== 'empty') {
              if (
                (await page.getByLabel('Repository and scan').inputValue()) !==
                repositoryId
              )
                await chooseRepository(page, repositoryId);
              else
                await page.waitForFunction(
                  () =>
                    !document.querySelector<HTMLInputElement>('#symbol-query')
                      ?.disabled,
                );
            } else if (
              await page.getByLabel('Repository and scan').inputValue()
            ) {
              await page.getByLabel('Repository and scan').selectOption('');
            }
            if (state === 'loading') {
              let markStarted = () => {};
              const started = new Promise<void>((resolveStarted) => {
                markStarted = resolveStarted;
              });
              let resolveGate = () => {};
              const gate = new Promise<void>((resolveResponse) => {
                resolveGate = resolveResponse;
              });
              const completedResponse = page.waitForResponse(
                (response) =>
                  new URL(response.url()).pathname ===
                    '/api/workspace/symbols' &&
                  response.request().postDataJSON()?.request?.query ===
                    'todoRouter',
              );
              releaseLoading = async () => {
                resolveGate();
                await completedResponse;
              };
              await page.route('**/api/workspace/symbols', async (route) => {
                const body = route.request().postDataJSON() as {
                  request?: { query?: string };
                };
                if (body.request?.query !== 'todoRouter') {
                  await route.continue();
                  return;
                }
                markStarted();
                await gate;
                await route.continue();
              });
              await page.getByLabel('Name or source path').fill('todoRouter');
              await started;
              await page.getByText('Searching the pinned snapshot…').waitFor();
            } else if (state === 'error') {
              await page.route('**/api/workspace/evidence', (route) =>
                route.fulfill({
                  status: 503,
                  contentType: 'application/json',
                  body: JSON.stringify({
                    error: {
                      code: 'VISUAL_TEST_ERROR',
                      message: 'Evidence service unavailable.',
                    },
                  }),
                }),
              );
              await page.getByLabel('Name or source path').fill('todoRouter');
              await page
                .getByRole('button', { name: /todoRouter.*function/ })
                .click();
              await page
                .locator('#source-panel [role="alert"]')
                .getByText(/VISUAL_TEST_ERROR/)
                .waitFor();
            } else if (state === 'partial' || state === 'selected-evidence') {
              await chooseTodoRouter(page);
              if (state === 'partial') {
                await page.getByRole('tab', { name: 'Trace' }).click();
                await page.getByText(/Coverage:/).waitFor();
              } else {
                await page
                  .getByRole('button', { name: 'Inspect evidence' })
                  .click();
                await page
                  .locator('#evidence-inspector .evidence-card')
                  .waitFor({ state: 'attached' });
              }
            }
            if (state === 'empty') {
              assert.equal(
                await page.locator('.source-excerpt').count(),
                0,
                'empty captures must not retain source from a prior repository',
              );
              assert.equal(
                await page
                  .locator('#evidence-inspector .evidence-card')
                  .count(),
                0,
                'empty captures must not retain evidence from a prior repository',
              );
            }
            if (width <= 900 && state === 'selected-evidence') {
              await page
                .getByRole('button', { name: 'Evidence', exact: true })
                .click();
              await page
                .locator('#evidence-inspector')
                .waitFor({ state: 'visible' });
            }
            await assertNoHorizontalOverflow(page, width);
            await page.screenshot({
              path: join(directory, `${width}-${theme}-${state}.png`),
              fullPage: true,
              animations: 'disabled',
            });
          } finally {
            await releaseLoading();
            if (state === 'error')
              await page.unroute('**/api/workspace/evidence');
            if (state === 'loading')
              await page.unroute('**/api/workspace/symbols');
            if (state !== 'empty') {
              const toggle = page.getByRole('button', {
                name: 'Evidence',
                exact: true,
              });
              if (
                (await toggle.isVisible()) &&
                (await toggle.getAttribute('aria-expanded')) === 'true'
              )
                await page.locator('#close-inspector').click();
              await page.getByLabel('Repository and scan').selectOption('');
              await page.waitForFunction(
                () =>
                  document.querySelector<HTMLInputElement>('#symbol-query')
                    ?.disabled,
              );
            }
          }
        }
    await page.setViewportSize({ width: 720, height: 900 });
    await page.emulateMedia({ colorScheme: 'light' });
    await chooseRepository(page, repositoryId);
    await chooseTodoRouter(page);
    await page.getByRole('button', { name: 'Evidence', exact: true }).click();
    await assertNoHorizontalOverflow(page, 720);
    await page.screenshot({
      path: join(directory, '200-percent-reflow-selected-evidence.png'),
      fullPage: true,
      animations: 'disabled',
    });
  } finally {
    await context.close();
  }
}

export async function verifyWorkspacePresentation(
  browser: Browser,
  snapshot: AnalysisSnapshot,
): Promise<void> {
  const app = await startWorkspaceApp(snapshot);
  try {
    const { context, page, outside } = await openWorkspacePage(
      browser,
      app.origin,
    );
    try {
      await page.keyboard.press('Tab');
      assert.equal(
        await page.evaluate(
          () => (document.activeElement as HTMLElement | null)?.id,
        ),
        'repository-select',
        'keyboard focus reaches the repository selector first',
      );
      const browserAuthHeaders: string[] = [];
      const requestUrls: string[] = [];
      page.on('request', (request) => {
        requestUrls.push(request.url());
        const authorization = request.headers().authorization;
        if (authorization) browserAuthHeaders.push(authorization);
      });
      await chooseRepository(page, snapshot.facts.identity.repositoryId);
      await chooseTodoRouter(page);
      const source = await page.locator('.source-excerpt').innerText();
      assert.match(source, /SHA-256 [a-f0-9]{64}/i);
      assert.match(
        source,
        new RegExp(`snapshot ${snapshot.facts.snapshotId}`, 'i'),
      );
      await page.getByRole('tab', { name: 'Trace' }).click();
      await page.getByText('Evidence basis: static', { exact: true }).waitFor();
      const summary = await page.locator('.coverage-summary').innerText();
      assert.match(summary, /Coverage:/);
      assert.match(summary, /Query not truncated|Truncated:/);
      assert.equal(
        (await page.locator('.relationship-list').count()) > 0,
        true,
      );
      await page.getByRole('tab', { name: 'Source' }).click();
      await page.getByRole('button', { name: 'Inspect evidence' }).click();
      await page
        .locator('#evidence-inspector')
        .getByText(/SHA-256/)
        .waitFor();
      assert.match(
        await page.locator('#evidence-inspector').innerText(),
        /SHA-256/,
      );
      assert.deepEqual(
        browserAuthHeaders,
        [],
        'upstream credentials stay server-side',
      );
      assert.equal(
        requestUrls.some((url) =>
          url.includes('workspace-browser-backend-token'),
        ),
        false,
      );
      assertLocalOnly(page, outside, app.origin);

      for (const width of [1440, 1280]) {
        const layout = await layoutAt(page, width);
        assert.equal(layout.gap, '16px');
        assert.equal(layout.columns.trim().split(/\s+/).length, 3);
        assert.equal(layout.hasHorizontalOverflow, false);
        await waitForCompactInspector(page, false);
      }
      for (const [theme, canvas] of [
        ['light', '#f4f3ef'],
        ['dark', '#151a1a'],
      ] as const) {
        await page.emulateMedia({ colorScheme: theme });
        assert.equal(
          await page.evaluate(() =>
            getComputedStyle(document.documentElement)
              .getPropertyValue('--ct-canvas')
              .trim(),
          ),
          canvas,
        );
      }
      const tablet = await layoutAt(page, 768);
      assert.equal(tablet.columns.trim().split(/\s+/).length, 2);
      assert.equal(tablet.hasHorizontalOverflow, false);
      await waitForCompactInspector(page, true);
      const toggle = page.getByRole('button', {
        name: 'Evidence',
        exact: true,
      });
      await toggle.click();
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      assert.equal(
        await page.locator('#evidence-inspector').getAttribute('aria-hidden'),
        'false',
      );
      assert.equal(
        await page.evaluate(() => document.activeElement?.id),
        'close-inspector',
      );
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#evidence-inspector').isHidden(), true);
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      assert.equal(
        await page.evaluate(() => document.activeElement?.id),
        'inspector-toggle',
      );

      for (const width of [720, 640, 384]) {
        await layoutAt(page, width);
        await assertNoHorizontalOverflow(page, width);
      }
      await layoutAt(page, 720); // 720 CSS px approximates 200% at a 1440px display.
      await assertNoHorizontalOverflow(page, 720);
    } finally {
      await context.close();
    }

    await captureStates(
      browser,
      app.origin,
      snapshot.facts.identity.repositoryId,
      resolve('artifacts/ct-workspace-001b/next-app'),
    );
  } finally {
    await app.close();
  }

  const raceApp = await startWorkspaceApp(snapshot, { holdScanRead: true });
  try {
    const { context, page } = await openWorkspacePage(browser, raceApp.origin);
    try {
      await page
        .getByLabel('Repository and scan')
        .selectOption(snapshot.facts.identity.repositoryId);
      await raceApp.scanReadStarted;
      await page
        .getByLabel('Repository and scan')
        .selectOption('44444444-4444-4444-8444-444444444444');
      await page.getByText(/This repository has no active scan/).waitFor();
      const delayedOpen = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/workspace/open',
      );
      raceApp.releaseScanRead();
      await delayedOpen;
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
        'a delayed open from the previous repository must not replace the no-scan context',
      );
      assert.equal(
        await page.getByText(/This repository has no active scan/).count(),
        1,
        'the later repository state must remain visible after the stale response',
      );
    } finally {
      raceApp.releaseScanRead();
      await context.close();
    }
  } finally {
    await raceApp.close();
  }
}
