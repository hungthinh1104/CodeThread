import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { analyzeManifest, COMPILER_PROFILE } from '@codethread/symbol-indexer';
import type { AiSynthesizeApiRequest } from '@codethread/contracts';
import { startWorkspaceApp } from './browser/workspace-app.ts';

const repositoryId = '52222222-2222-4222-8222-222222222222';
const source = Buffer.from(
  [
    'export function helper(input: string) {',
    '  return input.trim();',
    '}',
    '',
    'export function alternate(input: string) {',
    '  return input.toLowerCase();',
    '}',
    '',
    'export function entry(input: string) {',
    '  return helper(input);',
    '}',
    '',
  ].join('\n'),
);

const snapshot = await analyzeManifest({
  repositoryId,
  compilerOptions: COMPILER_PROFILE,
  files: [
    {
      path: 'src/workflow.ts',
      bytes: source,
      sha256: createHash('sha256').update(source).digest('hex'),
    },
  ],
});

describe('Investigation Workspace optional 04 / Generated notes (CT-AI-001)', () => {
  it('renders nothing and issues zero AI requests when AI is disabled by default', async () => {
    const app = await startWorkspaceApp(snapshot);
    const browser = await chromium.launch({ headless: true });
    const page = await (await browser.newContext()).newPage();
    page.setDefaultTimeout(15_000);
    const seenUrls: string[] = [];
    page.on('request', (req) => seenUrls.push(new URL(req.url()).pathname));

    try {
      await page.goto(app.origin, { waitUntil: 'domcontentloaded' });
      await page.getByLabel('Repository and scan').selectOption(repositoryId);
      await page.waitForFunction(
        () =>
          !document.querySelector<HTMLInputElement>('#symbol-query')?.disabled,
      );
      await page.getByLabel('Name or source path').fill('entry');
      await page.getByRole('button', { name: /entry.*function/ }).click();

      expect(await page.locator('#generated-notes').count()).toBe(0);
      expect(await page.getByText('04 / Generated notes').count()).toBe(0);
      expect(seenUrls.filter((path) => path.includes('/ai'))).toEqual([]);
    } finally {
      await browser.close();
      await app.close();
    }
  }, 45_000);

  it('keeps editorial presentation, never auto-runs, navigates to verified excerpts, and discloses withheld items', async () => {
    const entry = snapshot.facts.symbols.find((sym) => sym.name === 'entry')!;
    const helper = snapshot.facts.symbols.find((sym) => sym.name === 'helper')!;
    const callRel = snapshot.facts.relations.find(
      (rel) =>
        rel.sourceSymbolId === entry.id &&
        rel.resolution.status === 'exact' &&
        rel.resolution.targetId === helper.id,
    )!;
    assert.ok(callRel, 'fixture must contain entry -> helper call relation');

    let aiCalls = 0;
    const app = await startWorkspaceApp(snapshot, {
      aiStatus: {
        enabled: true,
        provider: 'gemini',
        locality: 'remote',
        model: 'gemini-2.5-flash',
      },
      onAiSynthesize: (raw) => {
        aiCalls++;
        const req = raw as AiSynthesizeApiRequest;
        return {
          version: 1,
          snapshotId: req.neighbors.snapshotId,
          rootSymbolId: req.neighbors.symbolId,
          task: req.task,
          evidenceBasis: 'static_generated_unverified',
          disclaimer:
            'Generated static synthesis (unverified). Static relationships and source excerpts do not prove runtime execution or passing tests.',
          provenance: {
            provider: 'gemini',
            model: 'gemini-2.5-flash',
            packetHash: 'a'.repeat(64),
            promptVersion: 'ct-ai-prompt-v2',
          },
          context: {
            truncated: false,
            truncationReasons: [],
            omitted: { symbols: 2, relations: 0, excerpts: 0, diagnostics: 0 },
            redactedExcerpts: 1,
          },
          summary: 'entry statically delegates normalization to helper.',
          claims: [
            {
              text: 'entry contains a direct static call site targeting helper.',
              claimType: 'observed_fact',
              assertedRelation: 'exact_call',
              evidenceIds: [callRel.siteEvidenceId],
              symbolIds: [entry.id, helper.id],
              relationIds: [callRel.id],
              diagnosticIds: [],
            },
          ],
          nextSteps: [
            {
              symbolId: helper.id,
              reason: 'Inspect helper trim behavior.',
              supportingEvidenceIds: [helper.declarationEvidenceId],
            },
          ],
          uncertainties: ['Caller input validation occurs upstream.'],
          verification: {
            verifiedClaims: 1,
            rejectedClaims: 1,
            verifiedNextSteps: 1,
            rejectedNextSteps: 0,
            rejectedItems: [
              {
                kind: 'claim',
                index: 1,
                reasons: ['UNKNOWN_EVIDENCE_ID'],
              },
            ],
          },
        };
      },
    });

    const browser = await chromium.launch({ headless: true });
    const page = await (
      await browser.newContext({ viewport: { width: 1440, height: 900 } })
    ).newPage();
    page.setDefaultTimeout(15_000);

    try {
      await page.goto(app.origin, { waitUntil: 'domcontentloaded' });
      const notesRegion = page.locator('#generated-notes');
      await notesRegion.waitFor();
      await notesRegion
        .getByText(
          /remote \(gemini-2\.5-flash — selected excerpts leave this machine\)/,
        )
        .waitFor();
      expect(await page.locator('#draft-ai-notes').isDisabled()).toBe(true);

      await page.getByLabel('Repository and scan').selectOption(repositoryId);
      await page.waitForFunction(
        () =>
          !document.querySelector<HTMLInputElement>('#symbol-query')?.disabled,
      );
      await page.getByLabel('Name or source path').fill('entry');
      await page.getByRole('button', { name: /entry.*function/ }).click();
      await page.locator('#evidence-inspector .evidence-card').waitFor();

      // Selecting a symbol must NEVER auto-invoke AI synthesis.
      expect(aiCalls).toBe(0);

      await page.locator('#draft-ai-notes').click();
      await notesRegion
        .getByText('Citations verified: 1 of 2 claims')
        .waitFor();
      expect(aiCalls).toBe(1);

      // Real relation kind & resolution come from snapshot facts.
      await notesRegion.getByText('CALLS · exact').waitFor();
      await notesRegion
        .getByText(
          /packet omitted 2 symbols · 1 excerpt\(s\) redacted before synthesis/,
        )
        .waitFor();

      // Withheld claims are auditable via explicit disclosure.
      await notesRegion.getByText('Withheld by verifier (1)').click();
      await notesRegion.getByText('claim #2: UNKNOWN_EVIDENCE_ID').waitFor();

      // Clicking a monospace evidence anchor opens that verified excerpt in 03 / Evidence.
      await notesRegion.locator('.ai-claim-list .ai-anchor').first().click();
      await page.waitForFunction(() => {
        const text =
          document.querySelector('#evidence-inspector .evidence-text')
            ?.textContent ?? '';
        return text.includes('helper(input)');
      });

      // Narrow 390px drawer keeps 04 / Generated notes without horizontal overflow.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('#inspector-toggle').click();
      await page.locator('#evidence-inspector.is-open').waitFor();
      const overflow = await page.evaluate(() => {
        const el = document.getElementById('evidence-inspector')!;
        return el.scrollWidth > el.clientWidth + 1;
      });
      expect(overflow).toBe(false);

      const html = await page.content();
      expect(html).not.toContain('workspace-browser-backend-token');
    } finally {
      await browser.close();
      await app.close();
    }
  }, 60_000);

  it('discards delayed AI responses after symbol switch and supports retry after error', async () => {
    const entry = snapshot.facts.symbols.find((sym) => sym.name === 'entry')!;
    let releaseFirst: (() => void) | null = null;

    const app = await startWorkspaceApp(snapshot, {
      aiStatus: {
        enabled: true,
        provider: 'openai_compatible',
        locality: 'local',
        model: 'qwen2.5-coder:7b',
      },
      onAiSynthesize: async (raw) => {
        const req = raw as AiSynthesizeApiRequest;
        if (releaseFirst) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return {
          version: 1,
          snapshotId: req.neighbors.snapshotId,
          rootSymbolId: req.neighbors.symbolId,
          task: req.task,
          evidenceBasis: 'static_generated_unverified',
          disclaimer: 'Static synthesis disclaimer.',
          provenance: {
            provider: 'openai_compatible',
            model: 'qwen2.5-coder:7b',
            packetHash: 'b'.repeat(64),
            promptVersion: 'ct-ai-prompt-v2',
          },
          context: {
            truncated: false,
            truncationReasons: [],
            omitted: { symbols: 0, relations: 0, excerpts: 0, diagnostics: 0 },
            redactedExcerpts: 0,
          },
          summary:
            req.neighbors.symbolId === entry.id
              ? 'STALE_ENTRY_SUMMARY'
              : 'FRESH_ALTERNATE_SUMMARY',
          claims: [],
          nextSteps: [],
          uncertainties: [],
          verification: {
            verifiedClaims: 0,
            rejectedClaims: 0,
            verifiedNextSteps: 0,
            rejectedNextSteps: 0,
            rejectedItems: [],
          },
        };
      },
    });

    const browser = await chromium.launch({ headless: true });
    const page = await (await browser.newContext()).newPage();
    page.setDefaultTimeout(15_000);

    try {
      await page.goto(app.origin, { waitUntil: 'domcontentloaded' });
      await page.getByLabel('Repository and scan').selectOption(repositoryId);
      await page.waitForFunction(
        () =>
          !document.querySelector<HTMLInputElement>('#symbol-query')?.disabled,
      );
      await page.getByLabel('Name or source path').fill('entry');
      await page.getByRole('button', { name: /entry.*function/ }).click();
      await page.locator('#evidence-inspector .evidence-card').waitFor();

      // Hold the in-flight request for `entry`, switch to `alternate`, then release.
      releaseFirst = () => {};
      await page.locator('#draft-ai-notes').click();
      await page
        .getByText('Drafting static notes from verified snapshot…')
        .waitFor();

      await page.getByLabel('Name or source path').fill('alternate');
      await page.getByRole('button', { name: /alternate.*function/ }).click();
      const finishStale = releaseFirst;
      releaseFirst = null;
      finishStale();
      await page.waitForTimeout(250);
      expect(await page.getByText('STALE_ENTRY_SUMMARY').count()).toBe(0);

      // Inject one transient 429 error and verify Retry notes recovers cleanly.
      let failOnce = true;
      await page.route('**/api/workspace/ai', async (route) => {
        if (failOnce) {
          failOnce = false;
          await route.fulfill({
            status: 429,
            contentType: 'application/json',
            body: JSON.stringify({
              error: {
                code: 'AI_CAPACITY_EXCEEDED',
                message: 'Too many AI synthesis requests are active.',
              },
            }),
          });
          return;
        }
        await route.fallback();
      });

      await page.locator('#draft-ai-notes').click();
      await page.getByText(/AI_CAPACITY_EXCEEDED/).waitFor();
      await page.getByRole('button', { name: 'Retry notes' }).click();
      await page.getByText('FRESH_ALTERNATE_SUMMARY').waitFor();
    } finally {
      await browser.close();
      await app.close();
    }
  }, 60_000);
});
