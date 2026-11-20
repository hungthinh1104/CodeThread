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
  const baseline = process.argv[3] === 'before';
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), 'ct-workspace-zoom-'),
  );
  const extensionDirectory = join(temporaryDirectory, 'extension');
  const artifactPath = resolve(
    process.argv[2] ?? 'artifacts/ct-workspace-001b/next-app',
    '1440-actual-200-percent-light-selected-evidence.png',
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
        channel: 'chromium',
        headless: true,
        viewport: { width: 1440, height: 900 },
        args: [
          `--disable-extensions-except=${extensionDirectory}`,
          `--load-extension=${extensionDirectory}`,
        ],
      },
    );
    const outside: string[] = [];
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== app.origin) {
        outside.push(url.origin);
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });
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
    const inspector = page.locator('#evidence-inspector');
    await page
      .getByRole('button', { name: 'Inspect evidence', exact: true })
      .press('Enter');
    await page.evaluate(
      () => new Promise<void>((ready) => requestAnimationFrame(() => ready())),
    );
    const openedFromAction = await inspector.isVisible();
    if (baseline && !openedFromAction)
      await page.getByRole('button', { name: 'Evidence', exact: true }).click();
    else
      assert.equal(
        openedFromAction,
        true,
        'the evidence action opens the drawer at actual 200% browser zoom',
      );
    await inspector.waitFor({ state: 'visible' });
    await inspector.locator('.evidence-card').waitFor();

    const layout = await page.evaluate(() => {
      const panel = document.getElementById('evidence-inspector');
      if (!panel) throw new Error('Evidence inspector is missing.');
      const bounds = panel.getBoundingClientRect();
      return {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        documentWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        visualViewportScale: window.visualViewport?.scale,
        panel: {
          left: bounds.left,
          right: bounds.right,
          top: bounds.top,
          bottom: bounds.bottom,
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
    assert.ok(
      layout.panel.top >= 0 && layout.panel.bottom <= layout.innerHeight,
      JSON.stringify(layout),
    );
    assert.deepEqual(outside, [], 'zoom uses the fixture origin only');
    await page.evaluate(async () => {
      document.querySelector('nextjs-portal')?.setAttribute('hidden', '');
      await document.fonts.ready;
      await new Promise<void>((resolvePaint) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => resolvePaint()),
        );
      });
    });
    // A viewport clip calculated in CSS pixels can target the wrong area at tab zoom.
    const cdp = await context.newCDPSession(page);
    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
    await cdp.detach();
    const sampledColors = await page.evaluate(async (encoded) => {
      const bytes = Uint8Array.from(atob(encoded), (character) =>
        character.charCodeAt(0),
      );
      const image = await createImageBitmap(
        new Blob([bytes], { type: 'image/png' }),
      );
      const canvas = new OffscreenCanvas(16, 10);
      const draw = canvas.getContext('2d')!;
      draw.drawImage(image, 0, 0, canvas.width, canvas.height);
      const pixels = draw.getImageData(0, 0, canvas.width, canvas.height).data;
      const colors = new Set<number>();
      for (let offset = 0; offset < pixels.length; offset += 4)
        colors.add(
          (pixels[offset]! << 16) |
            (pixels[offset + 1]! << 8) |
            pixels[offset + 2]!,
        );
      image.close();
      return colors.size;
    }, data);
    assert.ok(
      sampledColors >= 4,
      'the zoom screenshot contains a painted viewport',
    );
    await writeFile(artifactPath, Buffer.from(data, 'base64'));
    const metrics = JSON.stringify({
      zoom,
      initialWidth,
      openedFromAction,
      sampledColors,
      ...layout,
    });
    await writeFile(
      join(dirname(artifactPath), 'workspace-zoom.json'),
      `${metrics}\n`,
    );
    process.stdout.write(`${metrics}\n`);
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
