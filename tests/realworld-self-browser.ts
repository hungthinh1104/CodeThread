import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { chromium, type Locator, type Page } from 'playwright';
import { startInvestigationCli } from './helpers/investigation-cli.ts';
import { assertLocalOnly, openPage } from './browser/helpers.ts';

const pinnedCommit = '0fd2fc9169d091afa1c8e0bdb4697d13c22c9a05';
const productWorktreePath = process.cwd();
const commonGitDirectory = execFileSync(
  'git',
  ['rev-parse', '--path-format=absolute', '--git-common-dir'],
  { cwd: productWorktreePath, encoding: 'utf8', windowsHide: true },
).trim();
const repositoryPath = resolve(
  process.env.CT_REALWORLD_SELF_SOURCE_ROOT ?? dirname(commonGitDirectory),
);
const contextPath = 'packages/symbol-indexer/tsconfig.json';

type Anchor = { path: string; line: number; symbol?: string };

function git(args: string[], cwd = repositoryPath): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  }).trimEnd();
}

function pinnedBytes(path: string): Buffer {
  return execFileSync('git', ['show', `${pinnedCommit}:${path}`], {
    cwd: repositoryPath,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function hashAt(path: string): string {
  return sha256(pinnedBytes(path));
}

async function responseAfter(
  page: Page,
  pathname: string,
  action: () => Promise<unknown>,
): Promise<void> {
  const response = page.waitForResponse(
    (candidate) =>
      new URL(candidate.url()).pathname === pathname &&
      candidate.request().method() === 'POST',
    { timeout: 30000 },
  );
  await action();
  await response;
}

async function chooseContext(page: Page): Promise<void> {
  const select = page.getByLabel('Project context', { exact: true });
  const options = await select.locator('option').evaluateAll((items) =>
    items.map((item) => ({
      value: (item as HTMLOptionElement).value,
      label: item.textContent?.trim() ?? '',
      disabled: (item as HTMLOptionElement).disabled,
    })),
  );
  const matches = options.filter(
    (item) => item.label.startsWith(`${contextPath} (`) && !item.disabled,
  );
  assert.equal(
    matches.length,
    1,
    `one ready context must match ${contextPath}`,
  );
  if ((await select.inputValue()) !== matches[0]!.value)
    await responseAfter(page, '/api/session', () =>
      select.selectOption(matches[0]!.value),
    );
  await page.waitForFunction(
    (path) =>
      document.querySelector('#project-status')?.textContent?.includes(path),
    contextPath,
  );
}

async function chooseRoot(
  page: Page,
  anchor: Anchor & { symbol: string },
): Promise<void> {
  const search = page.getByLabel('Name or source path', { exact: true });
  const catalogResponse = page.waitForResponse(
    (candidate) => {
      if (
        new URL(candidate.url()).pathname !== '/api/catalog' ||
        candidate.request().method() !== 'POST'
      )
        return false;
      const body = candidate.request().postDataJSON() as {
        query?: string;
        offset?: number;
      };
      return body.query === anchor.symbol && body.offset === 0;
    },
    { timeout: 30000 },
  );
  await search.fill(anchor.symbol);
  await search.press('Enter');
  await catalogResponse;
  const candidates = page
    .locator('#symbol-results button.symbol-choice')
    .filter({ hasText: `${anchor.path}@${anchor.line}:` })
    .filter({ hasText: contextPath });
  const candidateCount = await candidates.count();
  assert.equal(
    candidateCount,
    1,
    `one catalog result for ${anchor.symbol}; status=${await page.locator('#project-status').innerText()}; results=${JSON.stringify(await page.locator('#symbol-results').innerText())}`,
  );
  if ((await candidates.getAttribute('aria-current')) !== 'true') {
    const graphResponse = page.waitForResponse(
      (candidate) =>
        new URL(candidate.url()).pathname === '/api/neighbors' &&
        candidate.request().method() === 'POST',
      { timeout: 30000 },
    );
    await candidates.click();
    await graphResponse;
  }
  await page.waitForFunction(
    (name) =>
      document.querySelector('#root-symbol h3')?.textContent?.includes(name),
    anchor.symbol,
  );
}

async function readEvidence(page: Page, button: Locator): Promise<string> {
  const response = page.waitForResponse(
    (candidate) =>
      new URL(candidate.url()).pathname === '/api/evidence' &&
      candidate.request().method() === 'POST',
    { timeout: 30000 },
  );
  await button.click();
  await response;
  const panel = page.locator('#evidence');
  await panel.locator('pre').waitFor();
  return await panel.innerText();
}

async function rootEvidence(page: Page, anchor: Anchor): Promise<string> {
  const evidence = await readEvidence(
    page,
    page.locator('#root-symbol').getByRole('button', {
      name: 'View declaration evidence',
      exact: true,
    }),
  );
  assert.ok(evidence.includes(`${anchor.path}@${anchor.line}:`));
  assert.ok(evidence.includes(hashAt(anchor.path)));
  return evidence;
}

function assertPinnedLocator(path: string, query: string): string {
  const result = git([
    'grep',
    '-n',
    '-F',
    '-e',
    query,
    pinnedCommit,
    '--',
    path,
  ]);
  assert.ok(result, `pinned Git locator must find ${query} in ${path}`);
  return result;
}

async function main(): Promise<void> {
  assert.equal(
    git(['rev-parse', '--verify', `${pinnedCommit}^{commit}`]),
    pinnedCommit,
  );
  const status = git(['status', '--short'], productWorktreePath)
    .split(/\r?\n/)
    .filter(Boolean);
  const tree = git(['ls-tree', '-r', '--long', '--full-tree', pinnedCommit]);
  const sourceRows = tree.split(/\r?\n/).flatMap((row) => {
    const [header, path] = row.split('\t');
    const [mode, type, , size] = (header ?? '').split(/\s+/);
    return (mode === '100644' || mode === '100755') &&
      type === 'blob' &&
      path?.endsWith('.ts')
      ? [{ path, bytes: Number(size) }]
      : [];
  });
  const sourceBytes = sourceRows.reduce((total, item) => total + item.bytes, 0);
  assert.ok(
    sourceRows.length <= 1000,
    'pinned CodeThread .ts inventory fits file limit',
  );
  assert.ok(
    sourceBytes <= 32 * 1024 * 1024,
    'pinned CodeThread .ts inventory fits byte limit',
  );

  const browser = await chromium.launch({ headless: true });
  const startedAt = new Date().toISOString();
  const cli = startInvestigationCli(
    [
      '--repo',
      repositoryPath,
      '--revision',
      pinnedCommit,
      '--repository-id',
      randomUUID(),
      '--scope',
      'repository',
      '--view',
    ],
    { deadlineMs: 600000 },
  );
  cli.child.stdin.end();
  let page: Page | undefined;
  const tasks: unknown[] = [];
  try {
    const cliStarted = performance.now();
    const outputMatch = await cli.waitFor(
      /CodeThread local visual investigation: (http:\/\/127\.0\.0\.1:\d+\/#([a-f0-9]{64}))/,
      360000,
    );
    const cliAnalysisAndViewerStartupMs = Math.round(
      performance.now() - cliStarted,
    );
    const url = outputMatch[1]!;
    page = await openPage(browser, new URL(url).origin, url, 'project-select');
    const summary = await page.locator('#repository-summary').innerText();
    assert.ok(summary.includes(`Pinned commit ${pinnedCommit}`));
    assert.ok(summary.includes(`${sourceRows.length} regular .ts files`));
    assert.ok(/Inventory complete=true/.test(summary));
    assert.ok(/source analyzed=true/.test(summary));

    const taskOneStarted = performance.now();
    await chooseContext(page);
    const analyzeManifest = {
      symbol: 'analyzeManifest',
      path: 'packages/symbol-indexer/src/manifest.ts',
      line: 28,
    };
    await chooseRoot(page, analyzeManifest);
    const declaration = await rootEvidence(page, analyzeManifest);
    const publicExport = assertPinnedLocator(
      'packages/symbol-indexer/src/index.ts',
      'export { analyzeManifest } from',
    );
    const focusedTest = assertPinnedLocator(
      'tests/semantic-manifest.test.ts',
      'analyzeManifest',
    );
    tasks.push({
      id: 'codethread-01-analyze-manifest-navigation',
      workflowComplete: true,
      selectedContext: contextPath,
      implementation: {
        ...analyzeManifest,
        evidenceOpened: true,
        evidenceSha256: hashAt(analyzeManifest.path),
        visibleEvidenceMatchesPinnedBytes: declaration.includes(
          hashAt(analyzeManifest.path),
        ),
      },
      publicExport,
      focusedTest,
      durationMs: Math.round(performance.now() - taskOneStarted),
    });

    const taskTwoStarted = performance.now();
    await chooseContext(page);
    const analyzeProject = {
      symbol: 'analyzeProject',
      path: 'packages/symbol-indexer/src/project.ts',
      line: 7,
    };
    const planRepositoryProjects = {
      symbol: 'planRepositoryProjects',
      path: 'packages/symbol-indexer/src/project-plan.ts',
      line: 18,
    };
    await chooseRoot(page, analyzeProject);
    await rootEvidence(page, analyzeProject);
    const direction = page.getByLabel('Direction', { exact: true });
    if ((await direction.inputValue()) !== 'outgoing')
      await responseAfter(page, '/api/neighbors', () =>
        direction.selectOption('outgoing'),
      );
    const rows = page.locator(
      '#relationships .relationship-item[data-relation-id]',
    );
    const matches: Locator[] = [];
    for (const row of await rows.all()) {
      const text = await row.innerText();
      if (
        text.includes(
          `Source: ${analyzeProject.symbol} (${analyzeProject.path}@${analyzeProject.line}:`,
        ) &&
        text.includes(`Target: ${planRepositoryProjects.symbol} (`) &&
        text.includes(
          `${planRepositoryProjects.path}@${planRepositoryProjects.line}:`,
        )
      )
        matches.push(row);
    }
    assert.equal(
      matches.length,
      1,
      'one exact project-planning call must be visible',
    );
    const callSite = await readEvidence(
      page,
      matches[0]!.getByRole('button', {
        name: 'View occurrence evidence',
        exact: true,
      }),
    );
    assert.ok(callSite.includes(`${analyzeProject.path}@31:`));
    assert.ok(callSite.includes(hashAt(analyzeProject.path)));
    const targetDeclaration = await readEvidence(
      page,
      matches[0]!.getByRole('button', {
        name: `View ${planRepositoryProjects.symbol} declaration evidence`,
        exact: true,
      }),
    );
    assert.ok(targetDeclaration.includes(`${planRepositoryProjects.path}@18:`));
    assert.ok(targetDeclaration.includes(hashAt(planRepositoryProjects.path)));
    const projectPlanExport = assertPinnedLocator(
      'packages/symbol-indexer/src/index.ts',
      "export { planRepositoryProjects } from './project-plan.js';",
    );
    const projectPlanTest = assertPinnedLocator(
      'tests/repository-projects.test.ts',
      'planRepositoryProjects',
    );
    tasks.push({
      id: 'codethread-02-project-context-navigation',
      workflowComplete: true,
      selectedContext: contextPath,
      source: analyzeProject,
      callSite: {
        path: analyzeProject.path,
        line: 31,
        evidenceSha256: hashAt(analyzeProject.path),
        visibleEvidenceMatchesPinnedBytes: callSite.includes(
          hashAt(analyzeProject.path),
        ),
      },
      target: {
        ...planRepositoryProjects,
        evidenceSha256: hashAt(planRepositoryProjects.path),
        visibleEvidenceMatchesPinnedBytes: targetDeclaration.includes(
          hashAt(planRepositoryProjects.path),
        ),
      },
      packageExport: projectPlanExport,
      focusedTest: projectPlanTest,
      durationMs: Math.round(performance.now() - taskTwoStarted),
    });
    assertLocalOnly(page);

    const cliResult = await (async () => {
      await cli.stop();
      return await cli.result;
    })();
    assert.equal(
      cliResult.code,
      null,
      'viewer server is stopped by the harness',
    );
    const result = {
      format: 'codethread-ct-realworld-001-self-browser-v1',
      method:
        'scripted Playwright self-repository workflows; excluded from external semantic score',
      startedAt,
      finishedAt: new Date().toISOString(),
      testedProductHeadSha: git(['rev-parse', 'HEAD'], productWorktreePath),
      workingTreeClean: status.length === 0,
      workingTreeStatus: status,
      analyzedCommit: pinnedCommit,
      selectedContext: contextPath,
      regularTsFileCount: sourceRows.length,
      regularTsBytes: sourceBytes,
      inventoryComplete: /Inventory complete=true/.test(summary),
      sourceCoverageComplete: /source analyzed=true/.test(summary),
      analysisComplete: /projects finished=true/.test(summary),
      contextComplete: /compiler\/type context complete=true/.test(summary),
      cliAnalysisAndViewerStartupMs,
      cliServerStoppedByHarness: true,
      staticEvidenceDoesNotAssertExecution: true,
      tasks,
    };
    const serialized = `${JSON.stringify(result, null, 2)}\n`;
    process.stdout.write(serialized);
    if (process.env.CT_REALWORLD_OUTPUT_PATH)
      await writeFile(
        resolve(process.env.CT_REALWORLD_OUTPUT_PATH),
        serialized,
        'utf8',
      );
    if (
      tasks.length !== 2 ||
      tasks.some(
        (task) => !(task as { workflowComplete: boolean }).workflowComplete,
      )
    )
      process.exitCode = 1;
  } finally {
    await page?.context().close();
    await cli.stop().catch(() => undefined);
    await browser.close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
