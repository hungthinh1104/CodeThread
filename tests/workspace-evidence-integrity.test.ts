import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { describe, it } from 'vitest';
import { analyzeManifest, COMPILER_PROFILE } from '@codethread/symbol-indexer';
import { startWorkspaceApp } from './browser/workspace-app.ts';

const repositoryId = '22222222-2222-4222-8222-222222222222';
const source = Buffer.from(
  [
    'class Left { execute() {} }',
    'class Right { execute() {} }',
    'function register(value: unknown) {}',
    'function exactTarget() {}',
    'export function inspect(choice: Left | Right) {',
    '  register(choice.execute);',
    '  exactTarget();',
    '}',
    'export const topLevelUnowned = exactTarget();',
    '',
  ].join('\n'),
);
const snapshot = await analyzeManifest({
  repositoryId,
  compilerOptions: COMPILER_PROFILE,
  files: [
    {
      path: 'src/relations.ts',
      bytes: source,
      sha256: createHash('sha256').update(source).digest('hex'),
    },
  ],
});

describe('Investigation Workspace evidence integrity', () => {
  it('keeps ambiguous references non-followable, reports unavailable source, and matches graph edges to exact list rows', async () => {
    const inspect = snapshot.facts.symbols.find(
      (symbol) => symbol.name === 'inspect',
    );
    const ambiguous = snapshot.facts.relations.find(
      (relation) =>
        relation.kind === 'references' &&
        relation.sourceSymbolId === inspect?.id &&
        relation.resolution.status === 'ambiguous',
    );
    const unownedObservation = snapshot.facts.observations.find(
      (observation) =>
        observation.ownerId === null && observation.relationId === null,
    );
    const unownedDiagnostic = unownedObservation?.diagnosticId
      ? (snapshot.facts.diagnostics.find(
          (diagnostic) => diagnostic.id === unownedObservation.diagnosticId,
        ) ?? null)
      : null;
    assert.ok(inspect, 'fixture must contain its inspect declaration');
    assert.ok(ambiguous, 'fixture must produce an ambiguous reference');
    assert.ok(
      unownedObservation,
      'fixture must produce an unowned observation for unknowns inspection',
    );

    const app = await startWorkspaceApp(snapshot);
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    let exactRelationIds: string[] = [];
    let unavailableEvidenceInjected = false;
    try {
      await page.route('**/api/workspace/neighbors', async (route) => {
        const response = await route.fetch();
        const payload = (await response.json()) as {
          projectId: string;
          result: {
            graph: {
              symbols: { id: string }[];
              relations: {
                id: string;
                sourceSymbolId: string;
                resolution: { status: string; targetId: string | null };
              }[];
            };
            unknowns: {
              total: number;
              items: {
                evidenceId: string;
                status: 'unresolved' | 'ambiguous' | 'unsupported';
                diagnostic: typeof unownedDiagnostic;
              }[];
            };
          };
        };
        const symbolIds = new Set(
          payload.result.graph.symbols.map((symbol) => symbol.id),
        );
        exactRelationIds = payload.result.graph.relations
          .filter(
            (relation) =>
              relation.resolution.status === 'exact' &&
              relation.resolution.targetId !== null &&
              symbolIds.has(relation.sourceSymbolId) &&
              symbolIds.has(relation.resolution.targetId),
          )
          .map((relation) => relation.id)
          .sort();
        payload.result.unknowns = {
          total: 1,
          items: [
            {
              evidenceId: unownedObservation.evidenceId,
              status: unownedObservation.status as
                'unresolved' | 'ambiguous' | 'unsupported',
              diagnostic: unownedDiagnostic,
            },
          ],
        };
        await route.fulfill({ response, body: JSON.stringify(payload) });
      });
      await page.route('**/api/workspace/evidence', async (route) => {
        const request = route.request().postDataJSON() as {
          request?: { evidenceIds?: string[] };
        };
        const response = await route.fetch();
        const payload = (await response.json()) as {
          projectId: string;
          result: {
            meta: { snapshotId: string };
            items: (
              | { status: 'available'; evidence: { id: string } }
              | { status: 'unavailable'; evidenceId: string }
            )[];
          };
        };
        if (request.request?.evidenceIds?.includes(ambiguous.siteEvidenceId)) {
          payload.result.items = [
            {
              status: 'unavailable',
              snapshotId: payload.result.meta.snapshotId,
              evidenceId: ambiguous.siteEvidenceId,
              code: 'SOURCE_UNAVAILABLE',
            } as (typeof payload.result.items)[number],
          ];
          unavailableEvidenceInjected = true;
          await route.fulfill({ response, body: JSON.stringify(payload) });
          return;
        }
        await route.fulfill({ response, body: JSON.stringify(payload) });
      });

      await page.goto(app.origin, { waitUntil: 'domcontentloaded' });
      await page.getByLabel('Repository and scan').selectOption(repositoryId);
      await page.waitForFunction(
        () =>
          !document.querySelector<HTMLInputElement>('#symbol-query')?.disabled,
      );
      await page.getByLabel('Name or source path').fill('inspect');
      await page.getByRole('button', { name: /inspect.*function/ }).click();
      await page.getByRole('tab', { name: 'Trace' }).click();
      const references = page.getByLabel('REFERENCES');
      if (!(await references.isChecked())) await references.check();
      const ambiguousRow = page
        .locator('#trace-panel .relationship-list > li')
        .filter({ hasText: 'REFERENCES' })
        .filter({ hasText: 'ambiguous' });
      await ambiguousRow.waitFor();
      assert.equal(
        await ambiguousRow.getByRole('button', { name: /Follow/ }).count(),
        0,
        'an ambiguous reference must not expose a follow action',
      );

      await page
        .getByText('Show exact relationship diagram', { exact: true })
        .click();
      await page.locator('#trace-panel .trace-graph').waitFor();
      const graphRelationIds = await page
        .locator('#trace-panel .trace-edge')
        .evaluateAll((edges) =>
          edges
            .map((edge) => edge.getAttribute('data-relation-id'))
            .filter((id): id is string => id !== null)
            .sort(),
        );
      const listRelationIds = await page
        .locator('#trace-panel .relationship-list')
        .first()
        .locator('[data-relation-id]')
        .evaluateAll((rows) =>
          rows
            .map((row) => row.getAttribute('data-relation-id'))
            .filter((id): id is string => id !== null),
        );
      assert.deepEqual(
        graphRelationIds,
        exactRelationIds,
        'the graph draws every exact returned edge with present endpoints',
      );
      assert.ok(
        graphRelationIds.every((id) => listRelationIds.includes(id)),
        'every graph edge must have the same relation identity in the list',
      );

      await ambiguousRow
        .getByRole('button', { name: 'Inspect occurrence evidence' })
        .click();
      await page
        .locator('#evidence-inspector [role="status"]')
        .getByText(/Evidence unavailable: SOURCE_UNAVAILABLE/)
        .waitFor();
      assert.equal(unavailableEvidenceInjected, true);
      assert.equal(
        await page.locator('#evidence-inspector .evidence-card').count(),
        0,
        'unavailable source bytes must not render as a verified excerpt',
      );
      assert.equal(
        await ambiguousRow.getAttribute('aria-current'),
        'true',
        'selected relationship row must expose aria-current for non-color truth',
      );

      // UI-01: Inspecting evidence for an unowned/unsupported observation in unknowns must succeed.
      const unknownInspect = page
        .getByRole('region', {
          name: 'Unresolved or unsupported observations',
        })
        .getByRole('button', { name: 'Inspect source evidence' })
        .first();
      await unknownInspect.click();
      await page
        .locator('#evidence-inspector .evidence-card')
        .getByText('exactTarget()')
        .waitFor();
      assert.equal(
        await page
          .locator('.explorer [role="alert"]')
          .getByText(/Evidence selection is not present/)
          .count(),
        0,
      );

      // UI-02: Clicking an analyzed file shows a non-error status notice instead of a red alert.
      await page
        .getByRole('region', { name: 'Source inventory' })
        .getByRole('button', { name: /src\/relations\.ts/ })
        .click();
      await page
        .locator('.explorer [role="status"]')
        .getByText(/Full-file source is not available/)
        .waitFor();
      assert.equal(
        await page
          .locator('.explorer [role="alert"]')
          .getByText(/Full-file source is not available/)
          .count(),
        0,
      );
    } finally {
      await context.close();
      await browser.close();
      await app.close();
    }
  }, 90_000);
});
