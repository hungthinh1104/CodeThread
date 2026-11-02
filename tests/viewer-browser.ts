import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chromium, type Browser, type Page } from 'playwright';
import { analyzeManifest, COMPILER_PROFILE } from '@codethread/symbol-indexer';
import type {
  AnalysisInput,
  AnalysisSnapshot,
} from '@codethread/symbol-indexer';
import {
  loadExternalCorpus,
  loadTodoClosure,
} from '../scripts/external-semantic-corpus.ts';
import { createViewer } from '../scripts/viewer.ts';

const repositoryIds = {
  todo: '00000000-0000-4000-8000-000000000021',
  tinyexec: '00000000-0000-4000-8000-000000000022',
  safe: '00000000-0000-4000-8000-000000000023',
} as const;
const crossOriginRequests = new WeakMap<Page, string[]>();

function analysisInput(
  repositoryId: string,
  files: AnalysisInput['files'],
): AnalysisInput {
  return {
    repositoryId,
    compilerOptions: COMPILER_PROFILE,
    files,
  };
}

async function analyzePinnedSources(): Promise<{
  todo: AnalysisSnapshot;
  tinyexec: AnalysisSnapshot;
}> {
  const todoCorpus = await loadExternalCorpus('todo');
  const todoClosure = await loadTodoClosure();
  const tinyexecCorpus = await loadExternalCorpus('tinyexec');
  const [todo, tinyexec] = await Promise.all([
    analyzeManifest(
      analysisInput(repositoryIds.todo, [...todoCorpus.files, ...todoClosure]),
    ),
    analyzeManifest(
      analysisInput(repositoryIds.tinyexec, tinyexecCorpus.files),
    ),
  ]);
  return { todo, tinyexec };
}

async function openPage(
  browser: Browser,
  origin: string,
  url: string,
): Promise<Page> {
  const outsideOrigin: string[] = [];
  const context = await browser.newContext({
    viewport: { width: 1100, height: 900 },
  });
  await context.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin !== origin) {
      outsideOrigin.push(route.request().url());
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForFunction(
      () =>
        document
          .querySelector('#snapshot-summary')
          ?.textContent?.includes('source files'),
      undefined,
      { timeout: 8000 },
    );
  } catch (error) {
    const body = await page.locator('body').innerText();
    throw new Error(
      `Viewer did not initialize: ${body}\n${browserErrors.join('\n')}\n${error instanceof Error ? error.message : ''}`,
      { cause: error },
    );
  }
  crossOriginRequests.set(page, outsideOrigin);
  await page.keyboard.press('Tab');
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    'symbol-query',
    'keyboard focus should reach symbol search before investigation controls',
  );
  assert.equal(
    await page.evaluate(() =>
      document.activeElement?.matches(':focus-visible'),
    ),
    true,
    'keyboard focus should remain visible',
  );
  return page;
}

function assertLocalOnly(page: Page): void {
  assert.deepEqual(
    crossOriginRequests.get(page),
    [],
    'the viewer must not request external browser resources',
  );
}

async function selectByName(
  page: Page,
  name: string,
  kind: string,
): Promise<void> {
  const search = page.getByLabel('Name or source path');
  await search.fill(name);
  await search.press('Enter');
  await page
    .getByRole('button', { name: new RegExp(`${name} · ${kind}`) })
    .click();
  await page.waitForFunction(
    (expected) =>
      document.querySelector('#root-symbol h3')?.textContent === expected,
    `${kind} ${name}`,
  );
}

async function verifyTodo(
  browser: Browser,
  snapshot: AnalysisSnapshot,
): Promise<void> {
  const viewer = await createViewer(snapshot);
  try {
    const page = await openPage(browser, viewer.origin, viewer.url);
    await page.setViewportSize({ width: 390, height: 844 });
    await selectByName(page, 'todoRouter', 'function');

    await page.getByLabel('REFERENCES').check();
    await page.getByLabel('CALLS').uncheck();
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
    const getAllRow = referenceRows.filter({ hasText: 'getAll' }).first();
    await getAllRow
      .getByRole('button', { name: 'View occurrence evidence' })
      .click();
    await page.getByText(/toDoCtrl\.getAll/).waitFor();
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

async function verifyLatestQueryWins(
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

async function verifyDirectCalls(
  browser: Browser,
  snapshot: AnalysisSnapshot,
): Promise<void> {
  const viewer = await createViewer(snapshot);
  try {
    const page = await openPage(browser, viewer.origin, viewer.url);
    await selectByName(page, 'computeEnv', 'function');
    await page.waitForFunction(() =>
      [...document.querySelectorAll('#relationships .relationship-item')].some(
        (row) =>
          row.textContent?.includes('CALLS exact') &&
          row.textContent.includes('getPathFromEnv'),
      ),
    );
    await page.getByText(/CALLS unresolved/).waitFor();
    const exactCall = page
      .locator('#relationships .relationship-item')
      .filter({ hasText: 'CALLS exact' })
      .filter({ hasText: 'getPathFromEnv' })
      .first();
    await exactCall
      .getByRole('button', { name: 'View occurrence evidence' })
      .click();
    await page.getByText(/getPathFromEnv\(envWithDefault\)/).waitFor();
    const callExcerpt = await page.locator('#evidence pre').textContent();
    assert.ok(callExcerpt);
    assert.match(callExcerpt, /getPathFromEnv\(envWithDefault\)/);
    await exactCall
      .getByRole('button', { name: 'Follow getPathFromEnv' })
      .click();
    await page
      .getByRole('heading', { name: 'function getPathFromEnv' })
      .waitFor();
    const uncertainty =
      (await page.locator('#relationships').innerText()) +
      (await page.locator('#unknowns').innerText());
    assert.match(uncertainty, /unsupported|unresolved/i);
    await page.getByRole('button', { name: 'Back' }).click();
    await page.getByRole('heading', { name: 'function computeEnv' }).waitFor();
    assertLocalOnly(page);
    await page.context().close();
  } finally {
    await viewer.close();
  }
}

async function verifySafeEvidence(browser: Browser): Promise<void> {
  const source = `export function safeMarkup() { return "<img src=x onerror=alert(1)>" + "${String.fromCodePoint(0x202e)}"; }\r\n`;
  const bytes = Buffer.from(source, 'utf8');
  const snapshot = await analyzeManifest(
    analysisInput(repositoryIds.safe, [
      {
        path: 'src/safe.ts',
        bytes,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    ]),
  );
  const viewer = await createViewer(snapshot);
  try {
    const page = await openPage(browser, viewer.origin, viewer.url);
    await selectByName(page, 'safeMarkup', 'function');
    await page
      .getByRole('button', { name: 'View declaration evidence' })
      .click();
    const excerpt = page.locator('#evidence pre');
    await page.waitForFunction(() =>
      document
        .querySelector('#evidence pre')
        ?.textContent?.includes('safeMarkup'),
    );
    const rendered = await excerpt.textContent();
    assert.ok(rendered);
    assert.match(rendered, /<img src=x onerror=alert\(1\)>/);
    assert.match(rendered, /\\u\{202e\}/);
    assert.equal(
      await page.locator('#evidence img, #evidence script').count(),
      0,
    );
    assert.equal(await page.locator('script:not([src])').count(), 0);
    assertLocalOnly(page);
    await page.context().close();
  } finally {
    await viewer.close();
  }
}

async function verifyDeepRelationshipOrientation(
  browser: Browser,
): Promise<void> {
  const source =
    'export function root() { branch(); }\n' +
    'function branch() { leaf(); }\n' +
    'function leaf() {}\n';
  const bytes = Buffer.from(source, 'utf8');
  const snapshot = await analyzeManifest(
    analysisInput(repositoryIds.safe, [
      {
        path: 'src/chain.ts',
        bytes,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    ]),
  );
  const viewer = await createViewer(snapshot);
  try {
    const page = await openPage(browser, viewer.origin, viewer.url);
    await selectByName(page, 'root', 'function');
    await page.waitForFunction(() =>
      [...document.querySelectorAll('#relationships .relationship-item')].some(
        (row) =>
          row.textContent?.includes('CALLS exact') &&
          row.textContent.includes('Source: branch') &&
          row.textContent.includes('Target: leaf'),
      ),
    );
    const deepRelation = page
      .locator('#relationships .relationship-item')
      .filter({ hasText: 'Source: branch' })
      .filter({ hasText: 'Target: leaf' });
    const text = await deepRelation.innerText();
    assert.match(text, /within selected neighborhood/);
    assert.doesNotMatch(text, /· (?:incoming|outgoing)(?:\s|$)/);
    await deepRelation.getByRole('button', { name: 'Follow leaf' }).click();
    await page.getByRole('heading', { name: 'function leaf' }).waitFor();
    assertLocalOnly(page);
    await page.context().close();
  } finally {
    await viewer.close();
  }
}

async function main(): Promise<void> {
  const { todo, tinyexec } = await analyzePinnedSources();
  const browser = await chromium.launch({ headless: true });
  try {
    await verifyTodo(browser, todo);
    await verifyLatestQueryWins(browser, todo);
    await verifyDirectCalls(browser, tinyexec);
    await verifyDeepRelationshipOrientation(browser);
    await verifySafeEvidence(browser);
  } finally {
    await browser.close();
  }
  process.stdout.write(
    'Browser investigation passed: pinned todo REFERENCES, tinyexec CALLS, target follow/back, uncertainty, evidence and safe rendering.\n',
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : 'Browser evaluation failed.'}\n`,
  );
  process.exitCode = 1;
});
