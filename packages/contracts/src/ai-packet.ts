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

export function hasUniqueItems(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

export const uniqueIds = (min: number, max: number) =>
  z
    .array(idSchema)
    .min(min)
    .max(max)
    .refine(hasUniqueItems, 'Duplicate identifier');

export const aiTruncationReasonsSchema = z
  .array(z.enum(['result_limit', 'depth_limit', 'search_budget']))
  .max(3)
  .refine(hasUniqueItems, 'Duplicate truncation reasons');

/** Counts of facts that were available upstream but not given to the model. */
export const aiPacketOmittedSchema = z.strictObject({
  symbols: z.number().int().nonnegative(),
  relations: z.number().int().nonnegative(),
  excerpts: z.number().int().nonnegative(),
  diagnostics: z.number().int().nonnegative(),
});
export type AiPacketOmitted = z.infer<typeof aiPacketOmittedSchema>;

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
    /** True when secret-like substrings were replaced before the model saw it. */
    redacted: z.boolean(),
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

function duplicate(
  count: number,
  size: number,
  path: string,
  label: string,
  context: z.RefinementCtx,
): void {
  if (count !== size) {
    context.addIssue({
      code: 'custom',
      path: [path],
      message: `Duplicate ${label} in AI context packet`,
    });
  }
}

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
  duplicate(
    symbolIds.size,
    packet.symbols.length,
    'symbols',
    'symbol ID',
    context,
  );
  duplicate(
    relationIds.size,
    packet.relations.length,
    'relations',
    'relation ID',
    context,
  );
  duplicate(
    excerptIds.size,
    packet.excerpts.length,
    'excerpts',
    'excerpt evidenceId',
    context,
  );
  duplicate(
    diagnosticIds.size,
    packet.diagnostics.length,
    'diagnostics',
    'diagnostic ID',
    context,
  );
  if (!symbolIds.has(packet.rootSymbolId)) {
    context.addIssue({
      code: 'custom',
      path: ['rootSymbolId'],
      message: 'Root symbol must exist in packet symbols',
    });
  }
  packet.relations.forEach((relation, index) => {
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
    if (relation.diagnosticIds.some((id) => !diagnosticIds.has(id))) {
      context.addIssue({
        code: 'custom',
        path: ['relations', index, 'diagnosticIds'],
        message: 'Relation diagnostic missing from packet',
      });
    }
  });
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
    truncationReasons: aiTruncationReasonsSchema,
    omitted: aiPacketOmittedSchema,
    symbols: z.array(aiContextSymbolSchema).min(1).max(60),
    relations: z.array(aiContextRelationSchema).max(80),
    excerpts: z.array(aiContextExcerptSchema).min(1).max(60),
    diagnostics: z.array(aiContextDiagnosticSchema).max(40),
  })
  .superRefine(checkPacketIntegrity);
export type AiContextPacket = z.infer<typeof aiContextPacketSchema>;

/** Packet-level limits echoed to consumers so omission is never silent. */
export const aiResponseContextSchema = z.strictObject({
  truncated: z.boolean(),
  truncationReasons: aiTruncationReasonsSchema,
  omitted: aiPacketOmittedSchema,
  redactedExcerpts: z.number().int().nonnegative().max(60),
});
export type AiResponseContext = z.infer<typeof aiResponseContextSchema>;

export function responseContextFor(packet: AiContextPacket): AiResponseContext {
  return {
    truncated: packet.truncated,
    truncationReasons: [...packet.truncationReasons],
    omitted: { ...packet.omitted },
    redactedExcerpts: packet.excerpts.filter((excerpt) => excerpt.redacted)
      .length,
  };
}
