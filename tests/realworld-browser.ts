import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, type Locator, type Page } from 'playwright';
import { startInvestigationCli } from './helpers/investigation-cli.ts';
import { assertLocalOnly, openPage } from './browser/helpers.ts';

type Anchor = { path: string; symbol: string; declarationLine: number };
type Label = {
  id: string;
  family: 'CALLS' | 'REFERENCES';
  expected: 'exact' | 'non_exact' | 'no_exact_relation';
  source?: Anchor;
  sourceCandidate?: Anchor;
  outerFunction?: Anchor;
  target?: Anchor;
  targetCandidate?: Anchor;
  targetName?: string;
  siteLine: number;
};
type Task = { id: string; repository: string; prompt: string; labels: Label[] };
type Repository = {
  key: string;
  commit: string;
  inventory: { regularTsFiles: number; regularTsBytes: number };
  sourceFiles: { path: string; sha256: string }[];
};

const contexts: Record<string, string> = {
  hono: 'tsconfig.build.json',
  zod: 'packages/zod/tsconfig.build.json',
  pinia: 'tsconfig.json',
};

function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function gitCommit(repositoryPath: string, revision: string): string {
  return execFileSync(
    'git',
    ['-C', repositoryPath, 'rev-parse', '--verify', `${revision}^{commit}`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

function sourceOf(label: Label): Anchor {
  return label.source ?? label.sourceCandidate ?? label.outerFunction!;
}

function sourceHash(repository: Repository, path: string): string {
  const file = repository.sourceFiles.find((item) => item.path === path);
  assert.ok(file, `the frozen source manifest must include ${path}`);
  return file.sha256;
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

async function chooseContext(page: Page, configPath: string): Promise<void> {
  const project = page.getByLabel('Project context', { exact: true });
  const options = await project.locator('option').evaluateAll((items) =>
    items.map((item) => ({
      value: (item as HTMLOptionElement).value,
      label: item.textContent?.trim() ?? '',
      disabled: (item as HTMLOptionElement).disabled,
    })),
  );
  const matches = options.filter(
    (item) => item.label.startsWith(`${configPath} (`) && !item.disabled,
  );
  assert.equal(matches.length, 1, `one ready context must match ${configPath}`);
  if ((await project.inputValue()) !== matches[0]!.value)
    await responseAfter(page, '/api/session', () =>
      project.selectOption(matches[0]!.value),
    );
  await page.waitForFunction(
    (path) =>
      document.querySelector('#project-status')?.textContent?.includes(path),
    configPath,
  );
}

async function chooseRoot(page: Page, owner: Anchor, configPath: string) {
  const search = page.getByLabel('Name or source path', { exact: true });
  await responseAfter(page, '/api/catalog', async () => {
    await search.fill(owner.symbol);
    await search.press('Enter');
  });
  const candidates = page
    .locator('#symbol-results button.symbol-choice')
    .filter({ hasText: `${owner.path}@${owner.declarationLine}:` })
    .filter({ hasText: configPath });
  assert.equal(
    await candidates.count(),
    1,
    `one catalog row must match ${owner.symbol} at ${owner.path}:${owner.declarationLine} in ${configPath}`,
  );
  if ((await candidates.getAttribute('aria-current')) === 'true') return;
  const graphResponse = page.waitForResponse(
    (candidate) =>
      new URL(candidate.url()).pathname === '/api/neighbors' &&
      candidate.request().method() === 'POST',
    { timeout: 30000 },
  );
  await candidates.click();
  await graphResponse;
  await page.waitForFunction(
    (name) =>
      document.querySelector('#root-symbol h3')?.textContent?.includes(name),
    owner.symbol,
  );
}

async function selectProjection(
  page: Page,
  family: Label['family'],
): Promise<void> {
  const wanted = family.toLowerCase();
  const calls = page.locator('input[name="kind"][value="calls"]');
  const references = page.locator('input[name="kind"][value="references"]');
  const add = wanted === 'calls' ? calls : references;
  const remove = wanted === 'calls' ? references : calls;
  if (!(await add.isChecked()))
    await responseAfter(page, '/api/neighbors', () => add.check());
  if (await remove.isChecked())
    await responseAfter(page, '/api/neighbors', () => remove.uncheck());
  const direction = page.getByLabel('Direction', { exact: true });
  if ((await direction.inputValue()) !== 'outgoing')
    await responseAfter(page, '/api/neighbors', () =>
      direction.selectOption('outgoing'),
    );
  await page.waitForFunction(
    () =>
      !document
        .querySelector('#investigation-status')
        ?.textContent?.includes('Loading bounded'),
  );
}

async function readEvidence(page: Page, button: Locator): Promise<string> {
  const response = page.waitForResponse(
    (candidate) =>
      new URL(candidate.url()).pathname === '/api/evidence' &&
      candidate.request().method() === 'POST',
  );
  await button.click();
  await response;
  const panel = page.locator('#evidence');
  await panel.locator('pre').waitFor();
  return await panel.innerText();
}

function evidenceAtSite(text: string, path: string, line: number): boolean {
  return text.includes(`${path}@${line}:`);
}

async function readRootEvidence(
  page: Page,
  expectedPath: string,
  line: number,
) {
  const button = page
    .locator('#root-symbol')
    .getByRole('button', { name: 'View declaration evidence', exact: true });
  const text = await readEvidence(page, button);
  assert.ok(
    text.includes(`${expectedPath}@${line}:`),
    `root declaration evidence must be pinned at ${expectedPath}:${line}; visible header: ${JSON.stringify(text.slice(0, 320))}`,
  );
  return text;
}

async function inspectLabel(
  page: Page,
  repository: Repository,
  task: Task,
  label: Label,
  configPath: string,
) {
  const started = performance.now();
  const owner = sourceOf(label);
  await chooseContext(page, configPath);
  await chooseRoot(page, owner, configPath);
  await selectProjection(page, label.family);
  const rows = page.locator(
    '#relationships .relationship-item[data-relation-id]',
  );
  const relationRows = await rows.all();
  const sourcePrefix = `Source: ${owner.symbol} (${owner.path}@${owner.declarationLine}:`;

  if (label.expected === 'exact') {
    const target = label.target!;
    const matching: { row: Locator; site: string }[] = [];
    for (const row of relationRows) {
      const rowText = await row.innerText();
      if (
        !rowText.includes(sourcePrefix) ||
        !rowText.includes(`Target: ${target.symbol} (`) ||
        !rowText.includes(`${target.path}@${target.declarationLine}:`)
      )
        continue;
      const site = await readEvidence(
        page,
        row.getByRole('button', {
          name: 'View occurrence evidence',
          exact: true,
        }),
      );
      if (evidenceAtSite(site, owner.path, label.siteLine)) {
        assert.ok(
          site.includes(sourceHash(repository, owner.path)),
          `call-site evidence hash must match pinned source bytes for ${label.id}`,
        );
        matching.push({ row, site });
      }
    }
    if (matching.length !== 1) {
      const root = await readRootEvidence(
        page,
        owner.path,
        owner.declarationLine,
      );
      assert.ok(
        root.includes(sourceHash(repository, owner.path)),
        `source evidence hash must match frozen bytes for ${label.id}`,
      );
      return {
        id: label.id,
        expected: label.expected,
        observed: matching.length === 0 ? 'missing-exact' : 'duplicate-exact',
        source: `${owner.path}:${owner.declarationLine}`,
        target: `${target.path}:${target.declarationLine}`,
        site: `${owner.path}:${label.siteLine}`,
        evidenceSha256: sourceHash(repository, owner.path),
        durationMs: Math.round(performance.now() - started),
        workflowComplete: false,
      };
    }
    const { row } = matching[0]!;
    const targetIsRoot =
      target.path === owner.path &&
      target.declarationLine === owner.declarationLine;
    const declarationButton = targetIsRoot
      ? page.locator('#root-symbol').getByRole('button', {
          name: 'View declaration evidence',
          exact: true,
        })
      : row.getByRole('button', {
          name: `View ${target.symbol} declaration evidence`,
          exact: true,
        });
    const declaration = await readEvidence(page, declarationButton);
    assert.ok(
      declaration.includes(`${target.path}@${target.declarationLine}:`),
      `target declaration evidence must match ${label.id}`,
    );
    assert.ok(
      declaration.includes(sourceHash(repository, target.path)),
      `target evidence hash must match pinned source bytes for ${label.id}`,
    );
    return {
      id: label.id,
      expected: label.expected,
      observed: 'exact',
      source: `${owner.path}:${owner.declarationLine}`,
      target: `${target.path}:${target.declarationLine}`,
      site: `${owner.path}:${label.siteLine}`,
      evidenceSha256: sourceHash(repository, owner.path),
      targetEvidenceSha256: sourceHash(repository, target.path),
      durationMs: Math.round(performance.now() - started),
      workflowComplete: true,
    };
  }

  const requestedTarget =
    label.targetName ?? label.targetCandidate?.symbol ?? '';
  let exactAtLabeledSite = false;
  for (const row of relationRows) {
    const rowText = await row.innerText();
    if (
      !rowText.includes(sourcePrefix) ||
      (requestedTarget && !rowText.includes(`Target: ${requestedTarget} (`))
    )
      continue;
    const site = await readEvidence(
      page,
      row.getByRole('button', {
        name: 'View occurrence evidence',
        exact: true,
      }),
    );
    if (evidenceAtSite(site, owner.path, label.siteLine))
      exactAtLabeledSite = true;
  }
  let uncertainEvidenceAtSite = false;
  const unknownRows = await page.locator('#unknowns .relationship-item').all();
  for (const row of unknownRows) {
    const button = row.getByRole('button', {
      name: 'View uncertain site evidence',
      exact: true,
    });
    if ((await button.count()) === 0) continue;
    const evidence = await readEvidence(page, button);
    if (evidenceAtSite(evidence, owner.path, label.siteLine)) {
      assert.ok(
        evidence.includes(sourceHash(repository, owner.path)),
        `uncertain evidence hash must match pinned bytes for ${label.id}`,
      );
      uncertainEvidenceAtSite = true;
    }
  }
  if (!uncertainEvidenceAtSite) {
    const evidence = await readRootEvidence(
      page,
      owner.path,
      owner.declarationLine,
    );
    assert.ok(
      evidence.includes(sourceHash(repository, owner.path)),
      `source declaration hash must match pinned bytes for ${label.id}`,
    );
  }
  return {
    id: label.id,
    expected: label.expected,
    observed: exactAtLabeledSite
      ? 'wrong-exact'
      : uncertainEvidenceAtSite
        ? 'uncertain-site-preserved'
        : 'no-exact-relation-visible',
    source: `${owner.path}:${owner.declarationLine}`,
    target: requestedTarget || undefined,
    site: `${owner.path}:${label.siteLine}`,
    evidenceSha256: sourceHash(repository, owner.path),
    durationMs: Math.round(performance.now() - started),
    workflowComplete: true,
  };
}

async function main(): Promise<void> {
  const tasksBytes = await readFile(
    'docs/evaluation/ct-realworld-001/tasks.json',
  );
  const repositoriesBytes = await readFile(
    'docs/evaluation/ct-realworld-001/repositories.json',
  );
  const taskBank = JSON.parse(tasksBytes.toString('utf8')) as {
    tasks: Task[];
  };
  const repositoryBank = JSON.parse(repositoriesBytes.toString('utf8')) as {
    externalRepositories: Repository[];
  };
  const workingTreeStatus = execFileSync('git', ['status', '--short'], {
    encoding: 'utf8',
  })
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  const requestedRepositories = process.env.CT_REALWORLD_REPOSITORIES?.split(
    ',',
  )
    .map((key) => key.trim())
    .filter(Boolean);
  const repositories = requestedRepositories
    ? repositoryBank.externalRepositories.filter((repository) =>
        requestedRepositories.includes(repository.key),
      )
    : repositoryBank.externalRepositories;
  assert.ok(repositories.length > 0, 'select at least one known repository');
  assert.deepEqual(
    repositories.map((repository) => repository.key).sort(),
    [...(requestedRepositories ?? repositories.map((item) => item.key))].sort(),
    'every requested repository key must be known',
  );
  const sourceRoot = resolve(
    process.env.CT_REALWORLD_SOURCE_ROOT ??
      resolve(process.cwd(), '..', 'ct-realworld-sources'),
  );
  const browser = await chromium.launch({ headless: true });
  const output = {
    format: 'codethread-ct-realworld-001-browser-run-v1',
    testedProductHeadSha: execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim(),
    harnessWorkingTreeClean: workingTreeStatus.length === 0,
    harnessWorkingTreeStatus: workingTreeStatus,
    taskBankSha256: hash(tasksBytes),
    repositoryManifestSha256: hash(repositoriesBytes),
    method: 'scripted Playwright workflow against the local CLI viewer',
    independentlyReviewedGold: false,
    scopeRepositories: repositories.map((repository) => repository.key),
    repositories: [] as unknown[],
  };
  try {
    for (const repository of repositories) {
      const repositoryPath = resolve(sourceRoot, repository.key);
      const actualCommit = gitCommit(repositoryPath, repository.commit);
      assert.equal(actualCommit, repository.commit);
      const configPath = contexts[repository.key];
      assert.ok(
        configPath,
        `no selected project context for ${repository.key}`,
      );
      const repoTasks = taskBank.tasks.filter(
        (task) => task.repository === repository.key,
      );
      const repositoryStartedAt = new Date().toISOString();
      const cli = startInvestigationCli(
        [
          '--repo',
          repositoryPath,
          '--revision',
          repository.commit,
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
      try {
        const cliStartedAt = performance.now();
        const outputMatch = await cli.waitFor(
          /CodeThread local visual investigation: (http:\/\/127\.0\.0\.1:\d+\/#[a-f0-9]{64})/,
          360000,
        );
        const cliAnalysisAndViewerStartupMs = Math.round(
          performance.now() - cliStartedAt,
        );
        const url = outputMatch[1]!;
        page = await openPage(
          browser,
          new URL(url).origin,
          url,
          'project-select',
        );
        const summary = await page.locator('#repository-summary').innerText();
        assert.ok(summary.includes(`Pinned commit ${repository.commit}`));
        assert.ok(
          summary.includes(
            `${repository.inventory.regularTsFiles} regular .ts files`,
          ),
        );
        const viewerReadyAt = performance.now();
        await chooseContext(page, configPath);
        const taskResults = [] as unknown[];
        for (const task of repoTasks) {
          const startedAt = new Date().toISOString();
          const taskStartedAt = performance.now();
          const labelResults = [];
          for (const label of task.labels) {
            process.stderr.write(`Browser task ${task.id} / ${label.id}\n`);
            labelResults.push(
              await inspectLabel(page, repository, task, label, configPath),
            );
          }
          taskResults.push({
            id: task.id,
            startedAt,
            durationMs: Math.round(performance.now() - taskStartedAt),
            completed: labelResults.every(
              (label) =>
                (label as { workflowComplete: boolean }).workflowComplete,
            ),
            labels: labelResults,
          });
        }
        assertLocalOnly(page);
        const browserWorkflowMs = Math.round(performance.now() - viewerReadyAt);
        await cli.stop();
        const cliResult = await cli.result;
        assert.equal(cliResult.code, null);
        output.repositories.push({
          key: repository.key,
          commit: repository.commit,
          taskCount: repoTasks.length,
          labelCount: repoTasks.reduce(
            (count, task) => count + task.labels.length,
            0,
          ),
          sourceBytes: repository.inventory.regularTsBytes,
          selectedContext: configPath,
          inventoryComplete: /Inventory complete=true/.test(summary),
          sourceCoverageComplete: /source analyzed=true/.test(summary),
          analysisComplete: /projects finished=true/.test(summary),
          contextComplete: /compiler\/type context complete=true/.test(summary),
          startedAt: repositoryStartedAt,
          finishedAt: new Date().toISOString(),
          cliAnalysisAndViewerStartupMs,
          browserWorkflowMs,
          cliServerExitCode: cliResult.code,
          cliServerStoppedByHarness: true,
          tasks: taskResults,
        });
      } finally {
        await page?.context().close();
        await cli.stop().catch(() => undefined);
      }
    }
  } finally {
    await browser.close();
  }
  const repositoryRuns = output.repositories as {
    taskCount: number;
    labelCount: number;
    tasks: {
      completed: boolean;
      labels: { expected: string; observed: string }[];
    }[];
  }[];
  const tasks = repositoryRuns.flatMap((repository) => repository.tasks);
  const labels = tasks.flatMap((task) => task.labels);
  const wrongExact = labels.filter(
    (label) => label.expected !== 'exact' && label.observed === 'exact',
  ).length;
  const exactExpected = labels.filter((label) => label.expected === 'exact');
  const supportedMisses = exactExpected.filter(
    (label) => label.observed !== 'exact',
  ).length;
  const completedTasks = tasks.filter((task) => task.completed).length;
  const serialized =
    JSON.stringify(
      {
        ...output,
        totals: {
          completedTasks,
          taskCount: tasks.length,
          labels: labels.length,
          exactExpected: exactExpected.length,
          exactObserved: exactExpected.length - supportedMisses,
          wrongExact,
          supportedMisses,
          zeroWrongExact: wrongExact === 0,
        },
      },
      null,
      2,
    ) + '\n';
  process.stdout.write(serialized);
  if (process.env.CT_REALWORLD_OUTPUT_PATH)
    await writeFile(
      resolve(process.env.CT_REALWORLD_OUTPUT_PATH),
      serialized,
      'utf8',
    );
  if (completedTasks !== tasks.length || wrongExact > 0) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
