import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { Browser } from 'playwright';
import {
  createGitRepository,
  runGitFixture,
  writeFixtureTree,
  commitFixtureTree,
} from '../helpers/git-fixture.ts';
import { startInvestigationCli } from '../helpers/investigation-cli.ts';
import { openPage, selectByName, assertLocalOnly } from './helpers.ts';

export async function verifyGitSourceDiscovery(
  browser: Browser,
): Promise<void> {
  const directories: string[] = [];
  const leafSource = 'export function leaf() { return 7; }\r\n';
  const entrySource =
    "import { leaf } from './leaf';\nimport { handlers } from './handlers';\nfunction register(value: unknown) {}\nexport function entry() { leaf(); register(handlers.handle); }\n";
  const { directory, revision } = await createGitRepository(
    [
      { path: 'src/entry.ts', source: entrySource },
      { path: 'src/leaf.ts', source: leafSource },
      {
        path: 'src/handlers.ts',
        source:
          'class Handlers { handle() { return 11; } }\nexport const handlers = new Handlers();\n',
      },
    ],
    directories,
  );
  for (const path of directories)
    assert.equal(dirname(path), resolve(tmpdir()));
  const branch = (
    await runGitFixture(directory, ['symbolic-ref', 'HEAD'])
  ).trim();
  const running = startInvestigationCli(
    [
      '--repo',
      directory,
      '--repository-id',
      '00000000-0000-4000-8000-000000000022',
      '--revision',
      branch,
      '--browse',
      '--view',
    ],
    { deadlineMs: 60000 },
  );
  try {
    await running.waitFor(/Inventory status: complete/);
    const blob = (
      await runGitFixture(
        directory,
        ['hash-object', '-w', '--stdin'],
        'export function changed() {}\n',
      )
    ).trim();
    const tree = await writeFixtureTree(directory, [
      { mode: '100644', type: 'blob', oid: blob, name: 'changed.ts' },
    ]);
    await runGitFixture(directory, [
      'update-ref',
      branch,
      await commitFixtureTree(directory, tree),
    ]);
    await writeFile(resolve(directory, 'src/leaf.ts'), 'DIRTY WORKTREE SOURCE');
    running.child.stdin.end(
      'files src\nsearch leaf src\nselect-module src\nselected\nanalyze\n',
    );
    const launch = await running.waitFor(
      /CodeThread local visual investigation: (http:\/\/127\.0\.0\.1:\d+\/#\w+)/,
    );
    const pinned = await running.waitFor(
      /Pinned Git commit: ([0-9a-f]{40,64})/,
    );
    assert.equal(pinned[1], revision);
    const url = launch[1]!;
    const page = await openPage(browser, new URL(url).origin, url);
    try {
      assert.match(
        await page.locator('#snapshot-summary').innerText(),
        /3 source files/,
      );
      await selectByName(page, 'entry', 'function');
      assert.equal(
        await page
          .getByRole('checkbox', { name: 'CALLS', exact: true })
          .isChecked(),
        true,
      );
      assert.equal(
        await page
          .getByRole('checkbox', { name: 'REFERENCES', exact: true })
          .isChecked(),
        false,
      );
      const leafRow = page
        .locator('#relationships .relationship-item')
        .filter({ hasText: 'Target: leaf (function)' });
      await leafRow
        .getByRole('button', { name: 'View occurrence evidence' })
        .click();
      assert.equal(await page.locator('#evidence pre').innerText(), 'leaf()');
      await leafRow
        .getByRole('button', { name: 'View leaf declaration evidence' })
        .click();
      assert.equal(
        await page.locator('#evidence pre').innerText(),
        'export function leaf() { return 7; }',
      );
      assert.match(
        await page.locator('#evidence').innerText(),
        new RegExp(createHash('sha256').update(leafSource).digest('hex')),
      );
      await leafRow.getByRole('button', { name: 'Follow leaf' }).click();
      await page
        .getByRole('heading', { name: 'function leaf', exact: true })
        .waitFor();
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await page
        .getByRole('heading', { name: 'function entry', exact: true })
        .waitFor();
      await page
        .getByRole('checkbox', { name: 'REFERENCES', exact: true })
        .check();
      await page
        .getByRole('checkbox', { name: 'CALLS', exact: true })
        .uncheck();
      const reference = page
        .locator('#relationships .relationship-item')
        .filter({ hasText: 'REFERENCES exact' });
      await reference
        .getByRole('button', { name: 'View occurrence evidence' })
        .click();
      assert.equal(await reference.count(), 1);
      assert.equal(
        await page.locator('#evidence pre').innerText(),
        'handlers.handle',
      );
      assert.equal(
        await page
          .locator('#relationships .relationship-item')
          .filter({ hasText: 'CALLS exact' })
          .count(),
        0,
      );
      await reference
        .getByRole('button', { name: 'View handle declaration evidence' })
        .click();
      assert.equal(
        await page.locator('#evidence pre').innerText(),
        'handle() { return 11; }',
      );
      assertLocalOnly(page);
    } finally {
      await page.context().close();
    }
    process.stdout.write(
      'Pinned Git discovery browser flow passed: moved ref + dirty worktree, exact CALLS/REFERENCES, matching source hashes and evidence.\n',
    );
  } finally {
    await running.stop();
    for (const path of directories) {
      await rm(path, { recursive: true, force: true });
    }
  }
}
