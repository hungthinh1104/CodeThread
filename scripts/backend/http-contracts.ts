import { idSchema } from '@codethread/code-model';
import {
  findSymbolPathsResponseSchema,
  getSourceEvidenceResponseSchema,
  graphNeighborsResponseSchema,
  listSymbolsResponseSchema,
} from '@codethread/contracts';
import { z } from 'zod';

const generationValueSchema = z.union([
  z.string().regex(/^(0|[1-9][0-9]*)$/),
  z.number().int().nonnegative(),
  z.bigint().nonnegative(),
]);
const generationSchema = generationValueSchema.transform(String);
const timestampValueSchema = z.union([z.date(), z.iso.datetime()]);
const timestampSchema = timestampValueSchema.transform((value) =>
  value instanceof Date ? value.toISOString() : value,
);
const repositoryLocatorSchema = z.string().min(1).max(4096);

const repositoryRowSchema = z.strictObject({
  id: idSchema,
  locator: repositoryLocatorSchema,
  desired_generation: generationValueSchema,
  active_job_id: idSchema.nullable(),
});
const repositoryResponseSchema = z.strictObject({
  id: idSchema,
  locator: repositoryLocatorSchema,
  desired_generation: generationSchema,
  active_job_id: idSchema.nullable(),
});
const registeredRepositoryResponseSchema = z.strictObject({
  id: idSchema,
  locator: repositoryLocatorSchema,
});

const healthResponseSchema = z
  .strictObject({
    api: z.literal('ready'),
    database: z.enum(['ready', 'unavailable']),
    worker: z.enum(['ready', 'unavailable']),
    ready: z.boolean(),
  })
  .refine(
    (value) =>
      value.ready ===
      (value.api === 'ready' &&
        value.database === 'ready' &&
        value.worker === 'ready'),
    'Readiness flag must match component status.',
  );

const acceptedScanResponseSchema = z.strictObject({
  id: idSchema,
  repositoryId: idSchema,
  state: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  reused: z.boolean(),
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
const scanJobResponseSchema = z.strictObject({
  id: idSchema,
  repository_id: idSchema,
  generation: generationSchema,
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
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});
const projectRowSchema = z.strictObject({
  project_id: z.string().min(1).max(256),
  project_label: z.string().min(1),
  status: z.enum([
    'ready',
    'solution',
    'invalid',
    'unsupported',
    'failed',
    'not_analyzed',
  ]),
  snapshot_id: idSchema.nullable(),
  diagnostics: z.array(
    z.strictObject({
      code: z.string().min(1),
      message: z.string().min(1),
      path: z.string().optional(),
    }),
  ),
});
const fileRowSchema = z.strictObject({
  path: z.string().min(1).max(1024),
  content_hash: z.string().regex(/^[0-9a-f]{64}$/),
  git_blob_oid: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  git_mode: z.enum(['100644', '100755']),
});
const filesResponseSchema = z.strictObject({
  items: z.array(fileRowSchema).max(50),
  total: z.number().int().nonnegative(),
  nextOffset: z.number().int().min(0).max(1256).nullable(),
});
const cancelResponseSchema = z.strictObject({
  id: idSchema,
  state: z.literal('cancelled'),
});
const viewerResponseSchema = z.strictObject({
  url: z.url(),
  expiresAt: z.iso.datetime(),
});
const apiErrorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
    message: z.string().min(1).max(1024),
  }),
});

export const backendApiResponseSchemas = {
  'GET /v1/health': healthResponseSchema,
  'POST /v1/repositories': registeredRepositoryResponseSchema,
  'GET /v1/repositories': z.array(repositoryResponseSchema).max(50),
  'GET /v1/repositories/:id': repositoryResponseSchema,
  'POST /v1/repositories/:id/scans': acceptedScanResponseSchema,
  'GET /v1/scans/:id': scanJobResponseSchema,
  'POST /v1/scans/:id/viewer': viewerResponseSchema,
  'POST /v1/scans/:id/cancel': cancelResponseSchema,
  'GET /v1/scans/:id/projects': z.array(projectRowSchema).max(32),
  'GET /v1/scans/:id/files': filesResponseSchema,
  'GET /v1/scans/:id/projects/:projectId/symbols': listSymbolsResponseSchema,
  'POST /v1/scans/:id/projects/:projectId/neighbors':
    graphNeighborsResponseSchema,
  'POST /v1/scans/:id/projects/:projectId/paths': findSymbolPathsResponseSchema,
  'POST /v1/scans/:id/projects/:projectId/evidence':
    getSourceEvidenceResponseSchema,
} as const;

export type BackendApiRoute = keyof typeof backendApiResponseSchemas;

/** Validate and project service/database values into stable public DTOs. */
export function parseBackendResponse(
  route: BackendApiRoute,
  value: unknown,
): unknown {
  try {
    switch (route) {
      case 'GET /v1/repositories':
        return backendApiResponseSchemas[route].parse(value).map((row) => ({
          ...row,
          desired_generation: String(row.desired_generation),
        }));
      case 'GET /v1/repositories/:id': {
        const row = repositoryRowSchema.parse(value);
        return repositoryResponseSchema.parse({
          ...row,
          desired_generation: String(row.desired_generation),
        });
      }
      case 'GET /v1/scans/:id': {
        const row = scanJobRowSchema.parse(value);
        return scanJobResponseSchema.parse({
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
  return apiErrorResponseSchema.parse(value);
}
