import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { analyzeManifest, COMPILER_PROFILE } from '@codethread/symbol-indexer';
import { startWorkspaceApp } from './browser/workspace-app.ts';

const repositoryId = '83333333-3333-4333-8333-333333333333';
const source = Buffer.from(
  [
    'declare const sink: { log(value: number): void };',
    '',
    'export function leaf(value: number) {',
    '  return value + 1;',
    '}',
    '',
    'export function recurse(depth: number): number {',
    '  if (depth <= 0) return leaf(depth);',
    '  return recurse(depth - 1);',
    '}',
    '',
    'export function register(handler: (value: number) => number) {',
    '  return handler(1);',
    '}',
    '',
    'export function entry(depth: number) {',
    '  const result = recurse(depth);',
    '  register(leaf);',
    '  sink.log(result);',
    '  return result;',
    '}',
    '',
  ].join('\n'),
);

const snapshot = await analyzeManifest({
  repositoryId,
  compilerOptions: COMPILER_PROFILE,
  files: [
    {
      path: 'src/recursive-trace.ts',
      bytes: source,
      sha256: createHash('sha256').update(source).digest('hex'),
    },
  ],
});

describe('Investigation Workspace UX workflows and accessibility regressions', () => {
  it('preserves declaration evidence on filter changes, navigates interactive recursive graph nodes by keyboard, and tracks history position', async () => {
    const app = await startWorkspaceApp(snapshot);
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);

    try {
      await page.goto(app.origin, { waitUntil: 'domcontentloaded' });
      await page.getByLabel('Repository and scan').selectOption(repositoryId);
      await page.waitForFunction(
        () =>
          !document.querySelector<HTMLInputElement>('#symbol-query')?.disabled,
      );

      // Select entry and confirm active Explorer selection, anchored line numbers, and Declaration role.
      await page.getByLabel('Name or source path').fill('entry');
      const entryButton = page.getByRole('button', { name: /entry.*function/ });
      await entryButton.click();
      await page.locator('.source-excerpt .code-line').first().waitFor();
      expect(await entryButton.getAttribute('aria-current')).toBe('true');

      const firstLineNumber = await page
        .locator('.source-excerpt .code-gutter')
        .first()
        .innerText();
      expect(firstLineNumber.trim()).toBe('16');
      expect(
        await page
          .locator('.source-excerpt .code-gutter')
          .first()
          .getAttribute('aria-hidden'),
      ).toBe('true');

      const inspector = page.locator('#evidence-inspector');
      await inspector.getByText('Declaration evidence').waitFor();

      // Switch to Trace, toggle REFERENCES + Direction, and verify declaration evidence stays visible.
      await page.getByRole('tab', { name: 'Trace' }).click();
      await page.getByText('entry → recurse').waitFor();
      const referencesBox = page.getByLabel('REFERENCES');
      await referencesBox.check();
      await page.getByLabel('Direction').selectOption('outgoing');
      await page.getByText('entry → recurse').waitFor();
      expect(await inspector.locator('.evidence-card').count()).toBe(1);
      await inspector.getByText('Declaration evidence').waitFor();

      // Inspect occurrence evidence and verify provenance role updates to Occurrence evidence.
      const recurseRow = page
        .locator('#trace-panel .relationship-list > li')
        .filter({ hasText: 'entry → recurse' })
        .first();
      await recurseRow
        .getByRole('button', { name: 'Inspect occurrence evidence' })
        .click();
      await inspector.getByText('Occurrence evidence').waitFor();

      // Open interactive SVG diagram, verify root styling and keyboard-follow recurse node.
      await page
        .getByText('Show exact relationship diagram', { exact: true })
        .click();
      await page.locator('.trace-node.trace-node-root').waitFor();
      const recurseNode = page.locator(
        '.trace-node.trace-node-interactive[aria-label="Follow recurse"]',
      );
      await recurseNode.waitFor();
      await recurseNode.focus();
      await page.keyboard.press('Enter');

      await page
        .locator('.selected-symbol')
        .getByText('function recurse')
        .waitFor();
      await page.waitForFunction(
        () => document.activeElement?.id === 'workspace-heading',
      );

      // Verify recursive self-call and follow leaf via keyboard Enter on Follow button.
      await page.getByRole('tab', { name: 'Trace' }).click();
      await page.getByText('recurse → recurse').waitFor();
      const followLeaf = page.getByRole('button', {
        name: 'Follow leaf',
        exact: true,
      });
      await followLeaf.focus();
      await page.keyboard.press('Enter');
      await page
        .locator('.selected-symbol')
        .getByText('function leaf')
        .waitFor();
      await page.waitForFunction(
        () => document.activeElement?.id === 'workspace-heading',
      );

      // Verify history position counter and Back/Forward continuity.
      const historyNav = page.getByRole('navigation', {
        name: 'Investigation history',
      });
      const position = historyNav.locator('.history-position');
      await position.waitFor();
      const atLeaf = (await position.innerText()).trim();
      assert.match(atLeaf, /^\d+\/\d+$/);

      await historyNav
        .getByRole('button', { name: 'Back', exact: true })
        .click();
      await page
        .locator('.selected-symbol')
        .getByText('function recurse')
        .waitFor();
      const atRecurse = (await position.innerText()).trim();
      expect(atRecurse).not.toBe(atLeaf);

      await historyNav
        .getByRole('button', { name: 'Forward', exact: true })
        .click();
      await page
        .locator('.selected-symbol')
        .getByText('function leaf')
        .waitFor();
      expect((await position.innerText()).trim()).toBe(atLeaf);
    } finally {
      await context.close();
      await browser.close();
      await app.close();
    }
  }, 90_000);

  it('handles empty search + Clear focus restoration, evidence error retry recovery, and repeated compact drawer Escape focus', async () => {
    const app = await startWorkspaceApp(snapshot);
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    let failEvidenceOnce = true;

    try {
      await page.route('**/api/workspace/evidence', async (route) => {
        if (failEvidenceOnce) {
          failEvidenceOnce = false;
          await route.fulfill({
            status: 503,
            json: {
              error: {
                code: 'TRANSIENT_EVIDENCE_OUTAGE',
                message: 'Temporary evidence service interruption.',
              },
            },
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

      // Empty search state + Clear button restoring focus to #symbol-query.
      const queryInput = page.getByLabel('Name or source path');
      await queryInput.fill('doesNotExistInSnapshot');
      await page.getByText('No symbols on this page match.').waitFor();
      const clearButton = page.getByRole('button', {
        name: 'Clear symbol search',
      });
      await clearButton.click();
      expect(await queryInput.inputValue()).toBe('');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe(
        'symbol-query',
      );
      await page.getByRole('button', { name: /leaf.*function/ }).waitFor();

      // Trigger transient evidence failure and recover cleanly via Retry evidence.
      await page.getByRole('button', { name: /leaf.*function/ }).click();
      const sourceAlert = page.locator('#source-panel [role="alert"]');
      await sourceAlert.getByText(/TRANSIENT_EVIDENCE_OUTAGE/).waitFor();
      await sourceAlert.getByRole('button', { name: 'Retry evidence' }).click();
      await page
        .locator('.source-excerpt pre')
        .getByText('return value + 1;')
        .waitFor();
      await page
        .locator('#evidence-inspector .evidence-card pre')
        .getByText('return value + 1;')
        .waitFor();

      // Repeated compact-viewport drawer open + Escape focus restoration.
      await page.setViewportSize({ width: 768, height: 900 });
      await page.waitForFunction(
        () =>
          document.getElementById('inspector-toggle')?.hidden === false &&
          document.getElementById('evidence-inspector')?.hidden === true,
      );
      const toggle = page.locator('#inspector-toggle');
      for (let cycle = 0; cycle < 3; cycle++) {
        await toggle.click();
        expect(await page.evaluate(() => document.activeElement?.id)).toBe(
          'close-inspector',
        );
        await page.keyboard.press('Escape');
        expect(await page.locator('#evidence-inspector').isHidden()).toBe(true);
        expect(await page.evaluate(() => document.activeElement?.id)).toBe(
          'inspector-toggle',
        );
      }
    } finally {
      await context.close();
      await browser.close();
      await app.close();
    }
  }, 90_000);
});
