import { idSchema } from '@codethread/code-model';
import {
  backendApiErrorResponseSchema,
  backendApiResponseSchemas,
  backendRepositoryResponseSchema,
  backendScanResponseSchema,
} from '@codethread/contracts';
import type { BackendApiRoute } from '@codethread/contracts';
import { z } from 'zod';

export { backendApiResponseSchemas };
export type { BackendApiRoute };

const generationValueSchema = z.union([
  z.string().regex(/^(0|[1-9][0-9]*)$/),
  z.number().int().nonnegative(),
  z.bigint().nonnegative(),
]);
const timestampValueSchema = z.union([z.date(), z.iso.datetime()]);
const timestampSchema = timestampValueSchema.transform((value) =>
  value instanceof Date ? value.toISOString() : value,
);
const repositoryRowSchema = z.strictObject({
  id: idSchema,
  locator: z.string().min(1).max(4096),
  desired_generation: generationValueSchema,
  active_job_id: idSchema.nullable(),
});
const scanJobRowSchema = z.strictObject({
  id: idSchema,
  repository_id: idSchema,
  generation: generationValueSchema,
  state: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  attempt: z.number().int().nonnegative(),
  revision_selector: z.string().min(1).max(1024),
  git_commit_oid: z
    .string()
    .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
    .nullable(),
  git_tree_oid: z
    .string()
    .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
    .nullable(),
  activation_result: z.enum(['activated', 'stale', 'not_eligible']).nullable(),
  error_code: z.string().nullable(),
  error_message: z.string().nullable(),
  created_at: timestampValueSchema,
  updated_at: timestampValueSchema,
});

/** Validate and project service/database values into the public API DTOs. */
export function parseBackendResponse(
  route: BackendApiRoute,
  value: unknown,
): unknown {
  try {
    switch (route) {
      case 'GET /v1/repositories':
        return backendApiResponseSchemas[route].parse(value);
      case 'GET /v1/repositories/:id':
        return backendRepositoryResponseSchema.parse(
          repositoryRowSchema.parse(value),
        );
      case 'GET /v1/scans/:id': {
        const row = scanJobRowSchema.parse(value);
        return backendScanResponseSchema.parse({
          ...row,
          generation: String(row.generation),
          created_at: timestampSchema.parse(row.created_at),
          updated_at: timestampSchema.parse(row.updated_at),
        });
      }
      default:
        return backendApiResponseSchemas[route].parse(value);
    }
  } catch (error) {
    if (error instanceof z.ZodError)
      throw new Error('Backend response failed its public contract.', {
        cause: error,
      });
    throw error;
  }
}

export function parseBackendErrorResponse(value: unknown) {
  return backendApiErrorResponseSchema.parse(value);
}
