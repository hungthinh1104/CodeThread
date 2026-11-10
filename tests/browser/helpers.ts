import assert from 'node:assert/strict';
import type { Browser, Page } from 'playwright';

const crossOriginRequests = new WeakMap<Page, string[]>();

export async function openPage(
  browser: Browser,
  origin: string,
  url: string,
  firstFocus = 'symbol-query',
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
    firstFocus,
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

export function assertLocalOnly(page: Page): void {
  assert.deepEqual(
    crossOriginRequests.get(page),
    [],
    'the viewer must not request external browser resources',
  );
}

export async function selectByName(
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
