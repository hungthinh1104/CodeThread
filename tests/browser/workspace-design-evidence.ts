import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright';
import { analyzeManifest, COMPILER_PROFILE } from '@codethread/symbol-indexer';
import { startWorkspaceApp } from './workspace-app.ts';
import {
  chooseRepository,
  chooseTodoRouter,
  openWorkspacePage,
} from './workspace-presentation.ts';

const repositoryId = '72222222-2222-4222-8222-222222222222';
const longPath = `src/điều-tra/${'x'.repeat(136)}-biên-bản.ts`;
const fixtures = [
  {
    path: 'src/todos.ts',
    text: [
      'declare const delivery: { publish(value: string): void };',
      '',
      'export function readTodo(id: string) {',
      '  return id;',
      '}',
      '',
      'export function formatTodo(id: string) {',
      '  return `Todo ${readTodo(id)}`;',
      '}',
      '',
      'export function todoRouter(id: string) {',
      '  const title = formatTodo(id);',
      '  delivery.publish(title);',
      '  return title;',
      '}',
    ].join('\n'),
  },
  {
    path: longPath,
    text: 'export function unicodePath() { return "điều tra"; }\n',
  },
];
const widths = [1440, 1280, 1024, 768, 390, 320] as const;
const themes = ['light', 'dark'] as const;
const sharedTokens = [
  'canvas',
  'surface',
  'raised',
  'ink',
  'muted',
  'border',
  'accent',
  'focus',
  'calls',
  'references',
  'error',
  'radius-sm',
  'radius-md',
  'space-1',
  'space-2',
  'space-3',
  'space-4',
  'space-6',
];

async function browserGeometry(page: Page) {
  return page.evaluate(() => ({
    viewport: window.innerWidth,
    height: window.innerHeight,
    documentWidth: document.documentElement.scrollWidth,
    documentHeight: document.documentElement.scrollHeight,
    viewportWidth: document.documentElement.clientWidth,
    clipped: [
      ...document.querySelectorAll<HTMLElement>('.region, .page-header'),
    ]
      .filter((node) => !node.hidden && node.scrollWidth > node.clientWidth + 1)
      .map((node) => node.className),
    mainTop: Math.round(
      document.querySelector('.main-heading')!.getBoundingClientRect().top,
    ),
    mainBottom: Math.round(
      document.querySelector('.main-heading')!.getBoundingClientRect().bottom,
    ),
  }));
}

async function computedTokens(page: Page) {
  return page.evaluate((keys) => {
    const css = getComputedStyle(document.documentElement);
    return Object.fromEntries(
      keys.map((key) => [key, css.getPropertyValue(`--ct-${key}`).trim()]),
    );
  }, sharedTokens);
}

async function capture(page: Page, path: string) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((ready) =>
      requestAnimationFrame(() => requestAnimationFrame(() => ready())),
    );
  });
  await page.screenshot({
    path,
    animations: 'disabled',
    style: 'nextjs-portal { visibility: hidden !important; }',
  });
}

function afterFrame(page: Page) {
  return page.evaluate(
    () => new Promise<void>((ready) => requestAnimationFrame(() => ready())),
  );
}

async function searchLoading(
  page: Page,
  save: (state: string) => Promise<void>,
) {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const routePath = '**/api/workspace/symbols';
  await page.route(routePath, async (route) => {
    if (route.request().postDataJSON()?.request?.query === 'todoRouter')
      await held;
    await route.fallback();
  });
  const completed = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/workspace/symbols' &&
      response.request().postDataJSON()?.request?.query === 'todoRouter',
  );
  try {
    await page.getByLabel('Name or source path').fill('todoRouter');
    await page.getByText('Searching the pinned snapshot…').waitFor();
    await save('loading');
  } finally {
    release();
    try {
      await completed;
    } finally {
      await page.unroute(routePath);
    }
  }
}

async function inspectDeclaration(
  page: Page,
  save: (state: string) => Promise<void>,
  compact: boolean,
) {
  const trigger = page.getByRole('button', {
    name: 'Inspect evidence',
    exact: true,
  });
  const inspector = page.locator('#evidence-inspector');
  const toggle = page.getByRole('button', { name: 'Evidence', exact: true });
  await trigger.focus();
  await page.keyboard.press('Enter');
  await afterFrame(page);
  const openedFromAction = await inspector.isVisible();
  if (compact && !openedFromAction) {
    await save('evidence-action');
    await toggle.click();
  }
  await inspector.locator('.evidence-card').waitFor();
  await save('selected-evidence');
  if (!compact) return { openedFromAction };

  const closeFocused = await page
    .locator('#close-inspector')
    .evaluate((button) => button === document.activeElement);
  await page.keyboard.press('Tab');
  const tabInside = await inspector.evaluate((panel) =>
    panel.contains(document.activeElement),
  );
  await page.keyboard.press('Shift+Tab');
  const reverseTabInside = await inspector.evaluate((panel) =>
    panel.contains(document.activeElement),
  );
  const backgroundBlocked = await page.evaluate(() => {
    const background = document.getElementById('repository-select');
    background?.focus({ preventScroll: true });
    return background !== document.activeElement;
  });
  await page.keyboard.press('Escape');
  await inspector.waitFor({ state: 'hidden' });
  const target = openedFromAction ? trigger : toggle;
  await afterFrame(page);
  const focusReturned = await target.evaluate(
    (button) => button === document.activeElement,
  );
  await toggle.focus();
  await page.keyboard.press('Enter');
  await inspector.waitFor({ state: 'visible' });
  await page.locator('.inspector-backdrop').click({ position: { x: 2, y: 2 } });
  await inspector.waitFor({ state: 'hidden' });
  await afterFrame(page);
  const backdropReturnedFocus = await toggle.evaluate(
    (button) => button === document.activeElement,
  );
  return {
    openedFromAction,
    closeFocused,
    tabInside,
    reverseTabInside,
    backgroundBlocked,
    focusReturned,
    backdropReturnedFocus,
  };
}

async function inspectTrace(
  page: Page,
  save: (state: string) => Promise<void>,
) {
  const tab = page.getByRole('tab', { name: 'Source' });
  const trace = page.getByRole('tab', { name: 'Trace' });
  await tab.focus();
  const start = performance.now();
  await page.keyboard.press('ArrowRight');
  const exact = page.locator('.relationship-list li').filter({
    has: page.getByRole('button', { name: /^Follow / }),
  });
  await exact.first().waitFor();
  const traceMs = Math.round(performance.now() - start);
  assert.equal(await trace.getAttribute('aria-selected'), 'true');
  assert.ok(
    await trace.evaluate((button) => button === document.activeElement),
  );
  assert.match(
    await page.locator('.coverage-summary').innerText(),
    /Coverage: partial/,
  );
  assert.ok(
    await page
      .locator('.relationship-list li')
      .filter({ hasText: /unsupported|unresolved/ })
      .count(),
  );
  const graph = page.locator('.trace-graph');
  const graphInitiallyVisible = await graph.isVisible();
  const graphInitiallyMounted = (await graph.count()) > 0;
  await save('partial-trace');
  const disclosure = page.getByText('Show exact relationship diagram', {
    exact: true,
  });
  if (!graphInitiallyVisible) await disclosure.press('Enter');
  await graph.waitFor();
  await graph.scrollIntoViewIfNeeded();
  const edgeIds = await page
    .locator('.trace-graph .trace-edge')
    .evaluateAll((edges) =>
      edges.map((edge) => edge.getAttribute('data-relation-id')).sort(),
    );
  const listIds = await exact.evaluateAll((items) =>
    items.map((item) => item.getAttribute('data-relation-id')).sort(),
  );
  assert.ok(edgeIds.length > 0);
  assert.deepEqual(
    edgeIds,
    listIds,
    'the diagram matches the exact followable rows',
  );
  const reverseEdgeAnchored = await graph.evaluate((svg) => {
    const nodes = [...svg.querySelectorAll('.trace-node')];
    const left = nodes.find(
      (node) =>
        node.querySelector('.trace-node-name')?.textContent === 'readTodo',
    );
    const right = nodes.find(
      (node) =>
        node.querySelector('.trace-node-name')?.textContent === 'formatTodo',
    );
    const leftBox = left?.querySelector('rect')?.getBBox();
    const rightBox = right?.querySelector('rect')?.getBBox();
    const edge = [
      ...svg.querySelectorAll<SVGPathElement>('.trace-edge > path'),
    ].find(
      (path) =>
        path.querySelector('title')?.textContent ===
        'CALLS: formatTodo to readTodo',
    );
    if (!edge || !rightBox || !leftBox || leftBox.x >= rightBox.x)
      throw new Error(
        'Expected the fixture’s formatTodo-to-readTodo edge from right to left.',
      );
    return (
      edge.getPointAtLength(0).x === rightBox.x &&
      edge.getPointAtLength(edge.getTotalLength()).x ===
        leftBox.x + leftBox.width
    );
  });
  await save('trace-graph');
  await trace.focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal(await tab.getAttribute('aria-selected'), 'true');
  await page.locator('.source-excerpt').waitFor();
  return {
    traceMs,
    graphInitiallyVisible,
    graphInitiallyMounted,
    reverseEdgeAnchored,
    graphStillMountedOnSource: (await graph.count()) > 0,
    edgeCount: edgeIds.length,
  };
}

async function showEvidenceError(
  page: Page,
  save: (state: string) => Promise<void>,
) {
  const routePath = '**/api/workspace/evidence';
  await page.route(routePath, (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: {
          code: 'VISUAL_TEST_ERROR',
          message: 'Evidence service unavailable.',
        },
      },
    }),
  );
  try {
    await page.getByRole('button', { name: /todoRouter.*function/ }).click();
    await page
      .locator('#source-panel [role="alert"]')
      .getByText(/VISUAL_TEST_ERROR/)
      .waitFor();
    await page.locator('#source-panel [role="alert"]').scrollIntoViewIfNeeded();
    await save('error');
  } finally {
    await page.unroute(routePath);
  }
}

async function inspectOccurrenceThenSource(
  page: Page,
  save: (state: string) => Promise<void>,
  compact: boolean,
) {
  await page.getByRole('tab', { name: 'Source' }).press('ArrowRight');
  const row = page.locator('.relationship-list li').filter({
    has: page.getByRole('button', { name: 'Follow readTodo', exact: true }),
  });
  const trigger = row.getByRole('button', {
    name: 'Inspect occurrence evidence',
  });
  await trigger.press('Enter');
  await afterFrame(page);
  const inspector = page.locator('#evidence-inspector');
  const openedFromAction = await inspector.isVisible();
  if (compact && !openedFromAction)
    await page.getByRole('button', { name: 'Evidence', exact: true }).click();
  await inspector
    .locator('.evidence-card pre')
    .getByText(/readTodo\(id\)/)
    .waitFor();
  await save('occurrence-evidence');
  if (compact) {
    await page.keyboard.press('Escape');
    await inspector.waitFor({ state: 'hidden' });
  }
  await page.getByRole('tab', { name: 'Trace' }).press('ArrowLeft');
  const declaration = page.locator('#source-panel .source-excerpt pre');
  await declaration.waitFor();
  const declarationRestored = (await declaration.innerText()).includes(
    'export function todoRouter',
  );
  await declaration.scrollIntoViewIfNeeded();
  await save('source-after-occurrence');
  return { openedFromAction, declarationRestored };
}

async function captureVariant(
  browser: Browser,
  origin: string,
  directory: string,
  width: number,
  theme: (typeof themes)[number],
) {
  const { context, page, outside } = await openWorkspacePage(browser, origin);
  const shots: string[] = [];
  const requests: Record<string, number> = {};
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (!pathname.startsWith('/api/')) return;
    requests[pathname] = (requests[pathname] ?? 0) + 1;
  });
  const save = async (state: string) => {
    const name = `${width}-${theme}-${state}.png`;
    await capture(page, join(directory, name));
    shots.push(name);
  };
  try {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.emulateMedia({ colorScheme: theme });
    const compact = width <= 900;
    await page.waitForFunction(
      (isCompact) =>
        document.getElementById('inspector-toggle')?.hidden === !isCompact,
      compact,
    );
    await page.keyboard.press('Tab');
    if (compact) {
      assert.equal(
        await page.evaluate(() => document.activeElement?.id),
        'inspector-toggle',
      );
      await page.keyboard.press('Tab');
    }
    assert.equal(
      await page.evaluate(() => document.activeElement?.id),
      'repository-select',
    );
    await save('empty');
    const repositoryStart = performance.now();
    await chooseRepository(page, repositoryId);
    const repositoryMs = Math.round(performance.now() - repositoryStart);
    await searchLoading(page, save);
    const sourceStart = performance.now();
    await chooseTodoRouter(page);
    const sourceMs = Math.round(performance.now() - sourceStart);
    await afterFrame(page);
    const afterSelection = await browserGeometry(page);
    await save('after-symbol-selection');
    const source = page.locator('.source-excerpt');
    assert.match(await source.innerText(), /SHA-256 [a-f0-9]{64}/i);
    assert.match(await source.innerText(), /return title/);
    await source.scrollIntoViewIfNeeded();
    await save('source');
    const beforeTrace = JSON.stringify(requests);
    const trace = await inspectTrace(page, save);
    assert.equal(
      JSON.stringify(requests),
      beforeTrace,
      'view and diagram toggles reuse the current projection',
    );
    const occurrence = await inspectOccurrenceThenSource(page, save, compact);
    const inspector = await inspectDeclaration(page, save, compact);
    await showEvidenceError(page, save);
    await page.getByLabel('Name or source path').fill('unicodePath');
    await page.getByRole('button', { name: /unicodePath.*function/ }).click();
    await source.getByText(longPath, { exact: false }).waitFor();
    const longSource = await browserGeometry(page);
    await source.scrollIntoViewIfNeeded();
    await save('long-path');
    await page
      .getByRole('button', { name: 'Inspect evidence', exact: true })
      .click();
    const dialog = page.locator('#evidence-inspector');
    if (compact && !(await dialog.isVisible()))
      await page.getByRole('button', { name: 'Evidence', exact: true }).click();
    await dialog
      .locator('.evidence-card')
      .getByText(longPath, { exact: true })
      .waitFor();
    const longInspector = await browserGeometry(page);
    await save('long-path-evidence');
    assert.deepEqual(
      outside,
      [],
      'visual fixtures use only their loopback origin',
    );
    return {
      width,
      theme,
      shots,
      repositoryMs,
      sourceMs,
      afterSelection,
      trace,
      occurrence,
      inspector,
      longSource,
      longInspector,
      requests,
      tokens: await computedTokens(page),
    };
  } finally {
    await context.close();
  }
}

function verifyCandidate(result: Awaited<ReturnType<typeof captureVariant>>) {
  const label = `${result.width}px ${result.theme}`;
  for (const layout of [
    result.afterSelection,
    result.longSource,
    result.longInspector,
  ]) {
    assert.ok(
      layout.documentWidth <= layout.viewportWidth,
      `${label} document reflow`,
    );
    assert.deepEqual(layout.clipped, [], `${label} region reflow`);
  }
  if (result.width <= 760) {
    assert.ok(
      result.afterSelection.mainTop >= 0 &&
        result.afterSelection.mainBottom <= result.afterSelection.height,
      `${label} selection reveals the source region`,
    );
  }
  if (result.width <= 900) {
    assert.deepEqual(
      result.inspector,
      {
        openedFromAction: true,
        closeFocused: true,
        tabInside: true,
        reverseTabInside: true,
        backgroundBlocked: true,
        focusReturned: true,
        backdropReturnedFocus: true,
      },
      `${label} modal evidence interaction`,
    );
  }
  assert.equal(
    result.trace.graphInitiallyMounted,
    false,
    `${label} show the diagram only on demand`,
  );
  assert.equal(
    result.trace.graphStillMountedOnSource,
    false,
    `${label} unmount the diagram when returning to source`,
  );
  assert.equal(
    result.trace.reverseEdgeAnchored,
    true,
    `${label} right-to-left arrow ends at the target's visible edge`,
  );
  assert.deepEqual(
    result.occurrence,
    {
      openedFromAction: true,
      declarationRestored: true,
    },
    `${label} occurrence evidence does not replace the source declaration`,
  );
}

type EvidenceReport = {
  mode: 'before' | 'after';
  sha: string;
  checkoutSha: string;
  productDirty: boolean;
  browser: string;
  os: string;
  fixture: { path: string; sha256: string }[];
  variants: Awaited<ReturnType<typeof captureVariant>>[];
};

async function compare(directory: string) {
  const read = async (mode: 'before' | 'after') => {
    const report = JSON.parse(
      await readFile(join(directory, mode, 'workspace-visual.json'), 'utf8'),
    ) as EvidenceReport;
    assert.equal(report.mode, mode);
    assert.equal(report.variants.length, widths.length * themes.length);
    return report;
  };
  const [before, after] = await Promise.all([read('before'), read('after')]);
  assert.equal(after.browser, before.browser);
  assert.equal(after.os, before.os);
  assert.deepEqual(after.fixture, before.fixture);
  const variants = before.variants.map((old) => {
    const current = after.variants.find(
      (item) => item.width === old.width && item.theme === old.theme,
    );
    assert.ok(current, `missing ${old.width}px ${old.theme} candidate`);
    const observation = (item: typeof old) => ({
      screenshots: item.shots.length,
      mainHeadingTop: item.afterSelection.mainTop,
      referenceViewportHeight: item.afterSelection.height,
      graphMountedBeforeDisclosure: item.trace.graphInitiallyMounted,
      reverseEdgeAnchored: item.trace.reverseEdgeAnchored,
      inspector: item.inspector,
      sourceAfterOccurrence: item.occurrence,
      requestCounts: item.requests,
      milliseconds: {
        repository: item.repositoryMs,
        source: item.sourceMs,
        trace: item.trace.traceMs,
      },
    });
    return {
      width: old.width,
      theme: old.theme,
      before: observation(old),
      after: observation(current),
    };
  });
  const result = {
    baseline: before.sha,
    candidate: after.sha,
    browser: after.browser,
    os: after.os,
    variants,
  };
  await writeFile(
    join(directory, 'comparison.json'),
    JSON.stringify(result, null, 2) + '\n',
  );
}

function git(...args: string[]) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

async function main() {
  const [mode, output, expectedSha] = process.argv.slice(2);
  assert.ok(output, 'provide the artifact directory');
  const directory = resolve(output);
  if (mode === 'compare') {
    await compare(directory);
    return;
  }
  assert.ok(mode === 'before' || mode === 'after', 'choose before or after');
  const checkoutSha = git('rev-parse', 'HEAD');
  const sha = expectedSha ?? checkoutSha;
  const productDirty = Boolean(
    git(
      'status',
      '--porcelain=v1',
      '--',
      'packages',
      'scripts',
      'pnpm-lock.yaml',
    ),
  );
  if (expectedSha) {
    assert.match(expectedSha, /^[a-f0-9]{40}$/);
    assert.equal(
      git('rev-parse', `${expectedSha}^{tree}`),
      git('rev-parse', 'HEAD^{tree}'),
    );
    assert.equal(
      productDirty,
      false,
      'hosted evidence must use exact product sources',
    );
  }
  const files = fixtures.map(({ path, text }) => ({
    path,
    bytes: Buffer.from(text),
    sha256: createHash('sha256').update(text).digest('hex'),
  }));
  const snapshot = await analyzeManifest({
    repositoryId,
    compilerOptions: COMPILER_PROFILE,
    files,
  });
  await mkdir(directory, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const variants = [];
    for (const theme of themes) {
      for (let offset = 0; offset < widths.length; offset += 4) {
        // Viewport contexts retain BFF sessions after close; keep each app batch
        // within the four-session cap instead of expiring product sessions.
        const app = await startWorkspaceApp(snapshot);
        try {
          const legacy = await browser.newPage({ colorScheme: theme });
          await legacy.goto(app.viewer.url);
          const legacyTokens = await computedTokens(legacy);
          await legacy.close();
          for (const width of widths.slice(offset, offset + 4)) {
            const result = await captureVariant(
              browser,
              app.origin,
              directory,
              width,
              theme,
            );
            assert.deepEqual(
              result.tokens,
              legacyTokens,
              `${theme} shared Warm Graphite tokens`,
            );
            if (mode === 'after') verifyCandidate(result);
            variants.push(result);
            console.log(
              `${width}px ${theme} captured ${result.shots.length} states`,
            );
          }
        } finally {
          await app.close();
        }
      }
    }
    const report: EvidenceReport = {
      mode,
      sha,
      checkoutSha,
      productDirty,
      browser: browser.version(),
      os: process.platform,
      fixture: files.map(({ path, sha256 }) => ({ path, sha256 })),
      variants,
    };
    await writeFile(
      join(directory, 'workspace-visual.json'),
      JSON.stringify(report, null, 2) + '\n',
    );
  } finally {
    await browser.close();
  }
}

await main();
