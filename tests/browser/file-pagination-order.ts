import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import type { Browser, Page, Response } from 'playwright';
import { createRepositoryViewer } from '../../scripts/viewer.ts';
import { repositoryViewerFixture } from '../helpers/repository-viewer.ts';
import { openPage } from './helpers.ts';

function fileOffset(response: Response): number | null {
  const request = response.request();
  if (
    request.method() !== 'POST' ||
    new URL(response.url()).pathname !== '/api/files'
  )
    return null;
  try {
    const body = request.postDataJSON() as {
      offset?: unknown;
      request?: { offset?: unknown };
    };
    const offset = body.request?.offset ?? body.offset;
    return typeof offset === 'number' ? offset : null;
  } catch {
    return null;
  }
}

export async function verifyFilePaginationOrdering(browser: Browser) {
  const directories: string[] = [];
  let viewer: Awaited<ReturnType<typeof createRepositoryViewer>> | undefined;
  let page: Page | undefined;
  let releaseStaleResponse = () => {};
  try {
    const additions = Array.from({ length: 105 }, (_, index) => ({
      path: `zzz-generated-${String(index).padStart(3, '0')}.ts`,
      source: `export const generated${index} = ${index};`,
    }));
    const { session } = await repositoryViewerFixture(directories, additions);
    viewer = await createRepositoryViewer(session);
    page = await openPage(browser, viewer.origin, viewer.url, 'project-select');
    await page
      .getByText('Source inventory and project diagnostics', { exact: true })
      .click();
    await page.waitForFunction(() =>
      document
        .querySelector('#source-files')
        ?.textContent?.includes('Showing 1–50'),
    );
    await page.getByRole('button', { name: 'Next files', exact: true }).click();
    await page.waitForFunction(() =>
      document
        .querySelector('#source-files')
        ?.textContent?.includes('Showing 51–100'),
    );

    let captureStale!: () => void;
    const staleCaptured = new Promise<void>((resolve) => {
      captureStale = resolve;
    });
    const staleResponseGate = new Promise<void>((resolve) => {
      releaseStaleResponse = resolve;
    });
    let delayed = false;
    await page.route('**/api/files', async (route) => {
      const body = route.request().postDataJSON() as {
        offset?: number;
        request?: { offset?: number };
      };
      if (!delayed && (body.request?.offset ?? body.offset) === 0) {
        delayed = true;
        const response = await route.fetch();
        captureStale();
        await staleResponseGate;
        await route.fulfill({ response });
      } else await route.continue();
    });

    await page
      .getByRole('button', { name: 'Previous files', exact: true })
      .click();
    await Promise.race([
      staleCaptured,
      new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error('The delayed offset 0 response was not captured.'),
            ),
          10000,
        ),
      ),
    ]);
    await page.getByRole('button', { name: 'Next files', exact: true }).click();
    await page.waitForFunction(() =>
      document
        .querySelector('#source-files')
        ?.textContent?.includes('Showing 101–'),
    );
    const newestPage = await page.locator('#source-files').innerText();

    const staleResponse = page.waitForResponse(
      (response) => fileOffset(response) === 0,
    );
    releaseStaleResponse();
    await staleResponse;
    const finalPage = await page.locator('#source-files').innerText();
    assert.ok(
      finalPage.includes('Showing 101–'),
      `The latest page must remain visible after an older response completes. Before: ${newestPage}\nAfter: ${finalPage}`,
    );
    await page.unroute('**/api/files');
  } finally {
    releaseStaleResponse?.();
    await page?.context().close();
    await viewer?.close();
    for (const directory of directories)
      await rm(directory, { recursive: true, force: true });
  }
}
