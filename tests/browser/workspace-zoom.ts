import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { chromium, type BrowserContext } from 'playwright';
import { analyzeManifest, COMPILER_PROFILE } from '@codethread/symbol-indexer';
import { startWorkspaceApp } from './workspace-app.ts';

type ChromeZoomApi = {
  tabs: {
    getZoom(tabId: number): Promise<number>;
    query(query: {
      active: boolean;
      lastFocusedWindow: boolean;
    }): Promise<Array<{ id?: number }>>;
    setZoom(tabId: number, zoom: number): Promise<void>;
  };
};

async function main(): Promise<void> {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), 'ct-workspace-zoom-'),
  );
  const extensionDirectory = join(temporaryDirectory, 'extension');
  const artifactPath = resolve(
    'artifacts/ct-workspace-001b/next-app/1440-actual-200-percent-light-selected-evidence.png',
  );
  await mkdir(extensionDirectory);
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(
    join(extensionDirectory, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'Temporary Workspace Zoom Verifier',
      version: '1.0',
      permissions: ['tabs'],
      background: { service_worker: 'service-worker.js' },
    }),
  );
  await writeFile(join(extensionDirectory, 'service-worker.js'), '');

  const repositoryId = '22222222-2222-4222-8222-222222222222';
  const source = Buffer.from('export function root() { return 1; }');
  const snapshot = await analyzeManifest({
    repositoryId,
    compilerOptions: COMPILER_PROFILE,
    files: [
      {
        path: 'src/root.ts',
        bytes: source,
        sha256: createHash('sha256').update(source).digest('hex'),
      },
    ],
  });

  const app = await startWorkspaceApp(snapshot);
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(
      join(temporaryDirectory, 'profile'),
      {
        headless: false,
        viewport: { width: 1440, height: 900 },
        args: [
          `--disable-extensions-except=${extensionDirectory}`,
          `--load-extension=${extensionDirectory}`,
        ],
      },
    );
    const serviceWorkerEvent = context
      .waitForEvent('serviceworker', { timeout: 10_000 })
      .catch(() => undefined);
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(app.origin, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Repository and scan').selectOption(repositoryId);
    await page.waitForFunction(
      () =>
        !document.querySelector<HTMLInputElement>('#symbol-query')?.disabled,
    );
    await page.getByLabel('Name or source path').fill('root');
    await page.getByRole('button', { name: /root.*function/ }).click();
    await page.locator('.source-excerpt').waitFor();

    const serviceWorker =
      context
        .serviceWorkers()
        .find((worker) => worker.url().startsWith('chrome-extension://')) ??
      (await serviceWorkerEvent);
    if (!serviceWorker?.url().startsWith('chrome-extension://'))
      throw new Error('The temporary Chrome zoom extension must be active.');
    const initialWidth = await page.evaluate(() => window.innerWidth);
    assert.ok(
      initialWidth >= 1300,
      `Expected desktop width, got ${initialWidth}.`,
    );
    const zoom = await serviceWorker.evaluate(async () => {
      const chromeApi = (globalThis as unknown as { chrome: ChromeZoomApi })
        .chrome;
      const [tab] = await chromeApi.tabs.query({
        active: true,
        lastFocusedWindow: true,
      });
      if (tab?.id === undefined)
        throw new Error('Chromium must expose the active tab id.');
      await chromeApi.tabs.setZoom(tab.id, 2);
      return chromeApi.tabs.getZoom(tab.id);
    });
    assert.equal(zoom, 2, 'Chromium tab zoom must be exactly 200%.');
    await page.waitForFunction(() => window.innerWidth <= 760);
    await page.getByRole('button', { name: 'Evidence', exact: true }).click();
    const inspector = page.locator('#evidence-inspector');
    await inspector.waitFor({ state: 'visible' });

    const layout = await page.evaluate(() => {
      const panel = document.getElementById('evidence-inspector');
      if (!panel) throw new Error('Evidence inspector is missing.');
      const bounds = panel.getBoundingClientRect();
      return {
        innerWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        visualViewportScale: window.visualViewport?.scale,
        panel: {
          left: bounds.left,
          right: bounds.right,
          width: bounds.width,
        },
      };
    });
    assert.ok(
      layout.innerWidth >= 680 && layout.innerWidth <= 760,
      JSON.stringify(layout),
    );
    assert.equal(
      layout.visualViewportScale,
      1,
      'Pinch zoom must remain unchanged.',
    );
    assert.ok(
      layout.documentWidth <= layout.clientWidth,
      JSON.stringify(layout),
    );
    assert.ok(layout.panel.left >= 0, JSON.stringify(layout));
    assert.ok(layout.panel.right <= layout.clientWidth, JSON.stringify(layout));
    await page.screenshot({
      path: artifactPath,
      fullPage: true,
      animations: 'disabled',
    });
    process.stdout.write(
      `${JSON.stringify({ zoom, initialWidth, ...layout, artifactPath })}\n`,
    );
  } finally {
    await context?.close();
    await app.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : 'Workspace zoom verification failed.'}\n`,
  );
  process.exitCode = 1;
});
