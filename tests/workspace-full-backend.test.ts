import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { analyzeManifest, COMPILER_PROFILE } from '@codethread/symbol-indexer';
import { startWorkspaceApp } from './browser/workspace-app.ts';

const repositoryId = '72222222-2222-4222-8222-222222222222';
const source = Buffer.from(
  [
    'export class Widget {',
    '  run() {',
    '    return 1;',
    '  }',
    '}',
    '',
    'export function buildWidget() {',
    '  return new Widget();',
    '}',
    '',
    'export function stepTwo() {',
    '  return buildWidget();',
    '}',
    '',
    'export function stepOne() {',
    '  return stepTwo();',
    '}',
    '',
    'export function entry() {',
    '  return stepOne();',
    '}',
    '',
  ].join('\n'),
);

const snapshot = await analyzeManifest({
  repositoryId,
  compilerOptions: COMPILER_PROFILE,
  files: [
    {
      path: 'src/pipeline.ts',
      bytes: source,
      sha256: createHash('sha256').update(source).digest('hex'),
    },
  ],
});

describe('Investigation Workspace full backend integration', () => {
  it('surfaces live system health, snapshot metrics, committed file modes, repository registration, and scan queue/cancel/completion', async () => {
    const app = await startWorkspaceApp(snapshot, { holdQueuedScans: true });
    const browser = await chromium.launch({ headless: true });
    const page = await (
      await browser.newContext({ viewport: { width: 1440, height: 900 } })
    ).newPage();
    page.setDefaultTimeout(15_000);

    try {
      await page.goto(app.origin, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(
        () => document.querySelectorAll('#repository-select option').length > 1,
      );
      const statusBar = page.locator('.scope-bar');
      await statusBar.getByText('API: ready').waitFor();
      await statusBar.getByText('DB: ready').waitFor();
      await statusBar.getByText('Worker: ready').waitFor();
      await statusBar.getByText('AI: disabled').waitFor();

      // Register a new repository via POST /api/repositories and verify host locator confinement.
      await page.getByText('Register local repository').click();
      await page
        .getByLabel('Path beneath allowed root')
        .fill('C:/secret-host-dir/fresh-local-repo');
      await page.locator('#register-repo-submit').click();
      await page
        .getByText(/Repository registered\. Run a scan to publish/)
        .waitFor();
      expect(await page.content()).not.toContain('C:/secret-host-dir');

      // Queue a held scan and cancel it via POST /api/scans/:id/cancel.
      await page.locator('#scan-revision-input').fill('feature-branch');
      await page.locator('#start-scan-button').click();
      const tracked = page.locator('#tracked-scan-panel');
      await tracked.getByText(/— queued/).waitFor();
      await page.locator('#cancel-scan-button').click();
      await tracked.getByText(/— cancelled/).waitFor();

      // Release hold so the next scan succeeds and automatically opens its snapshot!
      app.setHoldQueuedScans(false);
      await page.locator('#start-scan-button').click();
      await page.waitForFunction(
        () =>
          !document.querySelector<HTMLInputElement>('#symbol-query')?.disabled,
      );

      // Snapshot metrics strip & committed Git file mode (`100644`) are visible.
      const metrics = page.locator('.snapshot-metrics');
      await metrics.getByText(/Declarations:/).waitFor();
      await metrics.getByText(/Call sites:/).waitFor();
      await page
        .getByRole('region', { name: 'Source inventory' })
        .getByText(/mode 100644/)
        .waitFor();
    } finally {
      await browser.close();
      await app.close();
    }
  }, 60_000);

  it('queries deep 4-hop backend neighbor projections, filters returned edges, and follows interactive SVG graph nodes', async () => {
    const app = await startWorkspaceApp(snapshot);
    const browser = await chromium.launch({ headless: true });
    const page = await (
      await browser.newContext({ viewport: { width: 1440, height: 900 } })
    ).newPage();
    page.setDefaultTimeout(15_000);
    const deepRequests: number[] = [];
    page.on('request', (req) => {
      if (new URL(req.url()).pathname === '/api/workspace/neighbors-deep')
        deepRequests.push(1);
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
      await page.getByRole('tab', { name: 'Trace' }).click();

      // Default 2-hop viewer graph contains entry -> stepOne -> stepTwo, NOT buildWidget.
      await page.getByText('stepOne → stepTwo').waitFor();
      expect(await page.getByText('stepTwo → buildWidget').count()).toBe(0);
      expect(deepRequests.length).toBe(0);

      // Increase Depth to 4 hops and Limit to 100 nodes -> routes through /api/workspace/neighbors-deep!
      await page.getByLabel('Depth').selectOption('4');
      await page.getByLabel('Limit').selectOption('100');
      await page.getByText('stepTwo → buildWidget').waitFor();
      assert.ok(deepRequests.length >= 1);

      // Enable CONSTRUCTS as well and open interactive SVG diagram to click a node directly.
      await page.getByLabel('CONSTRUCTS').check();
      await page
        .getByText('Show exact relationship diagram', { exact: true })
        .click();
      const targetNode = page
        .locator('#trace-panel .trace-node')
        .filter({ hasText: 'buildWidget' })
        .first();
      await targetNode.waitFor();
      await targetNode.click();
      await page
        .locator('.selected-symbol')
        .getByText('function buildWidget')
        .waitFor();
    } finally {
      await browser.close();
      await app.close();
    }
  }, 60_000);
});
