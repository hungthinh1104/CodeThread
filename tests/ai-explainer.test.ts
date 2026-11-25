import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { analyzeManifest, COMPILER_PROFILE } from '@codethread/symbol-indexer';
import { createInvestigation } from '@codethread/trace-engine';
import type { AiContextPacket } from '@codethread/contracts';
import {
  AiError,
  buildAiContextPacketFromProjection,
  createAiSynthesizer,
  createGeminiProvider,
  createMockProvider,
  createOpenAiCompatibleProvider,
  extractJsonObject,
  hasRuntimeExecutionOverclaim,
  hashAiContextPacket,
  loadAiConfig,
  sanitizeAiMessage,
  verifyAiModelOutput,
} from '../scripts/ai/index.ts';
import type { FetchLike } from '../scripts/ai/index.ts';

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

interface RealPacketFixture {
  packet: AiContextPacket;
  exactCallRelId: string;
  referenceRelId: string;
  unresolvedRelId: string;
  exactCallEvidenceId: string;
  referenceEvidenceId: string;
  unresolvedEvidenceId: string;
  unresolvedDiagId: string;
  helperSymbolId: string;
}

let cachedPacketPromise: Promise<RealPacketFixture> | null = null;

function buildRealPacket(): Promise<RealPacketFixture> {
  if (cachedPacketPromise !== null) return cachedPacketPromise;
  cachedPacketPromise = (async () => {
    const source = [
      'class Controller { handle(x: string) { return helper(x); } }',
      'function register(cb: (x: string) => string) { return cb; }',
      'function helper(x: string) { return x.trim(); }',
      'export function entry(ctrl: Controller, dyn: unknown, x: string) {',
      '  helper(x);',
      '  register(ctrl.handle);',
      '  (dyn as (v: string) => void)(x);',
      '}',
    ].join('\n');

    const analysis = await analyzeManifest({
      repositoryId: '00000000-0000-4000-8000-0000000000a1',
      compilerOptions: COMPILER_PROFILE,
      files: [
        {
          path: 'src/app.ts',
          bytes: Buffer.from(source, 'utf8'),
          sha256: sha256(source),
        },
      ],
    });
    const investigation = createInvestigation(analysis.facts, analysis.source);
    const entry = analysis.facts.symbols.find((sym) => sym.name === 'entry')!;
    const helper = analysis.facts.symbols.find((sym) => sym.name === 'helper')!;
    const graph = investigation.neighbors({
      snapshotId: analysis.facts.snapshotId,
      symbolId: entry.id,
      direction: 'outgoing',
      relationKinds: ['calls', 'references'],
      depth: 1,
    });
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
    const packet = buildAiContextPacketFromProjection(graph, evidenceBatch);

    const exactCall = packet.relations.find(
      (rel) =>
        rel.kind === 'calls' &&
        rel.resolution === 'exact' &&
        rel.targetSymbolId === helper.id,
    )!;
    const reference = packet.relations.find(
      (rel) => rel.kind === 'references' && rel.resolution === 'exact',
    )!;
    const unresolved = packet.relations.find(
      (rel) => rel.resolution !== 'exact',
    )!;

    return {
      packet,
      exactCallRelId: exactCall.id,
      referenceRelId: reference.id,
      unresolvedRelId: unresolved.id,
      exactCallEvidenceId: exactCall.siteEvidenceId,
      referenceEvidenceId: reference.siteEvidenceId,
      unresolvedEvidenceId: unresolved.siteEvidenceId,
      unresolvedDiagId: unresolved.diagnosticIds[0]!,
      helperSymbolId: helper.id,
    };
  })();
  return cachedPacketPromise;
}

describe('CT-AI-001 config and disabled-by-default guardrails', () => {
  it('defaults to disabled and fails closed without performing network I/O', async () => {
    const config = loadAiConfig({});
    expect(config).toEqual({ enabled: false });

    let fetchCalled = false;
    const failingFetch: FetchLike = async () => {
      fetchCalled = true;
      throw new Error('fetch must not be called');
    };
    const synthesizer = createAiSynthesizer(config, {
      fetchImpl: failingFetch,
    });
    expect(synthesizer.enabled).toBe(false);

    const { packet } = await buildRealPacket();
    await expect(
      synthesizer.synthesize({
        task: 'explain_trace',
        packet,
        maxClaims: 5,
        maxNextSteps: 3,
      }),
    ).rejects.toMatchObject({ code: 'AI_DISABLED' });
    expect(fetchCalled).toBe(false);
  });

  it('validates Gemini and OpenAI-compatible/Ollama configuration safely', () => {
    expect(() =>
      loadAiConfig({
        CODETHREAD_AI_ENABLED: '1',
        CODETHREAD_AI_PROVIDER: 'gemini',
      }),
    ).toThrow(AiError);

    const defaultLocal = loadAiConfig({
      CODETHREAD_AI_ENABLED: '1',
    });
    expect(defaultLocal).toMatchObject({
      enabled: true,
      provider: 'openai_compatible',
      locality: 'local',
      apiKey: null,
      baseUrl: 'http://127.0.0.1:11434/v1',
    });

    expect(() =>
      loadAiConfig({
        CODETHREAD_AI_ENABLED: '1',
        CODETHREAD_AI_PROVIDER: 'gemini',
        GEMINI_API_KEY: 'AIzaSyFakeKeyForUnitTestOnly123456',
      }),
    ).toThrow(/CODETHREAD_AI_ALLOW_REMOTE=1/);

    const gemini = loadAiConfig({
      CODETHREAD_AI_ENABLED: '1',
      CODETHREAD_AI_PROVIDER: 'gemini',
      CODETHREAD_AI_ALLOW_REMOTE: '1',
      GEMINI_API_KEY: 'AIzaSyFakeKeyForUnitTestOnly123456',
    });
    expect(gemini).toMatchObject({
      enabled: true,
      provider: 'gemini',
      locality: 'remote',
      model: 'gemini-2.5-flash',
    });

    const ollama = loadAiConfig({
      CODETHREAD_AI_ENABLED: '1',
      CODETHREAD_AI_PROVIDER: 'ollama',
    });
    expect(ollama).toMatchObject({
      enabled: true,
      provider: 'openai_compatible',
      locality: 'local',
      apiKey: null,
      baseUrl: 'http://127.0.0.1:11434/v1',
    });

    expect(() =>
      loadAiConfig({
        CODETHREAD_AI_ENABLED: '1',
        CODETHREAD_AI_PROVIDER: 'openai_compatible',
        CODETHREAD_AI_BASE_URL: 'http://example.com/v1',
        CODETHREAD_AI_ALLOW_REMOTE: '1',
        CODETHREAD_AI_API_KEY: 'sk-test-1234567890abcdef',
      }),
    ).toThrow(/https or loopback http/);

    expect(() =>
      loadAiConfig({
        CODETHREAD_AI_ENABLED: '1',
        CODETHREAD_AI_PROVIDER: 'openai_compatible',
        CODETHREAD_AI_BASE_URL: 'https://api.example.com/v1',
        CODETHREAD_AI_ALLOW_REMOTE: '1',
      }),
    ).toThrow(/CODETHREAD_AI_API_KEY is required/);
  });

  it('redacts API keys and bearer tokens from error messages', () => {
    const cleaned = sanitizeAiMessage(
      'Failed Bearer secret-token-123 and AIzaSyFakeKeyForUnitTestOnly123456 and sk-live-abcdef1234567890',
    );
    expect(cleaned).not.toContain('secret-token-123');
    expect(cleaned).not.toContain('AIzaSyFakeKey');
    expect(cleaned).not.toContain('sk-live-abcdef');
  });
});

describe('CT-AI-001 deterministic post-verifier (citation-or-silence)', () => {
  it('verifies grounded claims across explain_trace, explain_unknowns, and suggest_next_steps', async () => {
    const fixture = await buildRealPacket();
    const packetHash = hashAiContextPacket(fixture.packet);
    expect(packetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashAiContextPacket(fixture.packet)).toBe(packetHash);

    const provider = createMockProvider(async (input) => {
      expect(input.systemPrompt).toContain('Static evidence NEVER proves');
      if (input.userPrompt.includes('Task: explain_unknowns')) {
        return {
          summary:
            'One call site in entry cannot be resolved statically because dyn is dynamically typed.',
          claims: [
            {
              text: 'The call to dyn is non-exact and remains unresolved statically; this does not prove runtime execution.',
              claimType: 'uncertainty_note',
              assertedRelation: 'non_exact',
              evidenceIds: [fixture.unresolvedEvidenceId],
              symbolIds: [fixture.packet.rootSymbolId],
              relationIds: [fixture.unresolvedRelId],
              diagnosticIds: [fixture.unresolvedDiagId],
            },
          ],
          nextSteps: [],
          uncertainties: ['Dynamic callable parameter cannot be resolved.'],
        };
      }
      return {
        summary:
          'entry contains an exact static call to helper and a method reference to ctrl.handle.',
        claims: [
          {
            text: 'entry statically calls helper (static call only; does not prove runtime execution).',
            claimType: 'observed_fact',
            assertedRelation: 'exact_call',
            evidenceIds: [fixture.exactCallEvidenceId],
            symbolIds: [fixture.packet.rootSymbolId, fixture.helperSymbolId],
            relationIds: [fixture.exactCallRelId],
            diagnosticIds: [],
          },
          {
            text: 'entry passes ctrl.handle as an exact static method reference.',
            claimType: 'observed_fact',
            assertedRelation: 'exact_reference',
            evidenceIds: [fixture.referenceEvidenceId],
            symbolIds: [fixture.packet.rootSymbolId],
            relationIds: [fixture.referenceRelId],
            diagnosticIds: [],
          },
        ],
        nextSteps: [
          {
            symbolId: fixture.helperSymbolId,
            reason: 'Inspect helper implementation for string normalization.',
            supportingEvidenceIds: [fixture.exactCallEvidenceId],
          },
        ],
        uncertainties: ['dyn call target is unresolved statically.'],
      };
    });

    const synthesizer = createAiSynthesizer(
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
      { provider },
    );

    const traceResult = await synthesizer.synthesize({
      task: 'explain_trace',
      packet: fixture.packet,
      maxClaims: 5,
      maxNextSteps: 3,
    });
    expect(traceResult.provenance.packetHash).toBe(packetHash);
    expect(traceResult.evidenceBasis).toBe('static_generated_unverified');
    expect(traceResult.claims).toHaveLength(2);
    expect(traceResult.nextSteps).toHaveLength(1);
    expect(traceResult.verification).toEqual({
      verifiedClaims: 2,
      rejectedClaims: 0,
      verifiedNextSteps: 1,
      rejectedNextSteps: 0,
      rejectedItems: [],
    });

    const unknownsResult = await synthesizer.synthesize({
      task: 'explain_unknowns',
      packet: fixture.packet,
      maxClaims: 5,
      maxNextSteps: 3,
    });
    expect(unknownsResult.claims).toHaveLength(1);
    expect(unknownsResult.claims[0]!.diagnosticIds).toEqual([
      fixture.unresolvedDiagId,
    ]);
  });

  it('rejects hallucinated IDs, relation upgrades, runtime overclaims, and duplicate claims', async () => {
    const fixture = await buildRealPacket();
    const fakeUuid = '00000000-0000-4000-8000-ffffffffffff';
    const verified = verifyAiModelOutput(
      {
        task: 'explain_trace',
        packet: fixture.packet,
        maxClaims: 5,
        maxNextSteps: 3,
      },
      {
        summary: 'entry definitely executes at runtime without errors.',
        claims: [
          {
            text: 'entry statically calls helper.',
            claimType: 'observed_fact',
            assertedRelation: 'exact_call',
            evidenceIds: [fixture.exactCallEvidenceId],
            symbolIds: [fixture.packet.rootSymbolId, fixture.helperSymbolId],
            relationIds: [fixture.exactCallRelId],
            diagnosticIds: [],
          },
          {
            text: 'Fabricated citation claim.',
            claimType: 'observed_fact',
            evidenceIds: [fakeUuid],
            symbolIds: [fakeUuid],
            relationIds: [fakeUuid],
            diagnosticIds: [fakeUuid],
          },
          {
            text: 'Upgrading REFERENCES to exact_call must fail.',
            claimType: 'observed_fact',
            assertedRelation: 'exact_call',
            evidenceIds: [fixture.referenceEvidenceId],
            symbolIds: [],
            relationIds: [fixture.referenceRelId],
            diagnosticIds: [],
          },
          {
            text: 'Upgrading unresolved call to exact_call must fail.',
            claimType: 'observed_fact',
            assertedRelation: 'exact_call',
            evidenceIds: [fixture.unresolvedEvidenceId],
            symbolIds: [],
            relationIds: [fixture.unresolvedRelId],
            diagnosticIds: [],
          },
          {
            text: 'helper executes at runtime and tests pass.',
            claimType: 'observed_fact',
            evidenceIds: [fixture.exactCallEvidenceId],
            symbolIds: [],
            relationIds: [],
            diagnosticIds: [],
          },
          {
            text: '  entry   statically calls helper. ',
            claimType: 'observed_fact',
            assertedRelation: 'exact_call',
            evidenceIds: [fixture.exactCallEvidenceId],
            symbolIds: [fixture.packet.rootSymbolId, fixture.helperSymbolId],
            relationIds: [fixture.exactCallRelId],
            diagnosticIds: [],
          },
        ],
        nextSteps: [
          {
            symbolId: fakeUuid,
            reason: 'Hallucinated follow-up symbol.',
            supportingEvidenceIds: [fixture.exactCallEvidenceId],
          },
          {
            symbolId: fixture.helperSymbolId,
            reason: 'Valid follow-up symbol.',
            supportingEvidenceIds: [fixture.exactCallEvidenceId],
          },
        ],
        uncertainties: [],
      },
      {
        provider: 'mock',
        model: 'mock-replay-v1',
        packetHash: hashAiContextPacket(fixture.packet),
        promptVersion: 'ct-ai-prompt-v1',
      },
    );

    expect(verified.summary).toBeNull();
    expect(verified.claims).toHaveLength(1);
    expect(verified.nextSteps).toHaveLength(1);
    expect(verified.verification.rejectedClaims).toBe(5);
    expect(verified.verification.rejectedNextSteps).toBe(1);

    const byIndex = new Map(
      verified.verification.rejectedItems.map((item) => [
        `${item.kind}:${item.index}`,
        item.reasons,
      ]),
    );
    expect(byIndex.get('claim:1')).toEqual(
      expect.arrayContaining([
        'UNKNOWN_EVIDENCE_ID',
        'UNKNOWN_SYMBOL_ID',
        'UNKNOWN_RELATION_ID',
        'UNKNOWN_DIAGNOSTIC_ID',
      ]),
    );
    expect(byIndex.get('claim:2')).toContain('RELATION_KIND_MISMATCH');
    expect(byIndex.get('claim:3')).toContain('NON_EXACT_UPGRADE');
    expect(byIndex.get('claim:4')).toContain('RUNTIME_EXECUTION_OVERCLAIM');
    expect(byIndex.get('claim:5')).toContain('DUPLICATE_CLAIM');
    expect(byIndex.get('next_step:0')).toContain('UNKNOWN_SYMBOL_ID');
  });

  it('nullifies summary when every model claim is rejected and distinguishes negated runtime disclaimers', async () => {
    expect(
      hasRuntimeExecutionOverclaim(
        'Static evidence does not prove runtime execution or passing tests.',
      ),
    ).toBe(false);
    expect(
      hasRuntimeExecutionOverclaim('This function is guaranteed to execute.'),
    ).toBe(true);

    const fixture = await buildRealPacket();
    const result = verifyAiModelOutput(
      {
        task: 'explain_trace',
        packet: fixture.packet,
        maxClaims: 5,
        maxNextSteps: 3,
      },
      {
        summary: 'Looks normal on the surface.',
        claims: [
          {
            text: 'Cites nonexistent evidence.',
            claimType: 'observed_fact',
            evidenceIds: ['00000000-0000-4000-8000-ffffffffffff'],
            symbolIds: [],
            relationIds: [],
            diagnosticIds: [],
          },
        ],
        nextSteps: [],
        uncertainties: [],
      },
      {
        provider: 'mock',
        model: 'mock-replay-v1',
        packetHash: hashAiContextPacket(fixture.packet),
        promptVersion: 'ct-ai-prompt-v1',
      },
    );
    expect(result.claims).toHaveLength(0);
    expect(result.summary).toBeNull();
    expect(result.verification.rejectedClaims).toBe(1);
  });
});

describe('CT-AI-001 offline provider adapters (Gemini & OpenAI-compatible/Ollama)', () => {
  it('calls Gemini API with header key (never query param) and parses JSON payload', async () => {
    let seenUrl = '';
    let seenHeaders: HeadersInit | undefined;
    const stubFetch: FetchLike = async (url, init) => {
      seenUrl = url;
      seenHeaders = init?.headers;
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: '{"summary":"ok","claims":[]}' }],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const provider = createGeminiProvider(
      {
        enabled: true,
        provider: 'gemini',
        locality: 'remote',
        apiKey: 'AIzaSyFakeKeyForUnitTestOnly123456',
        model: 'gemini-2.5-flash',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        timeoutMs: 5_000,
        maxResponseBytes: 16_384,
      },
      stubFetch,
    );
    const parsed = await provider.generateJson({
      systemPrompt: 'sys',
      userPrompt: 'usr',
    });
    expect(parsed).toEqual({ summary: 'ok', claims: [] });
    expect(seenUrl).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    );
    expect(seenUrl).not.toContain('AIzaSy');
    expect((seenHeaders as Record<string, string>)['x-goog-api-key']).toBe(
      'AIzaSyFakeKeyForUnitTestOnly123456',
    );
  });

  it('calls OpenAI-compatible / Ollama without auth header on loopback and strips fenced JSON', async () => {
    let seenHeaders: Record<string, string> = {};
    const stubFetch: FetchLike = async (_url, init) => {
      seenHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '```json\n{"summary":"local","claims":[]}\n```',
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const provider = createOpenAiCompatibleProvider(
      {
        enabled: true,
        provider: 'openai_compatible',
        locality: 'local',
        apiKey: null,
        model: 'qwen2.5-coder:7b',
        baseUrl: 'http://127.0.0.1:11434/v1',
        timeoutMs: 5_000,
        maxResponseBytes: 16_384,
      },
      stubFetch,
    );
    const parsed = await provider.generateJson({
      systemPrompt: 'sys',
      userPrompt: 'usr',
    });
    expect(parsed).toEqual({ summary: 'local', claims: [] });
    expect(seenHeaders['authorization']).toBeUndefined();
  });

  it('enforces response byte caps, HTTP error mapping, timeout mapping, and strict JSON extraction', async () => {
    const oversizedFetch: FetchLike = async () =>
      new Response('x'.repeat(5_000), { status: 200 });
    const gemini = createGeminiProvider(
      {
        enabled: true,
        provider: 'gemini',
        locality: 'remote',
        apiKey: 'AIzaSyFakeKeyForUnitTestOnly123456',
        model: 'gemini-2.5-flash',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        timeoutMs: 5_000,
        maxResponseBytes: 128,
      },
      oversizedFetch,
    );
    await expect(
      gemini.generateJson({ systemPrompt: 's', userPrompt: 'u' }),
    ).rejects.toMatchObject({ code: 'AI_RESPONSE_TOO_LARGE' });

    const errorFetch: FetchLike = async () =>
      new Response('internal error', { status: 503 });
    const ollama = createOpenAiCompatibleProvider(
      {
        enabled: true,
        provider: 'openai_compatible',
        locality: 'local',
        apiKey: null,
        model: 'qwen2.5-coder:7b',
        baseUrl: 'http://127.0.0.1:11434/v1',
        timeoutMs: 5_000,
        maxResponseBytes: 16_384,
      },
      errorFetch,
    );
    await expect(
      ollama.generateJson({ systemPrompt: 's', userPrompt: 'u' }),
    ).rejects.toMatchObject({ code: 'AI_PROVIDER_ERROR' });

    const timeoutFetch: FetchLike = async () => {
      const error = new Error('The operation was aborted due to timeout');
      error.name = 'TimeoutError';
      throw error;
    };
    const timeoutProvider = createOpenAiCompatibleProvider(
      {
        enabled: true,
        provider: 'openai_compatible',
        locality: 'local',
        apiKey: null,
        model: 'qwen2.5-coder:7b',
        baseUrl: 'http://127.0.0.1:11434/v1',
        timeoutMs: 1_000,
        maxResponseBytes: 16_384,
      },
      timeoutFetch,
    );
    await expect(
      timeoutProvider.generateJson({ systemPrompt: 's', userPrompt: 'u' }),
    ).rejects.toMatchObject({ code: 'AI_PROVIDER_TIMEOUT' });

    expect(() => extractJsonObject('not json at all')).toThrow(AiError);
    expect(() => extractJsonObject('[1, 2, 3]')).toThrow(AiError);
  });
});
