import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { analyzeManifest, COMPILER_PROFILE } from '@codethread/symbol-indexer';
import { startWorkspaceApp } from './browser/workspace-app.ts';

const repositoryId = '62222222-2222-4222-8222-222222222222';
const source = Buffer.from(
  [
    'export function leafTarget(value: string) {',
    '  return value.trim();',
    '}',
    '',
    'export function stepTwo(value: string) {',
    '  return leafTarget(value);',
    '}',
    '',
    'export function stepOne(value: string) {',
    '  return stepTwo(value);',
    '}',
    '',
    'export function entry(value: string) {',
    '  return stepOne(value);',
    '}',
    '',
    'export function isolatedFn() {',
    '  return 42;',
    '}',
    '',
  ].join('\n'),
);

const snapshot = await analyzeManifest({
  repositoryId,
  compilerOptions: COMPILER_PROFILE,
  files: [
    {
      path: 'src/chain.ts',
      bytes: source,
      sha256: createHash('sha256').update(source).digest('hex'),
    },
  ],
});

describe('Investigation Workspace symbol-to-symbol path finder', () => {
  it('finds 3-hop exact chains, inspects hop evidence outside the 2-hop neighbor graph, reports bounded truncation, and follows targets', async () => {
    const app = await startWorkspaceApp(snapshot);
    const browser = await chromium.launch({ headless: true });
    const page = await (
      await browser.newContext({ viewport: { width: 1440, height: 900 } })
    ).newPage();
    page.setDefaultTimeout(15_000);
    const pathRequests: string[] = [];
    page.on('request', (req) => {
      if (new URL(req.url()).pathname === '/api/workspace/paths')
        pathRequests.push(req.method());
    });

    try {
      await page.goto(app.origin, { waitUntil: 'domcontentloaded' });
      await page.getByLabel('Repository and scan').selectOption(repositoryId);
      await page.waitForFunction(
        () =>
          !document.querySelector<HTMLInputElement>('#symbol-query')?.disabled,
      );
      await page.getByLabel('Name or source path').fill('entry');
      await page.getByRole('button', { name: /entry.*function/ }).click();
      await page.locator('#evidence-inspector .evidence-card').waitFor();

      await page.getByRole('tab', { name: 'Trace' }).click();
      const pathFinder = page.locator('#symbol-paths');
      await pathFinder.waitFor();
      assert.equal(
        pathRequests.length,
        0,
        'opening Trace must never auto-fire a path query',
      );

      // Filter for leafTarget (3 hops away, outside the 2-hop neighbor graph).
      await pathFinder.getByLabel('Filter target symbol').fill('leafTarget');
      await page.waitForFunction(() => {
        const select = document.querySelector<HTMLSelectElement>(
          '#path-target-select',
        );
        return Boolean(
          select &&
          !select.disabled &&
          select.selectedOptions[0]?.textContent?.includes('leafTarget'),
        );
      });

      // With Max hops = 2, the 3-hop chain is truncated by depth_limit and must report bounded negative truth.
      await pathFinder.getByLabel('Max hops').selectOption('2');
      await pathFinder.locator('#find-symbol-paths').click();
      await pathFinder
        .getByText(/No exact path was found within the applied search bounds/)
        .waitFor();
      await pathFinder.getByText(/Truncated: depth_limit/).waitFor();

      // Switching Max hops to 3 clears the stale 2-hop result and finds the exact 3-hop chain.
      await pathFinder.getByLabel('Max hops').selectOption('3');
      expect(await pathFinder.locator('.path-results').count()).toBe(0);
      await pathFinder.locator('#find-symbol-paths').click();
      await pathFinder.getByText('Paths: 1').waitFor();
      await pathFinder.getByText('Search not truncated').waitFor();
      await pathFinder
        .getByText('entry → stepOne → stepTwo → leafTarget')
        .waitFor();

      // Inspect hop 3 (stepTwo -> leafTarget), whose siteEvidenceId is NOT in the 2-hop neighbor graph!
      const thirdHop = pathFinder
        .locator('.path-hop-list > li')
        .filter({ hasText: 'stepTwo → leafTarget' });
      await thirdHop
        .getByRole('button', { name: 'Inspect hop evidence' })
        .click();
      await page.waitForFunction(() => {
        const text =
          document.querySelector('#evidence-inspector .evidence-text')
            ?.textContent ?? '';
        return text.includes('leafTarget(value)');
      });
      expect(
        await page
          .locator('.explorer [role="alert"]')
          .getByText(/Evidence selection is not present/)
          .count(),
      ).toBe(0);

      // Verify 390px narrow layout has zero horizontal overflow with path results visible.
      await page.setViewportSize({ width: 390, height: 844 });
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth + 1,
      );
      expect(overflow).toBe(false);

      // Follow leafTarget directly from the path hop and verify root switches cleanly.
      await page.setViewportSize({ width: 1440, height: 900 });
      await thirdHop.getByRole('button', { name: 'Follow leafTarget' }).click();
      await page
        .locator('.selected-symbol')
        .getByText('function leafTarget')
        .waitFor();
    } finally {
      await browser.close();
      await app.close();
    }
  }, 60_000);

  it('discards delayed path responses after switching root symbol and recovers via Retry path search', async () => {
    const app = await startWorkspaceApp(snapshot);
    const browser = await chromium.launch({ headless: true });
    const page = await (await browser.newContext()).newPage();
    page.setDefaultTimeout(15_000);

    let markStarted = () => {};
    let releaseStale = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const staleGate = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    let holdNext = true;
    let failNext = false;

    try {
      await page.route('**/api/workspace/paths', async (route) => {
        if (holdNext) {
          holdNext = false;
          markStarted();
          await staleGate;
          await route.continue();
          return;
        }
        if (failNext) {
          failNext = false;
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({
              error: {
                code: 'BACKEND_UNAVAILABLE',
                message: 'Transient path query failure.',
              },
            }),
          });
          return;
        }
        await route.continue();
      });

      await page.goto(app.origin, { waitUntil: 'domcontentloaded' });
      await page.getByLabel('Repository and scan').selectOption(repositoryId);
      await page.waitForFunction(
        () =>
          !document.querySelector<HTMLInputElement>('#symbol-query')?.disabled,
      );
      await page.getByLabel('Name or source path').fill('entry');
      await page.getByRole('button', { name: /entry.*function/ }).click();
      await page.getByRole('tab', { name: 'Trace' }).click();

      const pathFinder = page.locator('#symbol-paths');
      await pathFinder.getByLabel('Filter target symbol').fill('leafTarget');
      await page.waitForFunction(() => {
        const select = document.querySelector<HTMLSelectElement>(
          '#path-target-select',
        );
        return Boolean(
          select?.selectedOptions[0]?.textContent?.includes('leafTarget'),
        );
      });
      await pathFinder.locator('#find-symbol-paths').click();
      await started;

      // Switch root symbol to isolatedFn while the entry->leafTarget path query is in flight.
      await page.getByLabel('Name or source path').fill('isolatedFn');
      await page.getByRole('button', { name: /isolatedFn.*function/ }).click();
      await page.getByRole('tab', { name: 'Trace' }).click();
      releaseStale();
      await page.waitForTimeout(250);
      expect(
        await pathFinder
          .getByText('entry → stepOne → stepTwo → leafTarget')
          .count(),
      ).toBe(0);

      // Query isolatedFn -> entry with one injected 503 error, then retry cleanly.
      await pathFinder.getByLabel('Filter target symbol').fill('entry');
      await page.waitForFunction(() => {
        const select = document.querySelector<HTMLSelectElement>(
          '#path-target-select',
        );
        return Boolean(
          select?.selectedOptions[0]?.textContent?.includes('entry'),
        );
      });
      failNext = true;
      await pathFinder.locator('#find-symbol-paths').click();
      await pathFinder.getByText(/BACKEND_UNAVAILABLE/).waitFor();
      await pathFinder
        .getByRole('button', { name: 'Retry path search' })
        .click();
      await pathFinder
        .getByText(/No exact static path connects these declarations/)
        .waitFor();
    } finally {
      releaseStale();
      await browser.close();
      await app.close();
    }
  }, 60_000);
});
