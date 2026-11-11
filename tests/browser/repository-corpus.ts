import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { Browser } from 'playwright';
import { loadRepositoryCorpus } from '../../scripts/repository-corpus.ts';
import { materializeRepositoryCorpus } from '../../scripts/repository-corpus-git.ts';
import { loadRepositoryGold } from '../../scripts/repository-gold.ts';
import { startInvestigationCli } from '../helpers/investigation-cli.ts';
import { openPage, assertLocalOnly } from './helpers.ts';

export async function verifyRepositoryCliBrowser(browser: Browser) {
  const definitions = JSON.parse(
    await readFile('fixtures/external/repository-workflows.json', 'utf8'),
  ) as {
    repositories: { name: string; revision: string; tasks: { id: string }[] }[];
  };
  const expected = definitions.repositories.find(
    (item) => item.name === 'ufo',
  )!;
  assert.equal(
    expected.tasks.length,
    5,
    'the workflow denominator must remain explicit',
  );
  const corpus = await loadRepositoryCorpus('ufo'),
    gold = await loadRepositoryGold();
  assert.equal(expected.revision, corpus.manifest.revision);
  const repository = await materializeRepositoryCorpus(corpus);
  const running = startInvestigationCli(
    [
      '--repo',
      repository.directory,
      '--revision',
      corpus.manifest.revision,
      '--scope',
      'repository',
      '--view',
    ],
    { deadlineMs: 180000 },
  );
  running.child.stdin.end();
  const completed: string[] = [];
  try {
    const output = await running.waitFor(
      /CodeThread local visual investigation: (http:\/\/127\.0\.0\.1:\d+\/#[a-f0-9]{64})/,
      125000,
    );
    const url = output[1]!,
      origin = new URL(url).origin;
    const page = await openPage(browser, origin, url, 'project-select');
    assert.match(
      await page.locator('#repository-summary').innerText(),
      /21 regular \.ts files/,
    );
    const search = page.getByLabel('Name or source path');
    await search.fill('withQuery');
    await search.press('Enter');
    await page
      .locator('#symbol-results')
      .getByRole('button', {
        name: /withQuery · function · src\/utils.ts@348:1 · tsconfig\.json$/,
      })
      .click();
    await page
      .getByRole('heading', { name: 'function withQuery', exact: true })
      .waitFor();
    completed.push(expected.tasks[0]!.id);
    await page
      .getByLabel('Direction', { exact: true })
      .selectOption('outgoing');
    await page.waitForFunction(() =>
      document
        .querySelector('#investigation-status')
        ?.textContent?.includes('Depth 2'),
    );
    const rows = page.locator('#relationships .relationship-item');
    const directRows = rows.filter({
      hasText: 'Source: withQuery (src/utils.ts@348:1)',
    });
    assert.equal(
      await directRows.count(),
      4,
      'the owner retains four distinct call occurrences',
    );
    for (const target of [
      'parseURL',
      'parseQuery',
      'stringifyQuery',
      'stringifyParsedURL',
    ])
      assert.match(
        (await rows.allInnerTexts()).join('\n'),
        new RegExp('Target: ' + target + ' '),
      );
    completed.push(expected.tasks[1]!.id);
    const row = directRows.filter({ hasText: 'Target: parseURL (' });
    await row
      .getByRole('button', { name: 'View occurrence evidence', exact: true })
      .click();
    await page
      .locator('#evidence pre')
      .getByText(/parseURL\(input\)/)
      .waitFor();
    const label = gold.labels.find(
      (label) => label.repository === 'ufo' && label.expression === 'parseURL',
    )!;
    assert.match(
      await page.locator('#evidence').innerText(),
      new RegExp(label.site.sourceSha256),
    );
    await row
      .getByRole('button', {
        name: 'View parseURL declaration evidence',
        exact: true,
      })
      .click();
    await page
      .locator('#evidence pre')
      .getByText(/export function parseURL/)
      .waitFor();
    assert.match(
      await page.locator('#evidence').innerText(),
      new RegExp(label.target!.sourceSha256),
    );
    completed.push(expected.tasks[2]!.id);
    await row
      .getByRole('button', { name: 'Follow parseURL', exact: true })
      .click();
    await page
      .getByRole('heading', { name: 'function parseURL', exact: true })
      .waitFor();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page
      .getByRole('heading', { name: 'function withQuery', exact: true })
      .waitFor();
    assert.equal(
      await page.getByLabel('Direction', { exact: true }).inputValue(),
      'outgoing',
    );
    await page
      .locator('#evidence pre')
      .getByText(/export function parseURL/)
      .waitFor();
    await page.getByRole('button', { name: 'Forward', exact: true }).click();
    await page
      .getByRole('heading', { name: 'function parseURL', exact: true })
      .waitFor();
    completed.push(expected.tasks[3]!.id);
    await page
      .getByText('Source inventory and project diagnostics', { exact: true })
      .click();
    assert.equal(await page.locator('#source-files li').count(), 21);
    assert.match(
      await page.locator('#repository-summary').innerText(),
      /compiler\/type context complete=false/,
    );
    completed.push(expected.tasks[4]!.id);
    assertLocalOnly(page);
    await page.context().close();
    assert.deepEqual(
      completed,
      expected.tasks.map((task) => task.id),
    );
    process.stdout.write(
      JSON.stringify({
        kind: 'repository_browser_tasks',
        repository: corpus.manifest.repository,
        revision: corpus.manifest.revision,
        completed: completed.length,
        total: expected.tasks.length,
        taskIds: completed,
        independentlyReviewed: false,
      }) + '\n',
    );
  } finally {
    await running.stop();
    await repository.cleanup();
  }
  await verifySourcemapsRepositoryCliBrowser(browser);
}

async function verifySourcemapsRepositoryCliBrowser(browser: Browser) {
  const definitions = JSON.parse(
    await readFile('fixtures/external/repository-workflows.json', 'utf8'),
  ) as {
    repositories: {
      name: string;
      revision: string;
      sourceExpectations?: {
        configPath: string;
        symbol: string;
        ownerPath: string;
        ownerLine: number;
        occurrenceLine: number;
        sourceSha256: string;
        target: string;
        targetPath: string;
        targetLine: number;
        targetSha256: string;
        matchingContexts: number;
        sourceFiles: number;
      };
      tasks: { id: string }[];
    }[];
  };
  const expected = definitions.repositories.find(
    (item) => item.name === 'sourcemaps',
  )!;
  assert.equal(
    expected.tasks.length,
    6,
    'the workflow denominator is explicit',
  );
  const anchors = expected.sourceExpectations!;
  const corpus = await loadRepositoryCorpus('sourcemaps');
  assert.equal(expected.revision, corpus.manifest.revision);
  assert.equal(corpus.files.length, anchors.sourceFiles);
  for (const [path, hash] of [
    [anchors.ownerPath, anchors.sourceSha256],
    [anchors.targetPath, anchors.targetSha256],
  ])
    assert.equal(
      corpus.files.find((file) => file.path === path)?.sha256,
      hash,
      `the source expectation must match pinned bytes at ${path}`,
    );
  const source = corpus.files.find((file) => file.path === anchors.ownerPath)!;
  assert.match(
    Buffer.from(source.bytes).toString('utf8').split(/\r?\n/)[
      anchors.occurrenceLine - 1
    ]!,
    new RegExp(`${anchors.target}\\(`),
  );
  const repository = await materializeRepositoryCorpus(corpus);
  const running = startInvestigationCli(
    [
      '--repo',
      repository.directory,
      '--revision',
      corpus.manifest.revision,
      '--scope',
      'repository',
      '--view',
    ],
    { deadlineMs: 180000 },
  );
  running.child.stdin.end();
  const completed: string[] = [];
  try {
    const output = await running.waitFor(
      /CodeThread local visual investigation: (http:\/\/127\.0\.0\.1:\d+\/#[a-f0-9]{64})/,
      125000,
    );
    const url = output[1]!,
      origin = new URL(url).origin;
    const page = await openPage(browser, origin, url, 'project-select');
    const summary = page.locator('#repository-summary');
    assert.ok(
      (await summary.innerText()).includes(
        `${anchors.sourceFiles} regular .ts files`,
      ),
    );
    assert.match(
      await summary.innerText(),
      /compiler\/type context complete=false/,
    );

    const search = page.getByLabel('Name or source path');
    await search.fill(anchors.symbol);
    await search.press('Enter');
    const symbolResults = page.locator('#symbol-results button').filter({
      hasText: `${anchors.symbol} · function · ${anchors.ownerPath}@${anchors.ownerLine}:1`,
    });
    await symbolResults.first().waitFor();
    assert.equal(await symbolResults.count(), anchors.matchingContexts);
    const candidateProjectIds = await symbolResults.evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute('data-project-id')),
    );
    assert.equal(new Set(candidateProjectIds).size, anchors.matchingContexts);
    completed.push(expected.tasks[0]!.id);

    const project = page.getByLabel('Project context', { exact: true });
    const projectOption = project
      .locator('option')
      .filter({ hasText: anchors.configPath });
    assert.equal(await projectOption.count(), 1);
    const projectId = await projectOption.getAttribute('value');
    assert.ok(projectId);
    await project.selectOption(projectId!);
    assert.equal(await project.inputValue(), projectId);
    completed.push(expected.tasks[1]!.id);

    const symbolResult = symbolResults.filter({
      hasText: anchors.configPath,
    });
    await symbolResult.waitFor();
    assert.equal(await symbolResult.count(), 1);
    await symbolResult.click();
    await page
      .getByRole('heading', { name: `function ${anchors.symbol}`, exact: true })
      .waitFor();
    assert.equal(await project.inputValue(), projectId);

    await page
      .getByLabel('Direction', { exact: true })
      .selectOption('outgoing');
    const rows = page.locator('#relationships .relationship-item');
    const row = rows.filter({ hasText: `Target: ${anchors.target} (` });
    await row.waitFor();
    assert.equal(await row.count(), 1);
    assert.ok(
      (await row.innerText()).includes(
        `Source: ${anchors.symbol} (${anchors.ownerPath}@${anchors.ownerLine}:1)`,
      ),
    );
    assert.ok(
      (await row.innerText()).includes(
        `Target: ${anchors.target} (function) · ${anchors.targetPath}@${anchors.targetLine}:1`,
      ),
    );
    completed.push(expected.tasks[2]!.id);
    await row
      .getByRole('button', { name: 'View occurrence evidence', exact: true })
      .click();
    await page
      .locator('#evidence pre')
      .getByText(new RegExp(`${anchors.target}\\(`))
      .waitFor();
    assert.match(
      await page.locator('#evidence').innerText(),
      new RegExp(anchors.sourceSha256),
    );
    await row
      .getByRole('button', {
        name: `View ${anchors.target} declaration evidence`,
        exact: true,
      })
      .click();
    await page
      .locator('#evidence pre')
      .getByText(new RegExp(`export function ${anchors.target}`))
      .waitFor();
    assert.match(
      await page.locator('#evidence').innerText(),
      new RegExp(anchors.targetSha256),
    );
    completed.push(expected.tasks[3]!.id);

    await row
      .getByRole('button', { name: `Follow ${anchors.target}`, exact: true })
      .click();
    const choices = page.getByRole('region', {
      name: 'Choose declaration context',
    });
    await choices.getByRole('button').first().waitFor();
    assert.equal(
      await choices.getByRole('button').count(),
      anchors.matchingContexts,
    );
    await choices
      .getByRole('button', {
        name: 'packages/trace-mapping/tsconfig.build.json',
        exact: true,
      })
      .waitFor();
    const targetProjectOption = project
      .locator('option')
      .filter({ hasText: 'packages/trace-mapping/tsconfig.build.json' });
    assert.equal(await targetProjectOption.count(), 1);
    const targetProjectId = await targetProjectOption.getAttribute('value');
    assert.ok(targetProjectId);
    assert.notEqual(targetProjectId, projectId);
    await choices
      .getByRole('button', {
        name: 'packages/trace-mapping/tsconfig.build.json',
        exact: true,
      })
      .click();
    await page
      .getByRole('heading', { name: `function ${anchors.target}`, exact: true })
      .waitFor();
    assert.equal(await project.inputValue(), targetProjectId);
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page
      .getByRole('heading', { name: `function ${anchors.symbol}`, exact: true })
      .waitFor();
    assert.equal(await project.inputValue(), projectId);
    assert.equal(
      await page.getByLabel('Direction', { exact: true }).inputValue(),
      'outgoing',
    );
    await page.getByRole('button', { name: 'Forward', exact: true }).click();
    await page
      .getByRole('heading', { name: `function ${anchors.target}`, exact: true })
      .waitFor();
    assert.equal(await project.inputValue(), targetProjectId);
    completed.push(expected.tasks[4]!.id);

    await page
      .getByText('Source inventory and project diagnostics', { exact: true })
      .click();
    const listedFiles = new Map<string, string>();
    const next = page.getByRole('button', { name: 'Next files', exact: true });
    await page
      .locator('#source-files')
      .getByText(/Showing \d+/)
      .waitFor();
    for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
      const entries = await page.locator('#source-files li').allInnerTexts();
      for (const entry of entries) {
        const match = entry.match(
          /^(.+\.ts): (analyzed|not_analyzed|excluded)(?:,|;)/,
        );
        if (match) {
          assert.ok(
            !listedFiles.has(match[1]!),
            `duplicate inventory path ${match[1]}`,
          );
          listedFiles.set(match[1]!, entry);
        }
      }
      if (await next.isDisabled()) break;
      assert.ok(pageNumber < 9, 'source inventory pagination terminates');
      const currentPage = entries.find((entry) => entry.startsWith('Showing '));
      assert.ok(
        currentPage,
        'paged source inventory exposes its current range',
      );
      await next.click();
      await page.waitForFunction(
        (previous) =>
          [...document.querySelectorAll('#source-files li')].some(
            (item) =>
              item.textContent?.startsWith('Showing ') &&
              item.textContent !== previous,
          ),
        currentPage,
      );
    }
    const expectedPaths = new Set(corpus.files.map((file) => file.path));
    for (const path of expectedPaths)
      assert.match(
        listedFiles.get(path) ?? '',
        /^.+\.ts: (?:analyzed|not_analyzed),/,
        `the pinned regular .ts path ${path} must have an analysis status`,
      );
    for (const [path, entry] of listedFiles)
      if (!expectedPaths.has(path))
        assert.match(entry, /^.+\.ts: excluded; reason:/);
    assert.equal(
      [...listedFiles.keys()].filter((path) => expectedPaths.has(path)).length,
      anchors.sourceFiles,
      'every pinned regular .ts path appears exactly once with a per-file status',
    );
    completed.push(expected.tasks[5]!.id);
    assertLocalOnly(page);
    await page.context().close();
    assert.deepEqual(
      completed,
      expected.tasks.map((task) => task.id),
    );
    process.stdout.write(
      JSON.stringify({
        kind: 'repository_browser_tasks',
        repository: corpus.manifest.repository,
        revision: corpus.manifest.revision,
        completed: completed.length,
        total: expected.tasks.length,
        taskIds: completed,
        regularSourceFiles: corpus.files.length,
        independentlyReviewed: false,
      }) + '\n',
    );
  } finally {
    await running.stop();
    await repository.cleanup();
  }
}
