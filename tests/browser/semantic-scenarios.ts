import assert from 'node:assert/strict';
import type { Browser } from 'playwright';
import type { AnalysisSnapshot } from '@codethread/symbol-indexer';
import { openPage, assertLocalOnly, selectByName } from './helpers.ts';
import { createViewer } from '../../scripts/viewer.ts';

export async function verifyTodo(
  browser: Browser,
  snapshot: AnalysisSnapshot,
): Promise<void> {
  const viewer = await createViewer(snapshot);
  try {
    const page = await openPage(browser, viewer.origin, viewer.url);
    assert.match(
      await page.locator('#snapshot-summary').innerText(),
      /\b2 source files\b/,
      'the F2 visual condition must use its exact two-file task input',
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await selectByName(page, 'todoRouter', 'function');

    await page.getByRole('checkbox', { name: 'REFERENCES' }).check();
    await page.getByRole('checkbox', { name: 'CALLS' }).uncheck();
    const referenceRows = page
      .locator('#relationships .relationship-item')
      .filter({
        hasText: 'REFERENCES exact',
      });
    await page.waitForFunction(
      () =>
        [
          ...document.querySelectorAll('#relationships .relationship-item'),
        ].filter((row) => row.textContent?.includes('REFERENCES exact'))
          .length === 3,
    );
    assert.equal(await referenceRows.count(), 3);
    assert.equal(
      await page
        .locator('#relationships .relationship-item')
        .filter({ hasText: 'CALLS exact' })
        .count(),
      0,
      'the REFERENCES filter must not relabel call occurrences',
    );
    const getAllRow = referenceRows.filter({ hasText: 'getAll' }).first();
    const getAllEdge = page.getByRole('button', {
      name: /REFERENCES occurrence at routes\/todo\.router\.ts:\d+:\d+, from todoRouter to getAll/,
    });
    assert.equal(await getAllEdge.count(), 1);
    const getAllRelationId = await getAllEdge.getAttribute('data-relation-id');
    assert.ok(getAllRelationId);
    await getAllEdge.click();
    await page.getByText(/toDoCtrl\.getAll/).waitFor();
    assert.equal(
      await page
        .locator(`#relationships li[data-relation-id="${getAllRelationId}"]`)
        .evaluate((row) => row.classList.contains('selected')),
      true,
      'selecting an SVG REFERENCES edge highlights the matching occurrence row',
    );
    const referenceExcerpt = await page.locator('#evidence pre').textContent();
    assert.ok(referenceExcerpt);
    assert.match(referenceExcerpt, /toDoCtrl\.getAll/);
    await getAllRow.getByRole('button', { name: 'Follow getAll' }).click();
    await page.getByRole('heading', { name: 'method getAll' }).waitFor();
    await page.getByRole('button', { name: 'Back' }).click();
    await page.getByRole('heading', { name: 'function todoRouter' }).waitFor();
    const uncertainText =
      (await page.locator('#relationships').innerText()) +
      (await page.locator('#unknowns').innerText());
    assert.match(uncertainText, /unsupported|unresolved/i);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      ),
      false,
      'narrow viewport should not require horizontal page scrolling',
    );
    assertLocalOnly(page);
    await page.context().close();
  } finally {
    await viewer.close();
  }
}

export async function verifyTaskF1(
  browser: Browser,
  snapshot: AnalysisSnapshot,
): Promise<void> {
  const viewer = await createViewer(snapshot);
  try {
    const page = await openPage(browser, viewer.origin, viewer.url);
    assert.match(
      await page.locator('#snapshot-summary').innerText(),
      /\b5 source files\b/,
      'the F1 visual condition must use its exact five-file task input',
    );
    await selectByName(page, 'routes', 'function');
    await page.getByRole('checkbox', { name: 'REFERENCES' }).uncheck();

    const expectedCalls = [
      { line: 14, column: 11, target: 'initialize' },
      { line: 40, column: 20, target: 'authRouter' },
      { line: 41, column: 20, target: 'userRouter' },
      { line: 42, column: 20, target: 'todoRouter' },
    ];
    for (const call of expectedCalls) {
      await page
        .getByRole('button', {
          name: new RegExp(
            `CALLS occurrence at routes\\/index\\.ts:${call.line}:${call.column}, from routes to ${call.target}`,
          ),
        })
        .waitFor();
    }
    const exactCalls = page
      .locator('#relationships .relationship-item')
      .filter({ hasText: 'CALLS exact' });
    await page.waitForFunction(
      () =>
        [
          ...document.querySelectorAll('#relationships .relationship-item'),
        ].filter((row) => row.textContent?.includes('CALLS exact')).length ===
        5,
    );
    assert.equal(
      await exactCalls.count(),
      5,
      'the four answer calls and the extra depth-two call remain visible',
    );
    assert.equal(
      await page
        .getByRole('button', { name: /CALLS occurrence.*authenticate/ })
        .count(),
      0,
      'the callback-owned authenticate call is not exposed as an exact CALLS edge',
    );
    await page.getByText(/Query truncated:/).waitFor();
    await page.getByText(/depth_limit/).waitFor();

    const authRow = exactCalls.filter({
      hasText: 'Target: authRouter (function)',
    });
    await authRow
      .getByRole('button', { name: 'View occurrence evidence' })
      .click();
    assert.match(
      await page.locator('#evidence pre').innerText(),
      /authRouter\(\)/,
    );
    await authRow.getByRole('button', { name: 'Follow authRouter' }).click();
    await page.getByRole('heading', { name: 'function authRouter' }).waitFor();
    await page.getByRole('button', { name: 'Back' }).click();
    await page.getByRole('heading', { name: 'function routes' }).waitFor();
    assertLocalOnly(page);
    await page.context().close();
  } finally {
    await viewer.close();
  }
}

export async function verifyLatestQueryWins(
  browser: Browser,
  snapshot: AnalysisSnapshot,
): Promise<void> {
  const viewer = await createViewer(snapshot);
  try {
    const page = await openPage(browser, viewer.origin, viewer.url);
    let delayed = false;
    await page.route('**/api/neighbors', async (route) => {
      if (!delayed) {
        delayed = true;
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
      await route.continue();
    });
    const search = page.getByLabel('Name or source path');
    await search.fill('todoRouter');
    await search.press('Enter');
    await page.getByRole('button', { name: /todoRouter · function/ }).click();
    await search.fill('getAll');
    await search.press('Enter');
    await page.getByRole('button', { name: /getAll · method/ }).click();
    await page.getByRole('heading', { name: 'method getAll' }).waitFor();
    await page.waitForTimeout(700);
    assert.equal(
      await page.locator('#root-symbol h3').textContent(),
      'method getAll',
      'a slower response for the previous root must not replace the current selection',
    );
    assertLocalOnly(page);
    await page.context().close();
  } finally {
    await viewer.close();
  }
}
