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
}
