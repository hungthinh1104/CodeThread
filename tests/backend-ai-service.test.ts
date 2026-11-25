import { createHash } from 'node:crypto';
import { analyzeManifest, COMPILER_PROFILE } from '@codethread/symbol-indexer';
import { createInvestigation } from '@codethread/trace-engine';
import { describe, expect, it } from 'vitest';
import type { AiContextPacket } from '@codethread/contracts';
import { createMockProvider } from '../scripts/ai/index.ts';
import { BackendAiService } from '../scripts/backend/ai-service.ts';
import type { AiProjectionReader } from '../scripts/backend/ai-service.ts';

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function createInMemoryProjectionHarness() {
  const source = [
    'export function helper(v: string) { return v.trim(); }',
    'export function entry(v: string) { return helper(v); }',
  ].join('\n');
  const analysis = await analyzeManifest({
    repositoryId: '00000000-0000-4000-8000-0000000000c1',
    compilerOptions: COMPILER_PROFILE,
    files: [
      {
        path: 'src/index.ts',
        bytes: Buffer.from(source, 'utf8'),
        sha256: sha256(source),
      },
    ],
  });
  const investigation = createInvestigation(analysis.facts, analysis.source);
  const entry = analysis.facts.symbols.find((sym) => sym.name === 'entry')!;
  let activeHeavy = 0;
  let projectionCalls = 0;

  const reader: AiProjectionReader & {
    readonly activeHeavyCount: () => number;
    readonly projectionCallCount: () => number;
  } = {
    activeHeavyCount: () => activeHeavy,
    projectionCallCount: () => projectionCalls,
    async aiProjection(_jobId, _projectId, neighborsInput) {
      projectionCalls++;
      activeHeavy++;
      try {
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
          snapshotId: analysis.facts.snapshotId,
          evidenceIds,
        });
        return { graph, evidenceBatch };
      } finally {
        activeHeavy--;
      }
    },
  };

  return {
    reader,
    snapshotId: analysis.facts.snapshotId,
    entryId: entry.id,
  };
}

describe('CT-AI-001 BackendAiService', () => {
  it('fails closed with 503 AI_DISABLED without hydrating snapshots when off', async () => {
    const harness = await createInMemoryProjectionHarness();
    const service = new BackendAiService(harness.reader, { enabled: false });

    expect(service.status()).toEqual({ enabled: false });
    await expect(
      service.synthesize(
        '00000000-0000-4000-8000-000000000001',
        'project:root',
        {
          task: 'explain_trace',
          neighbors: {
            snapshotId: harness.snapshotId,
            symbolId: harness.entryId,
          },
        },
      ),
    ).rejects.toMatchObject({ status: 503, code: 'AI_DISABLED' });
    expect(harness.reader.projectionCallCount()).toBe(0);
  });

  it('releases heavy-query slots before provider I/O, caches by packetHash, and caps concurrency at 2', async () => {
    const harness = await createInMemoryProjectionHarness();
    let providerCalls = 0;
    let heavyDuringProvider = -1;
    let releaseSlowCall: (() => void) | null = null;

    const provider = createMockProvider(async (input) => {
      providerCalls++;
      heavyDuringProvider = harness.reader.activeHeavyCount();
      if (releaseSlowCall) {
        await new Promise<void>((resolve) => {
          const prev = releaseSlowCall!;
          releaseSlowCall = () => {
            prev();
            resolve();
          };
        });
      }
      const packet = JSON.parse(
        input.userPrompt.split('\n\n').at(-1)!,
      ) as AiContextPacket;
      const rel = packet.relations[0]!;
      return {
        summary: 'entry statically calls helper.',
        claims: [
          {
            text: 'entry statically calls helper.',
            claimType: 'observed_fact',
            assertedRelation: 'exact_call',
            evidenceIds: [rel.siteEvidenceId],
            symbolIds: [rel.sourceSymbolId, rel.targetSymbolId!],
            relationIds: [rel.id],
            diagnosticIds: [],
          },
        ],
        nextSteps: [],
        uncertainties: [],
      };
    });

    const service = new BackendAiService(
      harness.reader,
      {
        enabled: true,
        provider: 'openai_compatible',
        locality: 'local',
        apiKey: null,
        model: 'qwen2.5-coder:7b',
        baseUrl: 'http://127.0.0.1:11434/v1',
        timeoutMs: 5_000,
        maxResponseBytes: 65_536,
      },
      { provider, maxConcurrent: 2 },
    );

    expect(service.status()).toEqual({
      enabled: true,
      provider: 'openai_compatible',
      locality: 'local',
      model: 'qwen2.5-coder:7b',
    });

    const reqBody = {
      task: 'explain_trace' as const,
      neighbors: {
        snapshotId: harness.snapshotId,
        symbolId: harness.entryId,
        direction: 'outgoing' as const,
        relationKinds: ['calls' as const],
        depth: 1,
      },
    };
    const first = await service.synthesize(
      '00000000-0000-4000-8000-000000000001',
      'project:root',
      reqBody,
    );
    expect(heavyDuringProvider).toBe(0);
    expect(providerCalls).toBe(1);
    expect(first.claims).toHaveLength(1);

    // Repeat request hits cache without calling the provider again.
    const cached = await service.synthesize(
      '00000000-0000-4000-8000-000000000001',
      'project:root',
      reqBody,
    );
    expect(cached).toEqual(first);
    expect(providerCalls).toBe(1);

    // Concurrency cap: 2 in-flight requests succeed, 3rd returns 429 AI_CAPACITY_EXCEEDED.
    releaseSlowCall = () => {};
    const slowA = service.synthesize(
      '00000000-0000-4000-8000-000000000001',
      'project:root',
      { ...reqBody, task: 'explain_unknowns' },
    );
    const slowB = service.synthesize(
      '00000000-0000-4000-8000-000000000001',
      'project:root',
      { ...reqBody, task: 'suggest_next_steps' },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(
      service.synthesize(
        '00000000-0000-4000-8000-000000000001',
        'project:root',
        { ...reqBody, maxClaims: 2 },
      ),
    ).rejects.toMatchObject({ status: 429, code: 'AI_CAPACITY_EXCEEDED' });

    const finish = releaseSlowCall;
    releaseSlowCall = null;
    finish();
    await Promise.all([slowA, slowB]);
    expect(service.activeSynthesisCount).toBe(0);
  });
});
