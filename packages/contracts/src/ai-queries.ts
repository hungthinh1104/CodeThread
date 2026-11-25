import { z } from 'zod';
import {
  codeRelationKindSchema,
  coverageByCapabilitySchema,
  coverageSchema,
  hashSchema,
  idSchema,
  resolutionStatusSchema,
  snapshotPathSchema,
  summarizeCoverage,
  symbolSchema,
} from '@codethread/code-model';

export const AI_MAX_EXCERPT_UTF8_BYTES = 32_768;

export const aiTaskKindSchema = z.enum([
  'explain_trace',
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
  'RUNTIME_EXECUTION_OVERCLAIM',
  'DUPLICATE_CLAIM',
]);
export type AiRejectionReason = z.infer<typeof aiRejectionReasonSchema>;

function hasUniqueItems(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

const uniqueIds = (min: number, max: number) =>
  z
    .array(idSchema)
    .min(min)
    .max(max)
    .refine(hasUniqueItems, 'Duplicate identifier');

export const aiContextSymbolSchema = z.strictObject({
  id: idSchema,
  name: z.string().min(1).max(256),
  kind: symbolSchema.shape.kind,
  filePath: snapshotPathSchema,
  line: z.number().int().positive(),
  declarationEvidenceId: idSchema,
});
export type AiContextSymbol = z.infer<typeof aiContextSymbolSchema>;

export const aiContextRelationSchema = z
  .strictObject({
    id: idSchema,
    sourceSymbolId: idSchema,
    targetSymbolId: idSchema.nullable(),
    kind: codeRelationKindSchema,
    resolution: resolutionStatusSchema,
    siteEvidenceId: idSchema,
    evidenceIds: uniqueIds(1, 20),
    diagnosticIds: uniqueIds(0, 20),
  })
  .superRefine((relation, context) => {
    if (relation.resolution === 'exact' && relation.targetSymbolId === null) {
      context.addIssue({
        code: 'custom',
        path: ['targetSymbolId'],
        message: 'Exact relation requires a target symbol',
      });
    }
    if (relation.resolution !== 'exact' && relation.targetSymbolId !== null) {
      context.addIssue({
        code: 'custom',
        path: ['targetSymbolId'],
        message: 'Non-exact relation must not declare a target symbol',
      });
    }
    if (
      relation.resolution !== 'exact' &&
      relation.diagnosticIds.length === 0
    ) {
      context.addIssue({
        code: 'custom',
        path: ['diagnosticIds'],
        message: 'Non-exact relation requires at least one diagnostic',
      });
    }
    if (!relation.evidenceIds.includes(relation.siteEvidenceId)) {
      context.addIssue({
        code: 'custom',
        path: ['siteEvidenceId'],
        message: 'Site evidence must be listed in evidenceIds',
      });
    }
  });
export type AiContextRelation = z.infer<typeof aiContextRelationSchema>;

export const aiContextExcerptSchema = z
  .strictObject({
    evidenceId: idSchema,
    filePath: snapshotPathSchema,
    contentHash: hashSchema,
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    text: z.string().min(1).max(4096),
  })
  .refine(
    (excerpt) => excerpt.endLine >= excerpt.startLine,
    'Excerpt endLine must be >= startLine',
  );
export type AiContextExcerpt = z.infer<typeof aiContextExcerptSchema>;

export const aiContextDiagnosticSchema = z
  .strictObject({
    id: idSchema,
    code: z.string().regex(/^[A-Z][A-Z0-9_]{1,127}$/),
    severity: z.enum(['info', 'warning', 'error']),
    message: z.string().min(1).max(1024),
    filePath: snapshotPathSchema.nullable(),
    line: z.number().int().positive().nullable(),
  })
  .refine(
    (diagnostic) => diagnostic.line === null || diagnostic.filePath !== null,
    'Diagnostic line requires filePath',
  );
export type AiContextDiagnostic = z.infer<typeof aiContextDiagnosticSchema>;

function checkPacketIntegrity(
  packet: {
    rootSymbolId: string;
    coverage: string;
    coverageByCapability: Record<
      string,
      'complete' | 'partial' | 'not_analyzed' | 'unsupported'
    >;
    truncated: boolean;
    truncationReasons: string[];
    symbols: AiContextSymbol[];
    relations: AiContextRelation[];
    excerpts: AiContextExcerpt[];
    diagnostics: AiContextDiagnostic[];
  },
  context: z.RefinementCtx,
): void {
  if (packet.coverage !== summarizeCoverage(packet.coverageByCapability)) {
    context.addIssue({
      code: 'custom',
      path: ['coverage'],
      message: 'Aggregate coverage must match capability coverage',
    });
  }
  if (packet.truncated !== packet.truncationReasons.length > 0) {
    context.addIssue({
      code: 'custom',
      path: ['truncationReasons'],
      message: 'Truncation reasons must match truncated flag',
    });
  }
  const symbolIds = new Set(packet.symbols.map((symbol) => symbol.id));
  const relationIds = new Set(packet.relations.map((relation) => relation.id));
  const excerptIds = new Set(
    packet.excerpts.map((excerpt) => excerpt.evidenceId),
  );
  const diagnosticIds = new Set(
    packet.diagnostics.map((diagnostic) => diagnostic.id),
  );
  if (symbolIds.size !== packet.symbols.length) {
    context.addIssue({
      code: 'custom',
      path: ['symbols'],
      message: 'Duplicate symbol ID in AI context packet',
    });
  }
  if (relationIds.size !== packet.relations.length) {
    context.addIssue({
      code: 'custom',
      path: ['relations'],
      message: 'Duplicate relation ID in AI context packet',
    });
  }
  if (excerptIds.size !== packet.excerpts.length) {
    context.addIssue({
      code: 'custom',
      path: ['excerpts'],
      message: 'Duplicate excerpt evidenceId in AI context packet',
    });
  }
  if (diagnosticIds.size !== packet.diagnostics.length) {
    context.addIssue({
      code: 'custom',
      path: ['diagnostics'],
      message: 'Duplicate diagnostic ID in AI context packet',
    });
  }
  if (!symbolIds.has(packet.rootSymbolId)) {
    context.addIssue({
      code: 'custom',
      path: ['rootSymbolId'],
      message: 'Root symbol must exist in packet symbols',
    });
  }
  for (let index = 0; index < packet.relations.length; index++) {
    const relation = packet.relations[index]!;
    if (!symbolIds.has(relation.sourceSymbolId)) {
      context.addIssue({
        code: 'custom',
        path: ['relations', index, 'sourceSymbolId'],
        message: 'Relation source symbol missing from packet',
      });
    }
    if (
      relation.targetSymbolId !== null &&
      !symbolIds.has(relation.targetSymbolId)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['relations', index, 'targetSymbolId'],
        message: 'Relation target symbol missing from packet',
      });
    }
    for (const diagnosticId of relation.diagnosticIds) {
      if (!diagnosticIds.has(diagnosticId)) {
        context.addIssue({
          code: 'custom',
          path: ['relations', index, 'diagnosticIds'],
          message: 'Relation diagnostic missing from packet',
        });
        break;
      }
    }
  }
  const encoder = new TextEncoder();
  let totalExcerptBytes = 0;
  for (const excerpt of packet.excerpts) {
    totalExcerptBytes += encoder.encode(excerpt.text).byteLength;
  }
  if (totalExcerptBytes > AI_MAX_EXCERPT_UTF8_BYTES) {
    context.addIssue({
      code: 'custom',
      path: ['excerpts'],
      message: 'Total excerpt text exceeds 32 KiB packet budget',
    });
  }
}

export const aiContextPacketSchema = z
  .strictObject({
    version: z.literal(1),
    snapshotId: idSchema,
    rootSymbolId: idSchema,
    coverage: coverageSchema,
    coverageByCapability: coverageByCapabilitySchema,
    truncated: z.boolean(),
    truncationReasons: z
      .array(z.enum(['result_limit', 'depth_limit', 'search_budget']))
      .max(3)
      .refine(hasUniqueItems, 'Duplicate truncation reasons'),
    symbols: z.array(aiContextSymbolSchema).min(1).max(60),
    relations: z.array(aiContextRelationSchema).max(80),
    excerpts: z.array(aiContextExcerptSchema).min(1).max(60),
    diagnostics: z.array(aiContextDiagnosticSchema).max(40),
  })
  .superRefine(checkPacketIntegrity);
export type AiContextPacket = z.infer<typeof aiContextPacketSchema>;

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
  });
export type AiSynthesisResponse = z.infer<typeof aiSynthesisResponseSchema>;

export const aiErrorCodeSchema = z.enum([
  'AI_DISABLED',
  'AI_INVALID_CONFIG',
  'AI_INVALID_REQUEST',
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
