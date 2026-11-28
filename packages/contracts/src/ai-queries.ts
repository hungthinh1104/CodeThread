import { z } from 'zod';
import { hashSchema, idSchema } from '@codethread/code-model';
import {
  aiContextPacketSchema,
  aiResponseContextSchema,
  hasUniqueItems,
  uniqueIds,
} from './ai-packet.js';

export const aiTaskKindSchema = z.enum([
  'explain_trace',
  'explain_path',
  'explain_unknowns',
  'suggest_next_steps',
]);
export type AiTaskKind = z.infer<typeof aiTaskKindSchema>;

export const aiProviderKindSchema = z.enum([
  'gemini',
  'openai_compatible',
  'mock',
]);
export type AiProviderKind = z.infer<typeof aiProviderKindSchema>;

export const aiClaimTypeSchema = z.enum([
  'observed_fact',
  'static_inference',
  'uncertainty_note',
]);
export type AiClaimType = z.infer<typeof aiClaimTypeSchema>;

export const aiAssertedRelationSchema = z.enum([
  'exact_call',
  'exact_reference',
  'exact_construct',
  'non_exact',
]);
export type AiAssertedRelation = z.infer<typeof aiAssertedRelationSchema>;

export const aiRejectionReasonSchema = z.enum([
  'UNKNOWN_EVIDENCE_ID',
  'UNKNOWN_SYMBOL_ID',
  'UNKNOWN_RELATION_ID',
  'UNKNOWN_DIAGNOSTIC_ID',
  'RELATION_KIND_MISMATCH',
  'NON_EXACT_UPGRADE',
  'CITATION_RELATION_MISMATCH',
  'UNANCHORED_FACT',
  'RUNTIME_EXECUTION_OVERCLAIM',
  'DUPLICATE_CLAIM',
  'OUTPUT_CAP_EXCEEDED',
]);
export type AiRejectionReason = z.infer<typeof aiRejectionReasonSchema>;

export const aiSynthesizeRequestSchema = z.strictObject({
  task: aiTaskKindSchema,
  packet: aiContextPacketSchema,
  maxClaims: z.number().int().min(1).max(10).default(5),
  maxNextSteps: z.number().int().min(1).max(5).default(3),
});
export type AiSynthesizeRequest = z.infer<typeof aiSynthesizeRequestSchema>;

export const aiModelClaimSchema = z.strictObject({
  text: z.string().min(1).max(600),
  claimType: aiClaimTypeSchema,
  assertedRelation: aiAssertedRelationSchema.optional(),
  evidenceIds: uniqueIds(1, 12),
  symbolIds: uniqueIds(0, 12).default([]),
  relationIds: uniqueIds(0, 12).default([]),
  diagnosticIds: uniqueIds(0, 12).default([]),
});
export type AiModelClaim = z.infer<typeof aiModelClaimSchema>;

export const aiModelNextStepSchema = z.strictObject({
  symbolId: idSchema,
  reason: z.string().min(1).max(400),
  supportingEvidenceIds: uniqueIds(1, 8),
});
export type AiModelNextStep = z.infer<typeof aiModelNextStepSchema>;

export const aiModelRawOutputSchema = z.strictObject({
  summary: z.string().min(1).max(600),
  claims: z.array(aiModelClaimSchema).max(12),
  nextSteps: z.array(aiModelNextStepSchema).max(8).default([]),
  uncertainties: z.array(z.string().min(1).max(400)).max(8).default([]),
});
export type AiModelRawOutput = z.infer<typeof aiModelRawOutputSchema>;

export const aiRejectedItemSchema = z.strictObject({
  kind: z.enum(['claim', 'next_step']),
  index: z.number().int().nonnegative(),
  reasons: z
    .array(aiRejectionReasonSchema)
    .min(1)
    .max(8)
    .refine(hasUniqueItems, 'Duplicate rejection reason'),
});
export type AiRejectedItem = z.infer<typeof aiRejectedItemSchema>;

export const aiSynthesisResponseSchema = z
  .strictObject({
    version: z.literal(1),
    snapshotId: idSchema,
    rootSymbolId: idSchema,
    task: aiTaskKindSchema,
    evidenceBasis: z.literal('static_generated_unverified'),
    disclaimer: z.string().min(1).max(400),
    provenance: z.strictObject({
      provider: aiProviderKindSchema,
      model: z.string().min(1).max(128),
      packetHash: hashSchema,
      promptVersion: z.string().min(1).max(32),
    }),
    context: aiResponseContextSchema,
    summary: z.string().min(1).max(600).nullable(),
    claims: z.array(aiModelClaimSchema).max(10),
    nextSteps: z.array(aiModelNextStepSchema).max(5),
    uncertainties: z.array(z.string().min(1).max(400)).max(8),
    verification: z.strictObject({
      verifiedClaims: z.number().int().nonnegative(),
      rejectedClaims: z.number().int().nonnegative(),
      verifiedNextSteps: z.number().int().nonnegative(),
      rejectedNextSteps: z.number().int().nonnegative(),
      rejectedItems: z.array(aiRejectedItemSchema).max(20),
    }),
  })
  .superRefine((response, context) => {
    const { verification } = response;
    if (verification.verifiedClaims !== response.claims.length) {
      context.addIssue({
        code: 'custom',
        path: ['verification', 'verifiedClaims'],
        message: 'verifiedClaims must equal claims.length',
      });
    }
    if (verification.verifiedNextSteps !== response.nextSteps.length) {
      context.addIssue({
        code: 'custom',
        path: ['verification', 'verifiedNextSteps'],
        message: 'verifiedNextSteps must equal nextSteps.length',
      });
    }
    const rejectedClaims = verification.rejectedItems.filter(
      (item) => item.kind === 'claim',
    ).length;
    const rejectedNextSteps = verification.rejectedItems.filter(
      (item) => item.kind === 'next_step',
    ).length;
    if (verification.rejectedClaims !== rejectedClaims) {
      context.addIssue({
        code: 'custom',
        path: ['verification', 'rejectedClaims'],
        message: 'rejectedClaims must match rejected claim entries',
      });
    }
    if (verification.rejectedNextSteps !== rejectedNextSteps) {
      context.addIssue({
        code: 'custom',
        path: ['verification', 'rejectedNextSteps'],
        message: 'rejectedNextSteps must match rejected next-step entries',
      });
    }
    if (
      response.context.truncated !==
      response.context.truncationReasons.length > 0
    ) {
      context.addIssue({
        code: 'custom',
        path: ['context', 'truncationReasons'],
        message: 'Truncation reasons must match truncated flag',
      });
    }
  });
export type AiSynthesisResponse = z.infer<typeof aiSynthesisResponseSchema>;

export const aiErrorCodeSchema = z.enum([
  'AI_DISABLED',
  'AI_INVALID_CONFIG',
  'AI_INVALID_REQUEST',
  'AI_CAPACITY_EXCEEDED',
  'AI_PROVIDER_TIMEOUT',
  'AI_PROVIDER_ERROR',
  'AI_RESPONSE_TOO_LARGE',
  'AI_INVALID_MODEL_OUTPUT',
]);
export type AiErrorCode = z.infer<typeof aiErrorCodeSchema>;

export const aiErrorSchema = z.strictObject({
  code: aiErrorCodeSchema,
  message: z.string().min(1).max(512),
});
export type AiErrorPayload = z.infer<typeof aiErrorSchema>;
