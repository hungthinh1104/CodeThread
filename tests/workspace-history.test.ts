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
  fault: { session: boolean; graph: boolean; missingEvidence: boolean },
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
      const response = await route.fetch({
        postData: { ...request, projectId },
      });
      assert.equal(response.status(), 200);
      const body = (await response.json()) as { projectId: string };
      await route.fulfill({
        response,
        json: { ...body, projectId: otherProjectId },
      });
    },
  );
}

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
