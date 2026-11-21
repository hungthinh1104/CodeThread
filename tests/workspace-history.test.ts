import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chromium, type Page } from 'playwright';
import { it } from 'vitest';
import { analyzeManifest, COMPILER_PROFILE } from '@codethread/symbol-indexer';
import { startWorkspaceApp } from './browser/workspace-app.ts';

const repositoryId = '22222222-2222-4222-8222-222222222222';
const projectId = 'workspace-test-project';
const otherProjectId = 'workspace-other-project';
const bytes = Buffer.from(
  'export function root() { return leaf(); }\nexport function leaf() { return 1; }\n',
);
const snapshot = await analyzeManifest({
  repositoryId,
  compilerOptions: COMPILER_PROFILE,
  files: [
    {
      path: 'src/root.ts',
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  ],
});

async function withWorkspace(
  test: (page: Page, origin: string) => Promise<void>,
) {
  const app = await startWorkspaceApp(snapshot);
  try {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(12_000);
      await test(page, app.origin);
    } finally {
      await browser.close();
    }
  } finally {
    await app.close();
  }
}

function historyControl(page: Page, name: 'Back' | 'Forward') {
  return page
    .getByRole('navigation', { name: 'Investigation history' })
    .getByRole('button', { name, exact: true });
}

function excerpt(page: Page, name: 'root' | 'leaf') {
  return page
    .locator('.source-excerpt pre')
    .filter({ hasText: 'function ' + name });
}

async function choose(page: Page, name: 'root' | 'leaf') {
  await page
    .getByRole('button', { name: new RegExp(name + '.*function') })
    .click();
  await excerpt(page, name).waitFor();
}

async function projectFixture(
  page: Page,
  fault: {
    session: boolean;
    graph: boolean;
    missingEvidence: boolean;
    destinationGraph?: 'unavailable' | 'missing-root' | null;
    destinationSessionUnavailable?: boolean;
    wrongDestinationEvidence?: boolean;
  },
) {
  await page.route('**/api/workspace/projects', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      items: Record<string, unknown>[];
    };
    assert.ok(body.items[0]);
    body.items.push({
      ...body.items[0],
      id: otherProjectId,
      label: 'Other context',
    });
    await route.fulfill({ response, json: body });
  });
  await page.route('**/api/workspace/catalog', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      items: { projectId: string; symbol: { name: string } }[];
    };
    for (const item of body.items)
      if (item.symbol.name === 'leaf') item.projectId = otherProjectId;
    await route.fulfill({ response, json: body });
  });
  await page.route('**/api/workspace/follow-context', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      candidates: Record<string, unknown>[];
    };
    assert.ok(body.candidates[0]);
    body.candidates.push({
      ...body.candidates[0],
      projectId: otherProjectId,
      projectLabel: 'Other context',
    });
    await route.fulfill({ response, json: body });
  });
  await page.route(
    /\/api\/workspace\/(?:session|neighbors|evidence)$/,
    async (route) => {
      const request = route.request().postDataJSON() as {
        projectId: string;
        request: { snapshotId?: string; evidenceIds?: string[] };
      };
      const operation = new URL(route.request().url()).pathname
        .split('/')
        .pop();
      if (
        request.projectId === projectId &&
        ((operation === 'session' && fault.session) ||
          (operation === 'neighbors' && fault.graph))
      ) {
        await route.fulfill({
          status: 503,
          json: {
            error: {
              code:
                operation === 'session'
                  ? 'TEST_HISTORY_SESSION_UNAVAILABLE'
                  : 'TEST_HISTORY_GRAPH_UNAVAILABLE',
              message: 'Context read failed.',
            },
          },
        });
        return;
      }
      if (
        request.projectId === projectId &&
        operation === 'evidence' &&
        fault.missingEvidence
      ) {
        await route.fulfill({
          json: {
            projectId,
            result: {
              meta: { snapshotId: request.request.snapshotId },
              items: request.request.evidenceIds?.map((evidenceId) => ({
                evidenceId,
                snapshotId: request.request.snapshotId,
                status: 'unavailable',
                code: 'SOURCE_UNAVAILABLE',
              })),
            },
          },
        });
        return;
      }
      if (request.projectId !== otherProjectId) {
        await route.continue();
        return;
      }
      if (
        (operation === 'neighbors' &&
          fault.destinationGraph === 'unavailable') ||
        (operation === 'session' && fault.destinationSessionUnavailable)
      ) {
        await route.fulfill({
          status: 503,
          json: {
            error: {
              code: 'TEST_DESTINATION_UNAVAILABLE',
              message: 'The destination context read failed.',
            },
          },
        });
        return;
      }
      const response = await route.fetch({
        postData: { ...request, projectId },
      });
      assert.equal(response.status(), 200);
      const body = (await response.json()) as {
        projectId: string;
        result: {
          graph?: { symbols: unknown[] };
          meta?: { snapshotId: string };
        };
      };
      if (
        operation === 'neighbors' &&
        fault.destinationGraph === 'missing-root'
      ) {
        assert.ok(body.result.graph);
        body.result.graph.symbols = [];
      }
      if (operation === 'evidence' && fault.wrongDestinationEvidence) {
        assert.ok(body.result.meta);
        body.result.meta.snapshotId = '55555555-5555-4555-8555-555555555555';
      }
      await route.fulfill({
        response,
        json: { ...body, projectId: otherProjectId },
      });
    },
  );
}

it.each(['catalog selection', 'context match'] as const)(
  'retains the current investigation when a %s cannot open a destination graph',
  async (entry) => {
    await withWorkspace(async (page, origin) => {
      const fault = {
        session: false,
        graph: false,
        missingEvidence: false,
        destinationGraph: 'unavailable' as
          'unavailable' | 'missing-root' | null,
        wrongDestinationEvidence: false,
      };
      await projectFixture(page, fault);
      await page.goto(origin);
      await page.getByLabel('Repository and scan').selectOption(repositoryId);
      await choose(page, 'root');
      const inspector = page.locator('#evidence-inspector .evidence-card');
      await inspector.waitFor();
      const originalEvidence = await inspector.innerText();
      const historyLength = await page.evaluate(() => window.history.length);
      const project = page.getByLabel('Project context');
      const definition = entry === 'catalog selection' ? 'leaf' : 'root';
      if (entry === 'catalog selection') {
        await page.getByLabel('Search scope').selectOption('repository');
        await page.getByLabel('Name or source path').fill('leaf');
      } else {
        await page
          .getByRole('button', { name: 'Find matching project contexts' })
          .click();
      }
      const destination =
        entry === 'catalog selection'
          ? page.getByRole('button', { name: /leaf.*function/ })
          : page.getByRole('button', { name: /Open Other context/ });
      for (const status of [503, 200]) {
        if (status === 200) fault.destinationGraph = 'missing-root';
        await destination.waitFor();
        const completed = page.waitForResponse(
          (response) =>
            response.url().endsWith('/api/workspace/neighbors') &&
            response.status() === status &&
            response.request().postDataJSON().projectId === otherProjectId,
        );
        await destination.click();
        await (await completed).finished();
        await page.evaluate(
          () =>
            new Promise<void>((done) =>
              requestAnimationFrame(() => requestAnimationFrame(() => done())),
            ),
        );
        assert.equal(await project.inputValue(), projectId);
        assert.equal(await excerpt(page, 'root').isVisible(), true);
        assert.equal(await inspector.innerText(), originalEvidence);
        assert.equal(
          await page.evaluate(() => window.history.length),
          historyLength,
        );
      }
      await page
        .getByText(/did not return the verified declaration/i)
        .waitFor();
      fault.destinationGraph = null;
      fault.wrongDestinationEvidence = true;
      await destination.click();
      await page.getByText(/WORKSPACE_SNAPSHOT_MISMATCH/).waitFor();
      assert.equal(await project.inputValue(), projectId);
      assert.equal(await excerpt(page, 'root').isVisible(), true);
      assert.equal(await inspector.innerText(), originalEvidence);
      assert.equal(
        await page.evaluate(() => window.history.length),
        historyLength,
      );
      fault.wrongDestinationEvidence = false;
      await destination.click();
      await page.waitForFunction(
        (id) =>
          document.querySelector<HTMLSelectElement>('#project-select')
            ?.value === id,
        otherProjectId,
      );
      await excerpt(page, definition).waitFor();
      await historyControl(page, 'Back').click();
      await page.waitForFunction(
        (id) =>
          document.querySelector<HTMLSelectElement>('#project-select')
            ?.value === id,
        projectId,
      );
      await excerpt(page, 'root').waitFor();
      assert.equal(await project.inputValue(), projectId);
    });
  },
  90_000,
);

it('retains the current investigation when the project picker cannot open a session', async () => {
  await withWorkspace(async (page, origin) => {
    const fault = {
      session: false,
      graph: false,
      missingEvidence: false,
      destinationSessionUnavailable: true,
    };
    await projectFixture(page, fault);
    await page.goto(origin);
    await page.getByLabel('Repository and scan').selectOption(repositoryId);
    await choose(page, 'root');
    const inspector = page.locator('#evidence-inspector .evidence-card');
    await inspector.waitFor();
    const originalEvidence = await inspector.innerText();
    const historyLength = await page.evaluate(() => window.history.length);
    const picker = page.getByLabel('Project context');
    await picker.selectOption(otherProjectId);
    await page
      .getByRole('alert')
      .getByText(/TEST_DESTINATION_UNAVAILABLE/)
      .waitFor();
    assert.equal(await picker.inputValue(), projectId);
    assert.equal(await excerpt(page, 'root').isVisible(), true);
    assert.equal(await inspector.innerText(), originalEvidence);
    assert.equal(
      await page.evaluate(() => window.history.length),
      historyLength,
    );

    fault.destinationSessionUnavailable = false;
    await picker.selectOption(otherProjectId);
    await page.waitForFunction(
      (id) =>
        document.querySelector<HTMLSelectElement>('#project-select')?.value ===
        id,
      otherProjectId,
    );
    await excerpt(page, 'root').waitFor({ state: 'hidden' });
    await historyControl(page, 'Back').click();
    await excerpt(page, 'root').waitFor();
    assert.equal(await picker.inputValue(), projectId);
  });
}, 90_000);

it('keeps the loaded inventory explicit and retries the failed page offset', async () => {
  await withWorkspace(async (page, origin) => {
    const offsets: number[] = [];
    const secondPath = 'src/second-page.ts';
    let failNext = true;
    await page.route('**/api/workspace/files', async (route) => {
      const request = route.request().postDataJSON() as { offset: number };
      offsets.push(request.offset);
      if (request.offset > 0 && failNext) {
        failNext = false;
        await route.fulfill({
          status: 503,
          json: {
            error: {
              code: 'TEST_FILE_PAGE_UNAVAILABLE',
              message: 'File page is unavailable.',
            },
          },
        });
        return;
      }
      const response = await route.fetch({
        postData: { ...request, offset: 0 },
      });
      const body = (await response.json()) as { items: { path: string }[] };
      await route.fulfill({
        response,
        json:
          request.offset === 0
            ? { ...body, total: 51, nextOffset: 50 }
            : {
                ...body,
                total: 51,
                offset: 50,
                nextOffset: null,
                items: body.items.map((item) => ({
                  ...item,
                  path: secondPath,
                })),
              },
      });
    });
    await page.goto(origin);
    await page.getByLabel('Repository and scan').selectOption(repositoryId);
    const inventory = page.getByRole('region', { name: 'Source inventory' });
    const first = inventory.getByText('src/root.ts', { exact: true });
    await first.waitFor();
    await inventory.getByRole('button', { name: 'Next', exact: true }).click();
    const failure = inventory.getByRole('alert');
    await failure.getByText(/TEST_FILE_PAGE_UNAVAILABLE/).waitFor();
    assert.equal(await first.isVisible(), true);
    const retry = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/workspace/files') &&
        response.status() === 200,
    );
    const notice = await failure.innerText();
    await inventory
      .getByRole('button', { name: 'Retry file inventory' })
      .click();
    await (await retry).finished();
    assert.deepEqual(offsets, [0, 50, 50]);
    assert.match(notice, /Showing the previously loaded page/);
    await inventory.getByText(secondPath, { exact: true }).waitFor();
  });
}, 90_000);

it('coalesces repeated selections and restores distinct entries within the history limit', async () => {
  await withWorkspace(async (page, origin) => {
    await page.goto(origin);
    await page.getByLabel('Repository and scan').selectOption(repositoryId);
    await choose(page, 'root');
    const initialLength = await page.evaluate(() => window.history.length);
    await choose(page, 'root');
    assert.equal(
      await page.evaluate(() => window.history.length),
      initialLength,
      'the same selection must not add another browser history entry',
    );

    for (let index = 1; index < 42; ++index)
      await choose(page, index % 2 ? 'leaf' : 'root');

    await page.evaluate(() => window.history.back());
    await excerpt(page, 'root').waitFor();
    await historyControl(page, 'Forward').click();
    await excerpt(page, 'leaf').waitFor();

    for (let step = 1; step <= 39; ++step) {
      await historyControl(page, 'Back').click();
      await excerpt(page, step % 2 ? 'root' : 'leaf').waitFor();
    }
    assert.equal(await historyControl(page, 'Back').isDisabled(), true);

    // Native Back can still land on the evicted slot. The displayed entry and
    // the workspace controls must still use the retained history.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          window.addEventListener('popstate', () => resolve(), { once: true });
          window.history.back();
        }),
    );
    assert.equal(await excerpt(page, 'root').isVisible(), true);
    await historyControl(page, 'Forward').click();
    await excerpt(page, 'leaf').waitFor();
  });
}, 150_000);

it('keeps the current context when Back cannot validate its destination and restores typed unavailable evidence', async () => {
  await withWorkspace(async (page, origin) => {
    const fault = { session: false, graph: false, missingEvidence: false };
    await projectFixture(page, fault);
    await page.goto(origin);
    await page.getByLabel('Repository and scan').selectOption(repositoryId);
    await choose(page, 'root');
    await page.getByLabel('Search scope').selectOption('repository');
    await page.getByLabel('Name or source path').fill('leaf');
    await choose(page, 'leaf');
    const project = page.getByLabel('Project context');
    assert.equal(await project.inputValue(), otherProjectId);

    fault.session = true;
    await historyControl(page, 'Back').click();
    await page
      .getByRole('alert')
      .filter({ hasText: 'TEST_HISTORY_SESSION_UNAVAILABLE' })
      .waitFor();
    assert.equal(await project.inputValue(), otherProjectId);
    assert.equal(await excerpt(page, 'leaf').isVisible(), true);
    assert.equal(await historyControl(page, 'Forward').isDisabled(), true);

    fault.session = false;
    fault.graph = true;
    await historyControl(page, 'Back').click();
    await page
      .getByRole('alert')
      .filter({ hasText: 'TEST_HISTORY_GRAPH_UNAVAILABLE' })
      .waitFor();
    assert.equal(await project.inputValue(), otherProjectId);
    assert.equal(await excerpt(page, 'leaf').isVisible(), true);

    fault.graph = false;
    fault.missingEvidence = true;
    await historyControl(page, 'Back').click();
    await page
      .getByText(/Declaration evidence unavailable: SOURCE_UNAVAILABLE/)
      .waitFor();
    assert.equal(await project.inputValue(), projectId);
    assert.equal(await page.locator('.source-excerpt').count(), 0);
    assert.equal(
      await page.locator('#evidence-inspector .evidence-card').count(),
      0,
    );

    await historyControl(page, 'Forward').click();
    await excerpt(page, 'leaf').waitFor();
    assert.equal(await project.inputValue(), otherProjectId);
  });
}, 90_000);
