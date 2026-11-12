import {
  verifyLatestQueryWins,
  verifyTaskF1,
  verifyTodo,
} from './browser/semantic-scenarios.ts';
import { openPage, assertLocalOnly, selectByName } from './browser/helpers.ts';
import { verifyGitSourceDiscovery } from './browser/source-discovery.ts';
import { verifyRepositoryNavigation } from './browser/repository-navigation.ts';
import { verifyRepositoryCliBrowser } from './browser/repository-corpus.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { graphNeighborsResponseSchema } from '@codethread/contracts';
import { analyzeManifest, COMPILER_PROFILE } from '@codethread/symbol-indexer';
import type {
  AnalysisInput,
  AnalysisSnapshot,
} from '@codethread/symbol-indexer';
import {
  loadExternalCorpus,
  loadTodoClosure,
} from '../scripts/external-semantic-corpus.ts';
import {
  loadStudyTaskDataset,
  studyTaskDatasetSchema,
  validateStudyTaskDataset,
} from '../scripts/study-tasks.ts';
import { createViewer } from '../scripts/viewer.ts';

const repositoryIds = {
  todo: '00000000-0000-4000-8000-000000000021',
  tinyexec: '00000000-0000-4000-8000-000000000022',
  safe: '00000000-0000-4000-8000-000000000023',
} as const;

function analysisInput(
  repositoryId: string,
  files: AnalysisInput['files'],
): AnalysisInput {
  return {
    repositoryId,
    compilerOptions: COMPILER_PROFILE,
    files,
  };
}

async function analyzePinnedSources(): Promise<{
  todo: AnalysisSnapshot;
  todoF1: AnalysisSnapshot;
  todoF2: AnalysisSnapshot;
  tinyexec: AnalysisSnapshot;
}> {
  const todoCorpus = await loadExternalCorpus('todo');
  const todoClosure = await loadTodoClosure();
  const tinyexecCorpus = await loadExternalCorpus('tinyexec');

  const taskInput = await loadStudyTaskDataset();
  const taskValidation = await validateStudyTaskDataset(taskInput);
  assert.equal(taskValidation.valid, true, 'study task fixtures must validate');
  const tasks = studyTaskDatasetSchema.parse(taskInput);
  const analyzeTask = async (
    taskId: 'CTE-F1-001' | 'CTE-F2-001',
  ): Promise<AnalysisSnapshot> => {
    const task = tasks.tasks.find((candidate) => candidate.id === taskId);
    assert.ok(task, `expected task ${taskId}`);
    const files = await Promise.all(
      task.source.selectedFiles.map(async (selected) => {
        const bytes = await readFile(resolve(selected.fixturePath));
        assert.equal(
          createHash('sha256').update(bytes).digest('hex'),
          selected.sha256,
          `fixture bytes must match task source ${selected.path}`,
        );
        return { path: selected.path, sha256: selected.sha256, bytes };
      }),
    );
    return analyzeManifest(analysisInput(repositoryIds.todo, files));
  };

  const [todo, todoF1, todoF2, tinyexec] = await Promise.all([
    analyzeManifest(
      analysisInput(repositoryIds.todo, [...todoCorpus.files, ...todoClosure]),
    ),
    analyzeTask('CTE-F1-001'),
    analyzeTask('CTE-F2-001'),
    analyzeManifest(
      analysisInput(repositoryIds.tinyexec, tinyexecCorpus.files),
    ),
  ]);
  return { todo, todoF1, todoF2, tinyexec };
}

async function verifyDirectCalls(
  browser: Browser,
  snapshot: AnalysisSnapshot,
): Promise<void> {
  const viewer = await createViewer(snapshot);
  try {
    const page = await openPage(browser, viewer.origin, viewer.url);
    await selectByName(page, 'computeEnv', 'function');
    await page.waitForFunction(() =>
      [...document.querySelectorAll('#relationships .relationship-item')].some(
        (row) =>
          row.textContent?.includes('CALLS exact') &&
          row.textContent.includes('getPathFromEnv'),
      ),
    );
    await page.getByText(/CALLS unresolved/).waitFor();
    const unresolvedCall = page
      .locator('#relationships .relationship-item')
      .filter({ hasText: 'CALLS unresolved' });
    assert.equal(
      await unresolvedCall.getByRole('button', { name: /Follow/ }).count(),
      0,
      'an unresolved call cannot expose a fabricated target action',
    );
    const exactCall = page
      .locator('#relationships .relationship-item')
      .filter({ hasText: 'CALLS exact' })
      .filter({ hasText: 'getPathFromEnv' })
      .first();
    await exactCall
      .getByRole('button', { name: 'View occurrence evidence' })
      .click();
    await page.getByText(/getPathFromEnv\(envWithDefault\)/).waitFor();
    const callExcerpt = await page.locator('#evidence pre').textContent();
    assert.ok(callExcerpt);
    assert.match(callExcerpt, /getPathFromEnv\(envWithDefault\)/);
    await exactCall
      .getByRole('button', { name: 'Follow getPathFromEnv' })
      .click();
    await page
      .getByRole('heading', { name: 'function getPathFromEnv' })
      .waitFor();
    const uncertainty =
      (await page.locator('#relationships').innerText()) +
      (await page.locator('#unknowns').innerText());
    assert.match(uncertainty, /unsupported|unresolved/i);
    await page.getByRole('button', { name: 'Back' }).click();
    await page.getByRole('heading', { name: 'function computeEnv' }).waitFor();
    assertLocalOnly(page);
    await page.context().close();
  } finally {
    await viewer.close();
  }
}

async function verifyRelationSelectionReusesProjection(
  browser: Browser,
  snapshot: AnalysisSnapshot,
): Promise<void> {
  const viewer = await createViewer(snapshot);
  try {
    const page = await openPage(browser, viewer.origin, viewer.url);
    let neighborRequests = 0;
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/neighbors')
        neighborRequests++;
    });
    await selectByName(page, 'computeEnv', 'function');
    await page.waitForFunction(() =>
      [...document.querySelectorAll('#relationships .relationship-item')].some(
        (row) =>
          row.textContent?.includes('CALLS exact') &&
          row.textContent.includes('getPathFromEnv'),
      ),
    );
    assert.equal(
      neighborRequests,
      1,
      'selecting a root issues one graph query',
    );
    const exactCall = page
      .locator('#relationships .relationship-item')
      .filter({ hasText: 'CALLS exact' })
      .filter({ hasText: 'getPathFromEnv' })
      .first();
    await exactCall
      .getByRole('button', { name: 'Select relationship' })
      .click();
    await page.waitForTimeout(100);
    assert.equal(
      neighborRequests,
      1,
      'selecting a returned relation must not query neighbors again',
    );
    const excerpt = await page.locator('#evidence pre').textContent();
    assert.ok(excerpt, 'selecting a relation opens its occurrence evidence');
    assert.match(excerpt, /getPathFromEnv\(envWithDefault\)/);
    assert.equal(
      await exactCall.evaluate((row) => row.classList.contains('selected')),
      true,
    );
    assertLocalOnly(page);
    await page.context().close();
  } finally {
    await viewer.close();
  }
}

async function verifySafeEvidence(browser: Browser): Promise<void> {
  const source = `export function safeMarkup() { return "<img src=x onerror=alert(1)>" + "${String.fromCodePoint(0x202e)}"; }\r\n`;
  const bytes = Buffer.from(source, 'utf8');
  const snapshot = await analyzeManifest(
    analysisInput(repositoryIds.safe, [
      {
        path: 'src/safe.ts',
        bytes,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    ]),
  );
  const viewer = await createViewer(snapshot);
  try {
    const page = await openPage(browser, viewer.origin, viewer.url);
    await selectByName(page, 'safeMarkup', 'function');
    await page
      .getByRole('button', { name: 'View declaration evidence' })
      .click();
    const excerpt = page.locator('#evidence pre');
    await page.waitForFunction(() =>
      document
        .querySelector('#evidence pre')
        ?.textContent?.includes('safeMarkup'),
    );
    const rendered = await excerpt.textContent();
    assert.ok(rendered);
    assert.match(rendered, /<img src=x onerror=alert\(1\)>/);
    assert.match(rendered, /\\u\{202e\}/);
    assert.equal(
      await page.locator('#evidence img, #evidence script').count(),
      0,
    );
    assert.equal(await page.locator('script:not([src])').count(), 0);
    assertLocalOnly(page);
    await page.context().close();
  } finally {
    await viewer.close();
  }
}

async function verifyDeepRelationshipOrientation(
  browser: Browser,
): Promise<void> {
  const source =
    'export function root() { branch(); }\n' +
    'function branch() { leaf(); }\n' +
    'function leaf() {}\n';
  const bytes = Buffer.from(source, 'utf8');
  const snapshot = await analyzeManifest(
    analysisInput(repositoryIds.safe, [
      {
        path: 'src/chain.ts',
        bytes,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    ]),
  );
  const viewer = await createViewer(snapshot);
  try {
    const page = await openPage(browser, viewer.origin, viewer.url);
    await selectByName(page, 'root', 'function');
    await page.waitForFunction(() =>
      [...document.querySelectorAll('#relationships .relationship-item')].some(
        (row) =>
          row.textContent?.includes('CALLS exact') &&
          row.textContent.includes('Source: branch') &&
          row.textContent.includes('Target: leaf'),
      ),
    );
    const deepRelation = page
      .locator('#relationships .relationship-item')
      .filter({ hasText: 'Source: branch' })
      .filter({ hasText: 'Target: leaf' });
    const text = await deepRelation.innerText();
    assert.match(text, /within selected neighborhood/);
    assert.doesNotMatch(text, /· (?:incoming|outgoing)(?:\s|$)/);
    await deepRelation.getByRole('button', { name: 'Follow leaf' }).click();
    await page.getByRole('heading', { name: 'function leaf' }).waitFor();
    assertLocalOnly(page);
    await page.context().close();
  } finally {
    await viewer.close();
  }
}

async function verifyInteractiveGraphOccurrences(
  browser: Browser,
): Promise<void> {
  const source =
    'export function root() {\n' +
    '  target();\n' +
    '  target();\n' +
    '  root();\n' +
    '}\n' +
    'function target() {}\n';
  const bytes = Buffer.from(source, 'utf8');
  const snapshot = await analyzeManifest(
    analysisInput(repositoryIds.safe, [
      {
        path: 'src/occurrences.ts',
        bytes,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    ]),
  );
  const viewer = await createViewer(snapshot);
  try {
    const page = await openPage(browser, viewer.origin, viewer.url);
    let neighborRequests = 0;
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/neighbors')
        neighborRequests++;
    });
    await selectByName(page, 'root', 'function');
    await page.waitForFunction(() =>
      [...document.querySelectorAll('#relationships .relationship-item')].some(
        (row) => row.textContent?.includes('CALLS exact'),
      ),
    );
    assert.equal(neighborRequests, 1);
    const edges = page.locator('#graph .graph-edge-hit');
    assert.equal(
      await edges.count(),
      3,
      'each returned exact call occurrence, including the self-call, needs its own SVG control',
    );
    const firstCall = page.getByRole('button', {
      name: /CALLS occurrence at src\/occurrences\.ts:2:/,
    });
    const secondCall = page.getByRole('button', {
      name: /CALLS occurrence at src\/occurrences\.ts:3:/,
    });
    const selfCall = page.getByRole('button', {
      name: /CALLS occurrence at src\/occurrences\.ts:4:/,
    });
    const firstId = await firstCall.getAttribute('data-relation-id');
    const secondId = await secondCall.getAttribute('data-relation-id');
    const selfId = await selfCall.getAttribute('data-relation-id');
    assert.ok(firstId);
    assert.ok(secondId);
    assert.ok(selfId);
    assert.notEqual(firstId, secondId);
    assert.notEqual(firstId, selfId);
    assert.notEqual(secondId, selfId);
    let delayNextEvidence = true;
    await page.route('**/api/evidence', async (route) => {
      if (delayNextEvidence) {
        delayNextEvidence = false;
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
      await route.continue();
    });
    const firstEvidenceRequest = page.waitForRequest(
      (request) => new URL(request.url()).pathname === '/api/evidence',
    );
    await firstCall.click();
    const firstRow = page.locator(
      `#relationships li[data-relation-id="${firstId}"]`,
    );
    assert.equal(
      await firstRow.evaluate((row) => row.classList.contains('selected')),
      true,
    );
    await firstEvidenceRequest;
    await secondCall.focus();
    await page.keyboard.press('Enter');
    const secondRow = page.locator(
      `#relationships li[data-relation-id="${secondId}"]`,
    );
    assert.equal(
      await secondRow.evaluate((row) => row.classList.contains('selected')),
      true,
    );
    await page
      .locator('#evidence')
      .getByText(/occurrences\.ts@3:/)
      .waitFor();
    assert.equal(neighborRequests, 1);
    await page.waitForTimeout(700);
    assert.match(
      await page.locator('#evidence pre').innerText(),
      /target\(\)/,
      'a slower response for the previous occurrence cannot replace the current evidence',
    );
    assert.match(
      await page.locator('#evidence').innerText(),
      /occurrences\.ts@3:/,
    );

    await selfCall.focus();
    await page.keyboard.press('Enter');
    const selfRow = page.locator(
      `#relationships li[data-relation-id="${selfId}"]`,
    );
    assert.equal(
      await selfRow.evaluate((row) => row.classList.contains('selected')),
      true,
      'the recursive self-call occurrence remains independently selectable',
    );
    await page
      .locator('#evidence')
      .getByText(/occurrences\.ts@4:/)
      .waitFor();
    assert.equal(neighborRequests, 1);

    const targetNode = page.getByRole('button', {
      name: /function target at src\/occurrences\.ts@6:1/,
    });
    await targetNode.focus();
    assert.equal(
      await targetNode.evaluate((node) => node.matches(':focus-visible')),
      true,
    );
    await page.keyboard.press(' ');
    assert.equal(neighborRequests, 1, 'node selection is presentation-only');
    await page
      .locator('#evidence')
      .getByText(/occurrences\.ts@6:/)
      .waitFor();
    assert.match(
      await page.locator('#evidence pre').innerText(),
      /function target/,
    );
    assert.equal(await targetNode.getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: 'Follow symbol target' }).click();
    await page.getByRole('heading', { name: 'function target' }).waitFor();
    assert.equal(
      neighborRequests,
      2,
      'following a node issues one graph query',
    );
    await page.getByRole('button', { name: 'Back' }).click();
    await page.getByRole('heading', { name: 'function root' }).waitFor();
    assert.equal(neighborRequests, 3, 'back navigation issues one graph query');
    await page
      .getByRole('heading', { name: 'Selected symbol: function target' })
      .waitFor();
    await page
      .locator('#evidence')
      .getByText(/occurrences\.ts@6:/)
      .waitFor();
    const filterRequest = page.waitForRequest(
      (request) => new URL(request.url()).pathname === '/api/neighbors',
    );
    await page.locator('#direction').selectOption('outgoing');
    await filterRequest;
    await page.waitForFunction(() =>
      document
        .querySelector('#investigation-status')
        ?.textContent?.includes('Depth 2'),
    );
    assert.equal(neighborRequests, 4, 'a filter change issues one graph query');

    delayNextEvidence = true;
    const staleEvidenceRequest = page.waitForRequest(
      (request) => new URL(request.url()).pathname === '/api/evidence',
    );
    await page
      .getByRole('button', {
        name: /function target at src\/occurrences\.ts@6:1/,
      })
      .click();
    await staleEvidenceRequest;
    await page.getByRole('button', { name: 'Follow symbol target' }).click();
    await page.getByRole('heading', { name: 'function target' }).waitFor();
    assert.equal(neighborRequests, 5);
    await page.waitForTimeout(700);
    assert.doesNotMatch(
      await page.locator('#evidence').innerText(),
      /function target/,
      'changing roots invalidates in-flight evidence from the prior graph',
    );
    await page.getByRole('button', { name: 'Back' }).click();
    await page.getByRole('heading', { name: 'function root' }).waitFor();
    assert.equal(neighborRequests, 6);
    await page
      .getByRole('heading', { name: 'Selected symbol: function target' })
      .waitFor();
    await page
      .locator('#evidence')
      .getByText(/occurrences\.ts@6:/)
      .waitFor();
    assertLocalOnly(page);
    await page.context().close();
  } finally {
    await viewer.close();
  }
}

async function verifyTruncatedGraphOnlyExposesReturnedEdges(
  browser: Browser,
): Promise<void> {
  const calls = Array.from(
    { length: 51 },
    (_, index) => `target${String(index).padStart(2, '0')}();`,
  );
  const targets = Array.from(
    { length: 51 },
    (_, index) => `function target${String(index).padStart(2, '0')}() {}`,
  );
  const source = [
    'export function root() {',
    ...calls.map((call) => `  ${call}`),
    '}',
    ...targets,
  ].join('\n');
  const bytes = Buffer.from(source, 'utf8');
  const snapshot = await analyzeManifest(
    analysisInput(repositoryIds.safe, [
      {
        path: 'src/wide.ts',
        bytes,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    ]),
  );
  const viewer = await createViewer(snapshot);
  try {
    const page = await openPage(browser, viewer.origin, viewer.url);
    const neighborsResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/neighbors',
    );
    await selectByName(page, 'root', 'function');
    const response = await neighborsResponse;
    assert.equal(response.status(), 200);
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || !('graph' in body))
      throw new Error('The visual viewer returned no graph projection.');
    const graph = graphNeighborsResponseSchema.parse(body.graph);
    assert.equal(graph.meta.truncated, true);
    assert.ok(graph.relations.length < calls.length);
    assert.equal(
      graph.symbols.some((symbol) => symbol.name === 'target50'),
      false,
    );
    await page.getByText(/Query truncated:/).waitFor();
    const renderedIds = await page
      .locator('#graph .graph-edge-hit')
      .evaluateAll((elements) =>
        elements
          .map((element) => element.getAttribute('data-relation-id'))
          .filter((id): id is string => id !== null),
      );
    const returnedExactIds = graph.relations
      .filter((relation) => relation.resolution.status === 'exact')
      .map((relation) => relation.id);
    assert.deepEqual([...renderedIds].sort(), [...returnedExactIds].sort());
    assert.equal(
      await page.getByRole('button', { name: 'Follow target50' }).count(),
      0,
      'an omitted target must not become an interactive graph node',
    );
    assertLocalOnly(page);
    await page.context().close();
  } finally {
    await viewer.close();
  }
}

async function main(): Promise<void> {
  const { todo, todoF1, todoF2, tinyexec } = await analyzePinnedSources();
  const browser = await chromium.launch({ headless: true });
  try {
    await verifyTodo(browser, todoF2);
    await verifyTaskF1(browser, todoF1);
    await verifyLatestQueryWins(browser, todo);
    await verifyDirectCalls(browser, tinyexec);
    await verifyRelationSelectionReusesProjection(browser, tinyexec);
    await verifyDeepRelationshipOrientation(browser);
    await verifyInteractiveGraphOccurrences(browser);
    await verifyTruncatedGraphOnlyExposesReturnedEdges(browser);
    await verifySafeEvidence(browser);
    await verifyGitSourceDiscovery(browser);
    await verifyRepositoryNavigation(browser);
    await verifyRepositoryCliBrowser(browser);
  } finally {
    await browser.close();
  }
  process.stdout.write(
    'Browser investigation passed: exact task F1/F2 inputs, CALLS/REFERENCES filters, tinyexec uncertainty, target follow/back, evidence and safe rendering.\n',
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : 'Browser evaluation failed.'}\n`,
  );
  process.exitCode = 1;
});
