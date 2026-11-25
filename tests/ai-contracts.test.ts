import { describe, expect, it } from 'vitest';
import {
  AI_MAX_EXCERPT_UTF8_BYTES,
  aiContextPacketSchema,
  aiSynthesisResponseSchema,
  aiSynthesizeRequestSchema,
  parseAiSynthesisResult,
} from '@codethread/contracts';
import type {
  AiContextPacket,
  AiSynthesisResponse,
  AiSynthesizeRequest,
} from '@codethread/contracts';

const SNAPSHOT_ID = '00000000-0000-4000-8000-000000000101';
const OTHER_SNAPSHOT_ID = '00000000-0000-4000-8000-000000000199';
const ROOT_ID = '00000000-0000-4000-8000-000000000201';
const CALLEE_ID = '00000000-0000-4000-8000-000000000202';
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000299';
const REL_CALL_ID = '00000000-0000-4000-8000-000000000301';
const REL_UNRESOLVED_ID = '00000000-0000-4000-8000-000000000302';
const EV_ROOT_ID = '00000000-0000-4000-8000-000000000401';
const EV_CALL_ID = '00000000-0000-4000-8000-000000000402';
const EV_UNRESOLVED_ID = '00000000-0000-4000-8000-000000000403';
const DIAG_ID = '00000000-0000-4000-8000-000000000501';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function samplePacket(): AiContextPacket {
  return {
    version: 1,
    snapshotId: SNAPSHOT_ID,
    rootSymbolId: ROOT_ID,
    coverage: 'partial',
    coverageByCapability: {
      'symbol.declarations.v1': 'complete',
      'symbol.calls.v1': 'partial',
    },
    truncated: false,
    truncationReasons: [],
    omitted: { symbols: 0, relations: 0, excerpts: 0, diagnostics: 0 },
    symbols: [
      {
        id: ROOT_ID,
        name: 'handleRequest',
        kind: 'function',
        filePath: 'src/handler.ts',
        line: 3,
        declarationEvidenceId: EV_ROOT_ID,
      },
      {
        id: CALLEE_ID,
        name: 'validateInput',
        kind: 'function',
        filePath: 'src/validate.ts',
        line: 1,
        declarationEvidenceId: EV_CALL_ID,
      },
    ],
    relations: [
      {
        id: REL_CALL_ID,
        sourceSymbolId: ROOT_ID,
        targetSymbolId: CALLEE_ID,
        kind: 'calls',
        resolution: 'exact',
        siteEvidenceId: EV_CALL_ID,
        evidenceIds: [EV_CALL_ID],
        diagnosticIds: [],
      },
      {
        id: REL_UNRESOLVED_ID,
        sourceSymbolId: ROOT_ID,
        targetSymbolId: null,
        kind: 'calls',
        resolution: 'unresolved',
        siteEvidenceId: EV_UNRESOLVED_ID,
        evidenceIds: [EV_UNRESOLVED_ID],
        diagnosticIds: [DIAG_ID],
      },
    ],
    excerpts: [
      {
        evidenceId: EV_ROOT_ID,
        filePath: 'src/handler.ts',
        contentHash: HASH_A,
        startLine: 3,
        endLine: 6,
        text: 'export function handleRequest(x: string) { return validateInput(x); }',
        redacted: false,
      },
      {
        evidenceId: EV_CALL_ID,
        filePath: 'src/handler.ts',
        contentHash: HASH_A,
        startLine: 4,
        endLine: 4,
        text: 'validateInput(x)',
        redacted: false,
      },
      {
        evidenceId: EV_UNRESOLVED_ID,
        filePath: 'src/handler.ts',
        contentHash: HASH_A,
        startLine: 5,
        endLine: 5,
        text: 'dispatchDynamic(x)',
        redacted: false,
      },
    ],
    diagnostics: [
      {
        id: DIAG_ID,
        code: 'UNRESOLVED_CALL_TARGET',
        severity: 'warning',
        message: 'Dynamic dispatch target could not be resolved statically.',
        filePath: 'src/handler.ts',
        line: 5,
      },
    ],
  };
}

function sampleRequest(): AiSynthesizeRequest {
  return aiSynthesizeRequestSchema.parse({
    task: 'explain_trace',
    packet: samplePacket(),
  });
}

function sampleResponse(): AiSynthesisResponse {
  return {
    version: 1,
    snapshotId: SNAPSHOT_ID,
    rootSymbolId: ROOT_ID,
    task: 'explain_trace',
    evidenceBasis: 'static_generated_unverified',
    disclaimer:
      'Generated static synthesis (unverified). Static evidence does not prove runtime execution.',
    provenance: {
      provider: 'mock',
      model: 'mock-replay-v1',
      packetHash: HASH_B,
      promptVersion: 'ct-ai-prompt-v2',
    },
    context: {
      truncated: false,
      truncationReasons: [],
      omitted: { symbols: 0, relations: 0, excerpts: 0, diagnostics: 0 },
      redactedExcerpts: 0,
    },
    summary:
      'handleRequest statically calls validateInput and contains one unresolved dynamic call.',
    claims: [
      {
        text: 'handleRequest has an exact static call to validateInput.',
        claimType: 'observed_fact',
        assertedRelation: 'exact_call',
        evidenceIds: [EV_CALL_ID],
        symbolIds: [ROOT_ID, CALLEE_ID],
        relationIds: [REL_CALL_ID],
        diagnosticIds: [],
      },
    ],
    nextSteps: [
      {
        symbolId: CALLEE_ID,
        reason: 'Inspect validateInput declaration to see input constraints.',
        supportingEvidenceIds: [EV_CALL_ID],
      },
    ],
    uncertainties: ['Dynamic call at src/handler.ts:5 remains unresolved.'],
    verification: {
      verifiedClaims: 1,
      rejectedClaims: 0,
      verifiedNextSteps: 1,
      rejectedNextSteps: 0,
      rejectedItems: [],
    },
  };
}

describe('CT-AI-001 AI contracts', () => {
  it('accepts a valid bounded packet and request-matched synthesis response', () => {
    const request = sampleRequest();
    const response = parseAiSynthesisResult(request, sampleResponse());
    expect(response.evidenceBasis).toBe('static_generated_unverified');
    expect(response.claims).toHaveLength(1);
  });

  it('rejects malformed packets: mismatched coverage, missing root, invalid relation, or byte budget overflow', () => {
    const badCoverage = samplePacket();
    badCoverage.coverage = 'complete';
    expect(() => aiContextPacketSchema.parse(badCoverage)).toThrow();

    const missingRoot = samplePacket();
    missingRoot.rootSymbolId = UNKNOWN_ID;
    expect(() => aiContextPacketSchema.parse(missingRoot)).toThrow();

    const exactWithoutTarget = samplePacket();
    exactWithoutTarget.relations[0]!.targetSymbolId = null;
    expect(() => aiContextPacketSchema.parse(exactWithoutTarget)).toThrow();

    const unresolvedWithoutDiag = samplePacket();
    unresolvedWithoutDiag.relations[1]!.diagnosticIds = [];
    expect(() => aiContextPacketSchema.parse(unresolvedWithoutDiag)).toThrow();

    const oversized = samplePacket();
    const chunk = 'x'.repeat(4000);
    oversized.excerpts = Array.from({ length: 9 }, (_, index) => ({
      evidenceId: `00000000-0000-4000-8000-00000000090${index}`,
      filePath: 'src/big.ts',
      contentHash: HASH_A,
      startLine: index + 1,
      endLine: index + 1,
      text: chunk,
      redacted: false,
    }));
    expect(9 * 4000).toBeGreaterThan(AI_MAX_EXCERPT_UTF8_BYTES);
    expect(() => aiContextPacketSchema.parse(oversized)).toThrow();
  });

  it('rejects inconsistent verification accounting in intrinsic response schema', () => {
    const badCounts = sampleResponse();
    badCounts.verification.verifiedClaims = 2;
    expect(() => aiSynthesisResponseSchema.parse(badCounts)).toThrow();

    const badRejectedCount = sampleResponse();
    badRejectedCount.verification.rejectedClaims = 1;
    expect(() => aiSynthesisResponseSchema.parse(badRejectedCount)).toThrow();
  });

  it('rejects cross-snapshot, task-mismatched, or fabricated citations at parseAiSynthesisResult', () => {
    const request = sampleRequest();

    const wrongSnapshot = sampleResponse();
    wrongSnapshot.snapshotId = OTHER_SNAPSHOT_ID;
    expect(() => parseAiSynthesisResult(request, wrongSnapshot)).toThrow();

    const wrongTask = sampleResponse();
    wrongTask.task = 'explain_unknowns';
    expect(() => parseAiSynthesisResult(request, wrongTask)).toThrow();

    const hallucinatedEvidence = sampleResponse();
    hallucinatedEvidence.claims[0]!.evidenceIds = [UNKNOWN_ID];
    expect(() =>
      parseAiSynthesisResult(request, hallucinatedEvidence),
    ).toThrow();

    const hallucinatedSymbol = sampleResponse();
    hallucinatedSymbol.nextSteps[0]!.symbolId = UNKNOWN_ID;
    expect(() => parseAiSynthesisResult(request, hallucinatedSymbol)).toThrow();

    const tightRequest = aiSynthesizeRequestSchema.parse({
      task: 'explain_trace',
      packet: samplePacket(),
      maxClaims: 1,
      maxNextSteps: 1,
    });
    const tooManyClaims = sampleResponse();
    tooManyClaims.claims.push({
      ...tooManyClaims.claims[0]!,
      text: 'Second claim exceeding requested maxClaims.',
    });
    tooManyClaims.verification.verifiedClaims = 2;
    expect(() => parseAiSynthesisResult(tightRequest, tooManyClaims)).toThrow();
  });

  it('requires packet-level omission, redaction and truncation to be echoed truthfully', () => {
    const request = sampleRequest();

    const missingOmitted = samplePacket() as Record<string, unknown>;
    delete missingOmitted['omitted'];
    expect(() => aiContextPacketSchema.parse(missingOmitted)).toThrow();

    const omittedRequest = aiSynthesizeRequestSchema.parse({
      task: 'explain_trace',
      packet: {
        ...samplePacket(),
        omitted: { symbols: 4, relations: 0, excerpts: 2, diagnostics: 0 },
      },
    });
    // A response that hides the omission must be rejected.
    expect(() =>
      parseAiSynthesisResult(omittedRequest, sampleResponse()),
    ).toThrow();
    const honest = sampleResponse();
    honest.context.omitted = {
      symbols: 4,
      relations: 0,
      excerpts: 2,
      diagnostics: 0,
    };
    expect(
      parseAiSynthesisResult(omittedRequest, honest).context.omitted,
    ).toEqual(honest.context.omitted);

    const hiddenRedaction = sampleResponse();
    hiddenRedaction.context.redactedExcerpts = 1;
    expect(() => parseAiSynthesisResult(request, hiddenRedaction)).toThrow();

    const badTruncation = sampleResponse();
    badTruncation.context.truncated = true;
    expect(() => aiSynthesisResponseSchema.parse(badTruncation)).toThrow();
  });
});
