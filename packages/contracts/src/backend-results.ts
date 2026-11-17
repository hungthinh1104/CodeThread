import { idSchema } from '@codethread/code-model';
import { z } from 'zod';
import {
  findSymbolPathsResponseSchema,
  graphNeighborsResponseSchema,
} from './graph-queries.js';
import {
  getSourceEvidenceResponseSchema,
  listSymbolsResponseSchema,
} from './source-queries.js';

const generation = z
  .union([
    z.string().regex(/^(0|[1-9][0-9]*)$/),
    z.number().int().nonnegative(),
    z.bigint().nonnegative(),
  ])
  .transform(String);
const repositoryLocatorSchema = z.string().min(1).max(4096);
export const backendRepositoryResponseSchema = z.strictObject({
  id: idSchema,
  locator: repositoryLocatorSchema,
  desired_generation: generation,
  active_job_id: idSchema.nullable(),
});
export const backendScanResponseSchema = z.strictObject({
  id: idSchema,
  repository_id: idSchema,
  generation,
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
export const backendApiErrorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
    message: z.string().min(1).max(1024),
  }),
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
const registeredRepositorySchema = z.strictObject({
  id: idSchema,
  locator: repositoryLocatorSchema,
});
const acceptedScanSchema = z.strictObject({
  id: idSchema,
  repositoryId: idSchema,
  state: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  reused: z.boolean(),
});
const projectSchema = z.strictObject({
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
const filesSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(1024),
        content_hash: z.string().regex(/^[0-9a-f]{64}$/),
        git_blob_oid: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
        git_mode: z.enum(['100644', '100755']),
      }),
    )
    .max(50),
  total: z.number().int().nonnegative(),
  nextOffset: z.number().int().min(0).max(1256).nullable(),
});
const viewerSchema = z.strictObject({
  url: z.url(),
  expiresAt: z.iso.datetime(),
});
const cancelSchema = z.strictObject({
  id: idSchema,
  state: z.literal('cancelled'),
});

export const backendApiResponseSchemas = {
  'GET /v1/health': healthResponseSchema,
  'POST /v1/repositories': registeredRepositorySchema,
  'GET /v1/repositories': z.array(backendRepositoryResponseSchema).max(50),
  'GET /v1/repositories/:id': backendRepositoryResponseSchema,
  'POST /v1/repositories/:id/scans': acceptedScanSchema,
  'GET /v1/scans/:id': backendScanResponseSchema,
  'POST /v1/scans/:id/viewer': viewerSchema,
  'POST /v1/scans/:id/cancel': cancelSchema,
  'GET /v1/scans/:id/projects': z.array(projectSchema).max(32),
  'GET /v1/scans/:id/files': filesSchema,
  'GET /v1/scans/:id/projects/:projectId/symbols': listSymbolsResponseSchema,
  'POST /v1/scans/:id/projects/:projectId/neighbors':
    graphNeighborsResponseSchema,
  'POST /v1/scans/:id/projects/:projectId/paths': findSymbolPathsResponseSchema,
  'POST /v1/scans/:id/projects/:projectId/evidence':
    getSourceEvidenceResponseSchema,
} as const;

export type BackendApiRoute = keyof typeof backendApiResponseSchemas;
