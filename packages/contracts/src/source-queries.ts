import { z } from 'zod';
import {
  idSchema,
  sourceEvidenceSchema,
  snapshotPathSchema,
  diagnosticSchema,
} from '@codethread/code-model';
import {
  pageFields,
  checkCursor,
  scoped,
  queryMetaSchema,
  nextCursor,
} from './query-common.js';
import { indexEvidence, checkLocations } from './integrity.js';

const diagnosticFiltersSchema = z.strictObject({
  severity: z.enum(['info', 'warning', 'error']).optional(),
  code: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{1,127}$/)
    .optional(),
  fileId: idSchema.optional(),
});

export const getDiagnosticsRequestSchema = z
  .strictObject({ ...pageFields, filters: diagnosticFiltersSchema.default({}) })
  .superRefine((request, context) =>
    checkCursor(
      request.cursor,
      request.snapshotId,
      'diagnostics',
      request.filters,
      context,
    ),
  );

export const getSourceEvidenceRequestSchema = z.strictObject({
  snapshotId: idSchema,
  evidenceIds: z
    .array(idSchema)
    .min(1)
    .max(100)
    .refine(
      (ids) => new Set(ids).size === ids.length,
      'Duplicate evidence IDs',
    ),
});

const sourceSuccessSchema = z
  .strictObject({
    status: z.literal('available'),
    evidence: sourceEvidenceSchema,
    filePath: snapshotPathSchema,
    text: z.string().max(65536),
  })
  .refine(
    (item) =>
      item.text.length ===
      item.evidence.range.end.offset - item.evidence.range.start.offset,
    'Source excerpt must match the evidence span length',
  );

const sourceFailureSchema = z.strictObject({
  status: z.literal('unavailable'),
  snapshotId: idSchema,
  evidenceId: idSchema,
  code: z.enum([
    'SOURCE_UNAVAILABLE',
    'HASH_MISMATCH',
    'INVALID_ENCODING',
    'EVIDENCE_TOO_LARGE',
    'EVIDENCE_NOT_FOUND',
  ]),
});

export const getSourceEvidenceResponseSchema = scoped(
  z
    .strictObject({
      meta: queryMetaSchema,
      items: z
        .array(z.union([sourceSuccessSchema, sourceFailureSchema]))
        .max(100),
    })
    .superRefine((response, context) => {
      const available = response.items.flatMap((item) =>
        item.status === 'available' ? [item] : [],
      );
      indexEvidence(
        available.map((item) => item.evidence),
        response.meta.snapshotId,
        context,
      );
      checkLocations(
        available.map((item) => ({
          fileId: item.evidence.fileId,
          filePath: item.filePath,
        })),
        context,
      );
    }),
);

export const getDiagnosticsResponseSchema = scoped(
  z.strictObject({
    meta: queryMetaSchema,
    items: z.array(diagnosticSchema).max(200),
    nextCursor,
  }),
  'diagnostics',
);

export type GetSourceEvidenceRequest = z.infer<
  typeof getSourceEvidenceRequestSchema
>;

export type GetSourceEvidenceResponse = z.infer<
  typeof getSourceEvidenceResponseSchema
>;

export type GetDiagnosticsRequest = z.infer<typeof getDiagnosticsRequestSchema>;

export type GetDiagnosticsResponse = z.infer<
  typeof getDiagnosticsResponseSchema
>;
