import {
  aiModelRawOutputSchema,
  aiSynthesizeRequestSchema,
  parseAiSynthesisResult,
  responseContextFor,
} from '@codethread/contracts';
import type {
  AiAssertedRelation,
  AiContextRelation,
  AiContextSymbol,
  AiModelClaim,
  AiModelNextStep,
  AiProviderKind,
  AiRejectedItem,
  AiRejectionReason,
  AiSynthesisResponse,
  AiSynthesizeRequest,
} from '@codethread/contracts';
import { AiError } from './errors.ts';

export const STATIC_AI_DISCLAIMER =
  'Generated static synthesis (unverified). Static relationships and source excerpts do not prove runtime execution or passing tests.';

const CLAUSE_SPLIT_PATTERN =
  /(?<=[.!?])\s+|\n+|;\s*|[\u2014\u2013]\s*|\s+-\s+|:\s+|,\s+|(?:\s+(?:but|however|yet|whereas|although|though|still|nevertheless|nonetheless)\s+)|(?:\s+and\s+(?=(?:(?:[a-z_][\w$.]*|the\s+[a-z_][\w$.]*)\s+)?(?:is\b|are\b|was\b|were\b|will\b|executes?\b|executed\b|runs?\b|passes?\b|passed\b|succeeded\b|definitely\b|always\b|certainly\b|guaranteed\b|proven\b|confirmed\b)))/i;

const EPISTEMIC_OR_RUNTIME_NEGATION =
  /\b(?:(?:does\s+not|do\s+not|did\s+not|cannot|can't|couldn't|won't|will\s+not|never|fails?\s+to|unable\s+to|without)\s+(?:prove|establish|guarantee|confirm|imply|mean|show|demonstrate|indicate|ensure|verify|execute|run|invoke|call|pass|succeed)|(?:is\s+not|are\s+not|was\s+not|were\s+not|not|never)\s+(?:proven|established|guaranteed|confirmed|known|certain|shown|verified)|no\s+proof(?:\s+that)?)\b/i;

const DIRECT_LOCAL_NEGATION =
  /\b(?:not|never|cannot|can't|won't|will\s+not|does\s+not|do\s+not)\s+(?:be\s+)?$/i;

const RUNTIME_OVERCLAIM_PATTERNS: readonly RegExp[] = [
  /\b(?:executes?|executed|runs?|run|invoked|called|triggered|fired)\s+(?:at\s+runtime|in\s+production)\b/i,
  /\b(?:guaranteed|proven|confirmed|definitely|certainly|always)\s+(?:to\s+)?(?:execute|be\s+executed|run|be\s+run|be\s+called|be\s+invoked|pass|succeed)\b/i,
  /\bwill\s+(?:always|definitely|certainly|necessarily)\s+(?:execute|be\s+executed|run|be\s+run|call|invoke|pass|succeed)\b/i,
  /\bruntime\s+(?:execution|behavior|call|invocation)\s+(?:is\s+)?(?:proven|confirmed|guaranteed|certain)\b/i,
  /\b(?:assertion|assertions|test|tests|test\s+suite)\s+(?:passes|pass|passed|succeeded|succeeds|is\s+passing|are\s+passing)\b/i,
];

function splitClauses(text: string): string[] {
  return text
    .split(CLAUSE_SPLIT_PATTERN)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function isNegatedInSameClause(clause: string, matchIndex: number): boolean {
  const prefix = clause.slice(0, matchIndex);
  if (DIRECT_LOCAL_NEGATION.test(prefix)) return true;
  return EPISTEMIC_OR_RUNTIME_NEGATION.test(prefix);
}

/**
 * Deterministic, English-only clause-level heuristic for unqualified claims
 * that static evidence proves runtime execution or passing tests. Each clause
 * is evaluated independently and only epistemic/runtime negations or direct
 * local negations immediately governing the runtime phrase suppress a match,
 * so unrelated negations ("not null", "not deprecated", "does not cover X")
 * or disclaimers in another clause cannot mask a positive runtime overclaim.
 */
export function hasRuntimeExecutionOverclaim(text: string): boolean {
  for (const clause of splitClauses(text)) {
    for (const pattern of RUNTIME_OVERCLAIM_PATTERNS) {
      const match = pattern.exec(clause);
      if (!match) continue;
      if (!isNegatedInSameClause(clause, match.index)) {
        return true;
      }
    }
  }
  return false;
}

function checkRelationAssertion(
  asserted: AiAssertedRelation | undefined,
  citedRelations: readonly AiContextRelation[],
): AiRejectionReason[] {
  if (asserted === undefined) return [];
  const reasons: AiRejectionReason[] = [];
  if (asserted === 'non_exact') {
    if (
      citedRelations.length > 0 &&
      citedRelations.every((relation) => relation.resolution === 'exact')
    ) {
      reasons.push('RELATION_KIND_MISMATCH');
    }
    return reasons;
  }

  const expectedKind =
    asserted === 'exact_call'
      ? 'calls'
      : asserted === 'exact_reference'
        ? 'references'
        : 'constructs';

  if (citedRelations.length === 0) {
    reasons.push('RELATION_KIND_MISMATCH');
    return reasons;
  }
  if (citedRelations.some((relation) => relation.resolution !== 'exact')) {
    reasons.push('NON_EXACT_UPGRADE');
  }
  if (citedRelations.some((relation) => relation.kind !== expectedKind)) {
    reasons.push('RELATION_KIND_MISMATCH');
  }
  return reasons;
}

/**
 * Checks that the IDs a claim cites actually belong together: a cited relation
 * must be supported by its own site evidence, cited symbols must be endpoints
 * of the cited relations, and every evidence ID must come from the cited
 * entities. Callers run this only after all IDs are known to exist.
 */
function citationsAreCoherent(
  claim: AiModelClaim,
  cited: readonly AiContextRelation[],
  symbolsById: ReadonlyMap<string, AiContextSymbol>,
): boolean {
  const allowedEvidence = new Set<string>();
  const allowedSymbols = new Set<string>();
  const allowedDiagnostics = new Set<string>();
  for (const relation of cited) {
    if (!claim.evidenceIds.includes(relation.siteEvidenceId)) return false;
    relation.evidenceIds.forEach((id) => allowedEvidence.add(id));
    allowedSymbols.add(relation.sourceSymbolId);
    if (relation.targetSymbolId !== null)
      allowedSymbols.add(relation.targetSymbolId);
    relation.diagnosticIds.forEach((id) => allowedDiagnostics.add(id));
  }
  for (const symbolId of claim.symbolIds) {
    if (cited.length > 0 && !allowedSymbols.has(symbolId)) return false;
    const symbol = symbolsById.get(symbolId);
    if (symbol) allowedEvidence.add(symbol.declarationEvidenceId);
  }
  if (
    cited.length > 0 &&
    claim.diagnosticIds.some((id) => !allowedDiagnostics.has(id))
  ) {
    return false;
  }
  if (cited.length === 0 && claim.symbolIds.length === 0) return true;
  return claim.evidenceIds.every((id) => allowedEvidence.has(id));
}

function nextStepEvidenceIsCoherent(
  step: AiModelNextStep,
  symbol: AiContextSymbol,
  relations: readonly AiContextRelation[],
): boolean {
  const allowed = new Set<string>([symbol.declarationEvidenceId]);
  for (const relation of relations) {
    if (
      relation.sourceSymbolId === symbol.id ||
      relation.targetSymbolId === symbol.id
    ) {
      relation.evidenceIds.forEach((id) => allowed.add(id));
    }
  }
  return step.supportingEvidenceIds.every((id) => allowed.has(id));
}

function uniqueReasons(
  reasons: readonly AiRejectionReason[],
): AiRejectionReason[] {
  return [...new Set(reasons)];
}

export interface VerificationProvenance {
  readonly provider: AiProviderKind;
  readonly model: string;
  readonly packetHash: string;
  readonly promptVersion: string;
}

/**
 * Deterministically verifies raw model JSON against the originating snapshot
 * packet, enforcing citation-or-silence, citation coherence, relation fidelity,
 * and static-only truthfulness before returning a contract-validated response.
 * It cannot prove that prose paraphrases a relation correctly; consumers show
 * the real relation facts next to each claim.
 */
export function verifyAiModelOutput(
  request: AiSynthesizeRequest,
  rawModelOutput: unknown,
  provenance: VerificationProvenance,
): AiSynthesisResponse {
  const checkedRequest = aiSynthesizeRequestSchema.parse(request);
  const parsedRaw = aiModelRawOutputSchema.safeParse(rawModelOutput);
  if (!parsedRaw.success) {
    throw new AiError(
      'AI_INVALID_MODEL_OUTPUT',
      'Model output did not match the structured AI synthesis schema',
    );
  }

  const { packet } = checkedRequest;
  const excerptIds = new Set(packet.excerpts.map((item) => item.evidenceId));
  const symbolsById = new Map(
    packet.symbols.map((item) => [item.id, item] as const),
  );
  const relationsById = new Map(
    packet.relations.map((item) => [item.id, item] as const),
  );
  const diagnosticIds = new Set(packet.diagnostics.map((item) => item.id));

  const verifiedClaims: AiModelClaim[] = [];
  const seenClaimTexts = new Set<string>();
  const rejectedItems: AiRejectedItem[] = [];

  parsedRaw.data.claims.forEach((claim, index) => {
    const reasons: AiRejectionReason[] = [];
    if (claim.evidenceIds.some((id) => !excerptIds.has(id))) {
      reasons.push('UNKNOWN_EVIDENCE_ID');
    }
    if (claim.symbolIds.some((id) => !symbolsById.has(id))) {
      reasons.push('UNKNOWN_SYMBOL_ID');
    }
    const citedRelations: AiContextRelation[] = [];
    for (const relationId of claim.relationIds) {
      const match = relationsById.get(relationId);
      if (!match) {
        reasons.push('UNKNOWN_RELATION_ID');
      } else {
        citedRelations.push(match);
      }
    }
    if (claim.diagnosticIds.some((id) => !diagnosticIds.has(id))) {
      reasons.push('UNKNOWN_DIAGNOSTIC_ID');
    }
    const idsKnown = reasons.length === 0;
    if (
      claim.claimType === 'observed_fact' &&
      claim.relationIds.length === 0 &&
      claim.symbolIds.length === 0
    ) {
      reasons.push('UNANCHORED_FACT');
    }
    if (
      !reasons.includes('UNKNOWN_RELATION_ID') &&
      claim.assertedRelation !== undefined
    ) {
      reasons.push(
        ...checkRelationAssertion(claim.assertedRelation, citedRelations),
      );
    }
    if (idsKnown && !citationsAreCoherent(claim, citedRelations, symbolsById)) {
      reasons.push('CITATION_RELATION_MISMATCH');
    }
    if (hasRuntimeExecutionOverclaim(claim.text)) {
      reasons.push('RUNTIME_EXECUTION_OVERCLAIM');
    }
    const normalizedText = claim.text.trim().toLowerCase().replace(/\s+/g, ' ');
    if (seenClaimTexts.has(normalizedText)) {
      reasons.push('DUPLICATE_CLAIM');
    }

    const deduped = uniqueReasons(reasons);
    if (deduped.length > 0) {
      rejectedItems.push({ kind: 'claim', index, reasons: deduped });
      return;
    }
    if (verifiedClaims.length >= checkedRequest.maxClaims) {
      rejectedItems.push({
        kind: 'claim',
        index,
        reasons: ['OUTPUT_CAP_EXCEEDED'],
      });
      return;
    }
    seenClaimTexts.add(normalizedText);
    verifiedClaims.push(claim);
  });

  const verifiedNextSteps: AiModelNextStep[] = [];
  const seenStepSymbols = new Set<string>();
  parsedRaw.data.nextSteps.forEach((step, index) => {
    const reasons: AiRejectionReason[] = [];
    const symbol = symbolsById.get(step.symbolId);
    if (!symbol) {
      reasons.push('UNKNOWN_SYMBOL_ID');
    }
    if (step.supportingEvidenceIds.some((id) => !excerptIds.has(id))) {
      reasons.push('UNKNOWN_EVIDENCE_ID');
    }
    if (
      symbol &&
      !reasons.includes('UNKNOWN_EVIDENCE_ID') &&
      !nextStepEvidenceIsCoherent(step, symbol, packet.relations)
    ) {
      reasons.push('CITATION_RELATION_MISMATCH');
    }
    if (hasRuntimeExecutionOverclaim(step.reason)) {
      reasons.push('RUNTIME_EXECUTION_OVERCLAIM');
    }
    if (seenStepSymbols.has(step.symbolId)) {
      reasons.push('DUPLICATE_CLAIM');
    }

    const deduped = uniqueReasons(reasons);
    if (deduped.length > 0) {
      rejectedItems.push({ kind: 'next_step', index, reasons: deduped });
      return;
    }
    if (verifiedNextSteps.length >= checkedRequest.maxNextSteps) {
      rejectedItems.push({
        kind: 'next_step',
        index,
        reasons: ['OUTPUT_CAP_EXCEEDED'],
      });
      return;
    }
    seenStepSymbols.add(step.symbolId);
    verifiedNextSteps.push(step);
  });

  const safeUncertainties = parsedRaw.data.uncertainties.filter(
    (note) => !hasRuntimeExecutionOverclaim(note),
  );
  const allClaimsRejected =
    parsedRaw.data.claims.length > 0 && verifiedClaims.length === 0;
  const summary =
    allClaimsRejected || hasRuntimeExecutionOverclaim(parsedRaw.data.summary)
      ? null
      : parsedRaw.data.summary;

  const returnedRejected = rejectedItems.slice(0, 20);
  const rejectedClaims = returnedRejected.filter(
    (item) => item.kind === 'claim',
  ).length;
  const rejectedNextSteps = returnedRejected.filter(
    (item) => item.kind === 'next_step',
  ).length;

  return parseAiSynthesisResult(checkedRequest, {
    version: 1,
    snapshotId: packet.snapshotId,
    rootSymbolId: packet.rootSymbolId,
    task: checkedRequest.task,
    evidenceBasis: 'static_generated_unverified',
    disclaimer: STATIC_AI_DISCLAIMER,
    provenance,
    context: responseContextFor(packet),
    summary,
    claims: verifiedClaims,
    nextSteps: verifiedNextSteps,
    uncertainties: safeUncertainties,
    verification: {
      verifiedClaims: verifiedClaims.length,
      rejectedClaims,
      verifiedNextSteps: verifiedNextSteps.length,
      rejectedNextSteps,
      rejectedItems: returnedRejected,
    },
  });
}
