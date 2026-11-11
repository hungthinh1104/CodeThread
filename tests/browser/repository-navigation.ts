import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import type { Browser, Page } from 'playwright';
import { repositoryViewerFixture } from '../helpers/repository-viewer.ts';
import { createRepositoryViewer } from '../../scripts/viewer.ts';
import { openPage, assertLocalOnly } from './helpers.ts';

async function search(page: Page, name: string) {
  const resultResponse = page.waitForResponse((response) => {
    const request = response.request();
    if (
      request.method() !== 'POST' ||
      !['/api/catalog', '/api/symbols'].includes(
        new URL(response.url()).pathname,
      )
    )
      return false;
    try {
      const body = request.postDataJSON() as {
        query?: unknown;
        request?: { query?: unknown };
      };
      return (body.request?.query ?? body.query) === name;
    } catch {
      return false;
    }
  });
  await page.getByLabel('Name or source path').fill(name);
  await page.getByLabel('Name or source path').press('Enter');
  await resultResponse;
  await page.waitForFunction((expected) => {
    const rows = [...document.querySelectorAll('#symbol-results button')];
    return (
      rows.length > 0 &&
      rows.every((row) => row.textContent?.startsWith(expected + ' ·'))
    );
  }, name);
}
async function waitForProjectSnapshot(page: Page) {
  await page.waitForFunction(() =>
    document
      .querySelector('#snapshot-summary')
      ?.textContent?.startsWith('Snapshot '),
  );
}
async function root(page: Page, name: string) {
  try {
    await page
      .getByRole('heading', { name: 'function ' + name, exact: true })
      .waitFor();
  } catch (error) {
    throw new Error(
      `Expected the selected ${name} declaration. Viewer: ${await page.locator('body').innerText()}`,
      { cause: error },
    );
  }
}
export async function verifyRepositoryNavigation(browser: Browser) {
  const directories: string[] = [],
    { session } = await repositoryViewerFixture(directories);
  const viewer = await createRepositoryViewer(session);
  let page: Page | undefined;
  try {
    page = await openPage(browser, viewer.origin, viewer.url, 'project-select');
    const id = (label: string) =>
      session.projects.find((item) => item.project.configPath === label)!
        .project.id;
    const a = id('projects/a/tsconfig.json'),
      b = id('projects/b/tsconfig.json'),
      c = id('projects/c/tsconfig.json');
    const project = page.getByLabel('Project context', { exact: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.match(
      await page.locator('#repository-summary').innerText(),
      /Inventory complete=true; source analyzed=false; projects finished=false/,
    );
    assert.equal(
      await project
        .locator('option:disabled')
        .filter({ hasText: 'broken' })
        .count(),
      1,
    );
    await page
      .getByText('Source inventory and project diagnostics', { exact: true })
      .click();
    await page
      .locator('#source-files')
      .getByText(/src\/types.ts: analyzed/)
      .waitFor();
    await page
      .locator('#source-files')
      .getByText(/src\/broken.ts: not_analyzed/)
      .waitFor();
    await page
      .locator('#source-files')
      .getByText(/src\/broken.ts: not_analyzed.*MALFORMED_SOURCE/)
      .waitFor();
    await page
      .locator('#source-files')
      .getByText(/src\/linked.ts: excluded.*Git symlink entries/)
      .waitFor();
    await page
      .getByText('Source inventory and project diagnostics', { exact: true })
      .click();
    await search(page, 'target');
    assert.equal(
      await page.locator('#symbol-results button').count(),
      3,
      'global catalog retains all three contexts',
    );
    await search(page, 'entry');
    const entry = page.locator('#symbol-results button').first();
    await entry.focus();
    await page.keyboard.press('Enter');
    await root(page, 'entry');
    await page
      .getByLabel('Direction', { exact: true })
      .selectOption('outgoing');
    await page
      .locator('#relationships')
      .getByRole('button', { name: 'View occurrence evidence', exact: true })
      .first()
      .click();
    await page
      .locator('#evidence pre')
      .getByText('target()', { exact: true })
      .waitFor();
    assert.equal(
      await page.locator('#relationships .relationship-item').count(),
      2,
      'two occurrences remain distinct',
    );
    await page
      .locator('#relationships')
      .getByRole('button', { name: 'Follow target', exact: true })
      .first()
      .click();
    const choices = page.getByRole('region', {
      name: 'Choose declaration context',
    });
    await choices
      .getByRole('button', { name: 'projects/b/tsconfig.json', exact: true })
      .waitFor();
    assert.equal(
      await project.inputValue(),
      a,
      'ambiguous handoff does not silently switch projects',
    );
    await choices
      .getByRole('button', { name: 'projects/b/tsconfig.json', exact: true })
      .click();
    await root(page, 'target');
    assert.equal(await project.inputValue(), b);
    await page
      .getByRole('button', { name: 'View declaration evidence', exact: true })
      .click();
    await page
      .locator('#evidence pre')
      .getByText(/export function target/)
      .waitFor();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await root(page, 'entry');
    assert.equal(await project.inputValue(), a);
    assert.equal(
      await page.getByLabel('Direction', { exact: true }).inputValue(),
      'outgoing',
    );
    await page
      .locator('#evidence pre')
      .getByText('target()', { exact: true })
      .waitFor();
    await page.getByRole('button', { name: 'Forward', exact: true }).click();
    await root(page, 'target');
    assert.equal(await project.inputValue(), b);
    await page
      .locator('#evidence pre')
      .getByText(/export function target/)
      .waitFor();

    // Capture a completed old-context response and release it after a new context has a root.
    let release!: () => void, seen!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve)),
      captured = new Promise<void>((resolve) => (seen = resolve));
    let hold = true;
    await page.route('**/api/neighbors', async (route) => {
      const payload = route.request().postDataJSON() as { projectId: string };
      if (hold && payload.projectId === a) {
        hold = false;
        const response = await route.fetch();
        seen();
        await held;
        await route.fulfill({ response });
      } else await route.continue();
    });
    await project.selectOption(a);
    await search(page, 'entry');
    await page.locator('#symbol-results button').first().click();
    await Promise.race([
      captured,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('The stale response was not captured.')),
          10000,
        ),
      ),
    ]);
    let releaseProject!: () => void, projectSeen!: () => void;
    const projectGate = new Promise<void>(
        (resolve) => (releaseProject = resolve),
      ),
      projectCaptured = new Promise<void>((resolve) => (projectSeen = resolve));
    await page.route('**/api/session', async (route) => {
      const payload = route.request().postDataJSON() as { projectId: string };
      if (payload.projectId === c) {
        const response = await route.fetch();
        projectSeen();
        await projectGate;
        await route.fulfill({ response });
      } else await route.continue();
    });
    await project.selectOption(c);
    await Promise.race([
      projectCaptured,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('The project response was not captured.')),
          10000,
        ),
      ),
    ]);
    assert.equal(
      await page.getByRole('button', { name: 'Back' }).isDisabled(),
      true,
    );
    assert.equal(
      await page.getByRole('button', { name: 'Forward' }).isDisabled(),
      true,
    );
    releaseProject();
    await page.unroute('**/api/session');
    await search(page, 'target');
    const targetC = page.locator(
      `#symbol-results button[data-project-id="${c}"]`,
    );
    await targetC.click();
    await root(page, 'target');
    release();
    await page.waitForTimeout(150);
    assert.equal(await project.inputValue(), c);
    assert.equal(
      await page.locator('#root-symbol h3').innerText(),
      'function target',
    );
    assert.doesNotMatch(
      await page.locator('#relationships').innerText(),
      /Source: entry/,
    );
    await page.unroute('**/api/neighbors');

    await page.route('**/api/session', (route) => route.abort('failed'));
    await project.selectOption(a);
    await page
      .getByRole('alert')
      .getByText(/Failed to fetch/)
      .waitFor();
    assert.equal(
      await page.locator('#root-symbol h3').count(),
      0,
      'network failure clears the prior context graph',
    );
    await page.unroute('**/api/session');
    await page
      .getByRole('button', { name: 'Retry project', exact: true })
      .click();
    await waitForProjectSnapshot(page);
    await search(page, 'entry');
    await page.locator('#symbol-results button').first().click();
    await root(page, 'entry');
    assert.equal(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
      true,
      'narrow viewport remains usable',
    );
    assertLocalOnly(page);
    await page.context().close();
    process.stdout.write(
      'Repository browser navigation passed: separate contexts, explicit handoff choice, occurrence evidence, Back/Forward, stale responses, network recovery, keyboard and narrow viewport.\n',
    );
  } finally {
    await page?.context().close();
    await viewer.close();
    for (const path of directories)
      await rm(path, { recursive: true, force: true });
  }
}
