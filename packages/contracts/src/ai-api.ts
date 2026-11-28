import { z } from 'zod';
import { aiTaskKindSchema } from './ai-queries.js';
import {
  findSymbolPathsRequestSchema,
  graphNeighborsRequestSchema,
} from './graph-queries.js';

/** Capability probe: never reveals credentials or endpoint details. */
export const aiStatusResponseSchema = z.discriminatedUnion('enabled', [
  z.strictObject({ enabled: z.literal(false) }),
  z.strictObject({
    enabled: z.literal(true),
    provider: z.enum(['gemini', 'openai_compatible']),
    /** `remote` means selected source excerpts leave this machine. */
    locality: z.enum(['local', 'remote']),
    model: z.string().min(1).max(128),
  }),
]);
export type AiStatusResponse = z.infer<typeof aiStatusResponseSchema>;

/**
 * Clients choose only the projection they are looking at. The backend builds
 * the evidence packet itself from the verified snapshot, so a caller can never
 * supply its own "evidence".
 */
export const aiSynthesizeApiRequestSchema = z
  .strictObject({
    task: aiTaskKindSchema,
    neighbors: graphNeighborsRequestSchema
      .refine(
        (request) => request.depth <= 2,
        'AI synthesis supports a neighbor depth of at most 2',
      )
      .optional(),
    paths: findSymbolPathsRequestSchema
      .refine(
        (request) => request.depth <= 5,
        'AI path synthesis supports a depth of at most 5',
      )
      .optional(),
    maxClaims: z.number().int().min(1).max(10).default(5),
    maxNextSteps: z.number().int().min(1).max(5).default(3),
  })
  .superRefine((value, ctx) => {
    if (value.task === 'explain_path') {
      if (!value.paths) {
        ctx.addIssue({
          code: 'custom',
          path: ['paths'],
          message: 'explain_path requires a paths query',
        });
      }
      if (value.neighbors) {
        ctx.addIssue({
          code: 'custom',
          path: ['neighbors'],
          message: 'explain_path does not accept neighbors',
        });
      }
      return;
    }
    if (!value.neighbors) {
      ctx.addIssue({
        code: 'custom',
        path: ['neighbors'],
        message: `${value.task} requires a neighbors query`,
      });
    }
    if (value.paths) {
      ctx.addIssue({
        code: 'custom',
        path: ['paths'],
        message: `${value.task} does not accept paths`,
      });
    }
  });
export type AiSynthesizeApiRequest = z.infer<
  typeof aiSynthesizeApiRequestSchema
>;
