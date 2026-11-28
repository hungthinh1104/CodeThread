import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import type { AiContextPacket } from '@codethread/contracts';
import { analyzeManifest, COMPILER_PROFILE } from '@codethread/symbol-indexer';
import { createInvestigation } from '@codethread/trace-engine';
import { createMockProvider } from '../scripts/ai/index.ts';
import {
  BackendAiService,
  type AiProjectionReader,
} from '../scripts/backend/ai-service.ts';
import { startWorkspaceApp } from './browser/workspace-app.ts';

const repositoryId = '85555555-5555-4555-8555-555555555555';
const source = Buffer.from(
  [
    'export function leaf(value: number) {',
    '  return value + 1;',
    '}',
    '',
    'export function mid(value: number) {',
    '  return leaf(value);',
    '}',
    '',
    'export function entry(value: number) {',
    '  return mid(value);',
    '}',
    '',
  ].join('\n'),
);

const snapshot = await analyzeManifest({
  repositoryId,
  compilerOptions: COMPILER_PROFILE,
  files: [
    {
      path: 'src/pipeline.ts',
      bytes: source,
      sha256: createHash('sha256').update(source).digest('hex'),
    },
  ],
});

function createInMemoryAiService() {
  const investigation = createInvestigation(snapshot.facts, snapshot.source);
  const reader: AiProjectionReader = {
    async aiProjection(_jobId, _projectId, neighborsInput) {
      const graph = investigation.neighbors(
        neighborsInput as Parameters<typeof investigation.neighbors>[0],
      );
      const evidenceIds = [
        ...new Set([
          ...graph.symbols.map((sym) => sym.declarationEvidenceId),
          ...graph.relations.flatMap((rel) => rel.resolution.evidenceIds),
        ]),
      ];
      const evidenceBatch = investigation.sourceEvidence({
        snapshotId: snapshot.facts.snapshotId,
        evidenceIds,
      });
      return { graph, evidenceBatch };
    },
    async aiPathProjection(_jobId, _projectId, pathsInput) {
      const paths = investigation.paths(
        pathsInput as Parameters<typeof investigation.paths>[0],
      );
      const evidenceIds = [
        ...new Set([
          ...paths.symbols.map((sym) => sym.declarationEvidenceId),
          ...paths.relations.flatMap((rel) => rel.resolution.evidenceIds),
        ]),
      ];
      const evidenceBatch = investigation.sourceEvidence({
        snapshotId: snapshot.facts.snapshotId,
        evidenceIds,
      });
      return { paths, evidenceBatch };
    },
  };

  const provider = createMockProvider(async (input) => {
    const packet = JSON.parse(
      input.userPrompt.split('\n\n').at(-1)!,
    ) as AiContextPacket;
    const isPath = input.userPrompt.includes('Task: explain_path');
    const firstRel = packet.relations[0]!;
    const targetSym = packet.symbols.find(
      (sym) => sym.id === firstRel.targetSymbolId,
    );
    return {
      summary: isPath
        ? 'entry reaches leaf through mid via two exact static calls.'
        : 'entry statically calls mid in src/pipeline.ts.',
      claims: [
        {
          text: isPath
            ? 'entry statically calls mid as the first hop toward leaf.'
            : 'entry statically calls mid.',
          claimType: 'observed_fact',
          assertedRelation: 'exact_call',
          evidenceIds: [firstRel.siteEvidenceId],
          symbolIds: [firstRel.sourceSymbolId, firstRel.targetSymbolId!],
          relationIds: [firstRel.id],
          diagnosticIds: [],
        },
        {
          // Deliberately ungrounded claim to prove verifier drops it and discloses rejection.
          text: 'entry executes at runtime on every HTTP request.',
          claimType: 'observed_fact',
          assertedRelation: 'exact_call',
          evidenceIds: [firstRel.siteEvidenceId],
          symbolIds: [firstRel.sourceSymbolId],
          relationIds: [firstRel.id],
          diagnosticIds: [],
        },
      ],
      nextSteps: targetSym
        ? [
            {
              symbolId: targetSym.id,
              reason: 'Inspect mid to follow its outgoing call to leaf.',
              supportingEvidenceIds: [firstRel.siteEvidenceId],
            },
          ]
        : [],
      uncertainties: ['Static analysis does not prove runtime invocation.'],
    };
  });

  return new BackendAiService(
    reader,
    {
      enabled: true,
      provider: 'gemini',
      locality: 'remote',
      apiKey: 'AIzaSyFakeKeyForPlaywrightE2EOnly1234',
      model: 'gemini-2.5-flash',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      timeoutMs: 5_000,
      maxResponseBytes: 65_536,
    },
    { provider },
  );
}

describe('Investigation Workspace optional AI Notes tab (CT-AI-001)', () => {
  it('hides Notes tab and Explain path action completely when AI is disabled by default', async () => {
    const app = await startWorkspaceApp(snapshot);
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    page.setDefaultTimeout(15_000);

    try {
      await page.goto(app.origin, { waitUntil: 'domcontentloaded' });
      await page.getByLabel('Repository and scan').selectOption(repositoryId);
      await page.waitForFunction(
        () =>
          !document.querySelector<HTMLInputElement>('#symbol-query')?.disabled,
      );

      expect(await page.getByRole('tab', { name: 'Notes' }).count()).toBe(0);

      await page.getByRole('button', { name: /entry.*function/ }).click();
      await page.locator('.source-excerpt .code-line').first().waitFor();
      await page.getByRole('tab', { name: 'Paths' }).click();
      await page
        .locator('#paths-panel .paths-candidate-list button', {
          hasText: 'leaf',
        })
        .click();
      await page.getByRole('button', { name: 'Find paths' }).click();
      await page.getByText('1 exact path(s)').waitFor();
      expect(
        await page.getByRole('button', { name: 'Explain path' }).count(),
      ).toBe(0);
    } finally {
      await browser.close();
      await app.close();
    }
  }, 90_000);

  it('drafts verified trace and path notes, opens citations side-by-side in Evidence, discloses verifier rejections, and clears stale notes on symbol switch', async () => {
    const aiService = createInMemoryAiService();
    const app = await startWorkspaceApp(snapshot, {
      ai: {
        status: aiService.status(),
        synthesize: (body) =>
          aiService.synthesize(
            '33333333-3333-4333-8333-333333333333',
            'workspace-test-project',
            body,
          ),
      },
    });
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    page.setDefaultTimeout(15_000);

    try {
      await page.goto(app.origin, { waitUntil: 'domcontentloaded' });
      await page.getByLabel('Repository and scan').selectOption(repositoryId);
      await page.waitForFunction(
        () =>
          !document.querySelector<HTMLInputElement>('#symbol-query')?.disabled,
      );

      const notesTab = page.getByRole('tab', { name: 'Notes' });
      await notesTab.waitFor();

      // Select entry and draft Trace summary notes.
      await page.getByRole('button', { name: /entry.*function/ }).click();
      await page.locator('.source-excerpt .code-line').first().waitFor();

      await notesTab.click();
      await page.getByText('Remote · gemini-2.5-flash').waitFor();
      await page.getByRole('button', { name: 'Draft notes' }).click();

      const notesPanel = page.locator('#notes-panel');
      await notesPanel
        .getByText('entry statically calls mid in src/pipeline.ts.')
        .waitFor();
      await notesPanel.getByText('entry statically calls mid.').waitFor();
      await notesPanel.getByText('Verified 1 of 2 claims').waitFor();

      // Verify rejected runtime-overclaim was dropped and disclosed.
      const rejectedSummary = notesPanel.locator('details.diagnostics summary');
      await rejectedSummary.click();
      await notesPanel.getByText('RUNTIME_EXECUTION_OVERCLAIM').waitFor();

      // Click citation chip and verify SHA-256 excerpt opens side-by-side in Evidence while staying on Notes.
      const citationBtn = notesPanel.locator('.notes-cite-btn').first();
      await citationBtn.click();
      const inspector = page.locator('#evidence-inspector');
      await inspector.getByText('Occurrence evidence').waitFor();
      await inspector.getByText(/mid\(value\)/).waitFor();
      expect(await notesTab.getAttribute('aria-selected')).toBe('true');

      // Use Explain path shortcut from Paths tab.
      await page.getByRole('tab', { name: 'Paths' }).click();
      await page
        .locator('#paths-panel .paths-candidate-list button', {
          hasText: 'leaf',
        })
        .click();
      await page.getByRole('button', { name: 'Find paths' }).click();
      await page.getByText('1 exact path(s)').waitFor();
      await page.getByRole('button', { name: 'Explain path' }).click();

      expect(await notesTab.getAttribute('aria-selected')).toBe('true');
      await notesPanel
        .getByText('entry reaches leaf through mid via two exact static calls.')
        .waitFor();

      // Switching symbols clears stale notes cleanly.
      await page.getByRole('button', { name: /leaf.*function/ }).click();
      await notesTab.click();
      await notesPanel.getByText('No generated notes yet').waitFor();
      expect(
        await notesPanel
          .getByText(
            'entry reaches leaf through mid via two exact static calls.',
          )
          .count(),
      ).toBe(0);
    } finally {
      await browser.close();
      await app.close();
    }
  }, 90_000);
});
