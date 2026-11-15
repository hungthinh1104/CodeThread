import { idSchema, symbolSchema } from '@codethread/code-model';
import { getSourceEvidenceResponseSchema } from '@codethread/contracts';
import { z } from 'zod';
import type { ViewerDataset } from './viewer-dataset.ts';
import {
  querySnapshot,
  sessionResponseSchema,
  symbolSearchResponseSchema,
  viewerGraphResponseSchema,
} from './viewer-projection.ts';
import { viewerPageConsistencyIssues } from './viewer-page-contract.ts';
import { ViewerFailure } from './viewer-errors.ts';

const projectId = z.string().min(1).max(64);
const envelope = z.strictObject({ projectId, request: z.unknown() });
const search = z.strictObject({
  query: z.string().max(256).default(''),
  offset: z.number().int().min(0).max(640000).default(0),
});
const followRequest = z.strictObject({
  snapshotId: idSchema,
  symbolId: idSchema,
});
const projectDiagnosticSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string().min(1),
  path: z.string().optional(),
});
const projectsResponseSchema = z.strictObject({
  mode: z.enum(['repository', 'selected']),
  initialProjectId: projectId.nullable(),
  repositoryId: idSchema,
  commitId: z
    .string()
    .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
    .nullable(),
  source: z
    .strictObject({
      files: z.number().int().nonnegative(),
      bytes: z.number().int().nonnegative(),
      excludedTypeScriptFiles: z.number().int().nonnegative(),
      inventoryComplete: z.boolean(),
      sourceCoverageComplete: z.boolean(),
      analysisComplete: z.boolean(),
      contextComplete: z.boolean(),
      diagnostics: z.array(projectDiagnosticSchema),
    })
    .nullable(),
  items: z.array(
    z.strictObject({
      id: projectId,
      label: z.string().min(1),
      status: z.enum([
        'ready',
        'solution',
        'invalid',
        'unsupported',
        'failed',
        'not_analyzed',
      ]),
      snapshotId: idSchema.nullable(),
      rootFiles: z.number().int().nonnegative(),
      diagnosticCount: z.number().int().nonnegative(),
      diagnostics: z
        .array(
          z.strictObject({
            code: z.string().min(1),
            message: z.string().min(1),
          }),
        )
        .max(10),
      sourceDiagnosticCount: z.number().int().nonnegative(),
    }),
  ),
});
const catalogResponseSchema = z
  .strictObject({
    query: z.string().max(256),
    offset: z.number().int().nonnegative(),
    limit: z.literal(50),
    total: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
    items: z
      .array(
        z.strictObject({
          projectId,
          projectLabel: z.string().min(1),
          snapshotId: idSchema,
          symbol: symbolSchema,
        }),
      )
      .max(50),
  })
  .superRefine((page, context) => {
    for (const issue of viewerPageConsistencyIssues(page))
      context.addIssue({
        code: 'custom',
        path: [issue.path],
        message: issue.message,
      });
    page.items.forEach((item, index) => {
      if (item.snapshotId !== item.symbol.snapshotId)
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'symbol', 'snapshotId'],
          message: 'Catalog symbol must belong to its declared snapshot.',
        });
    });
  });
const viewerFileResponseSchema = z
  .strictObject({
    path: z.string().min(1).max(1024),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    blobId: z
      .string()
      .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
      .optional(),
    byteLength: z.number().int().nonnegative().nullable(),
    status: z.enum(['analyzed', 'not_analyzed', 'excluded']),
    analysisReason: z.string().min(1).optional(),
    projectIds: z.array(projectId),
  })
  .superRefine((file, context) => {
    if (
      file.status === 'excluded' &&
      (file.sha256 !== null ||
        file.byteLength !== null ||
        file.blobId !== undefined)
    )
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'Excluded files cannot claim source or Git blob content.',
      });
    if (
      file.status !== 'excluded' &&
      (file.sha256 === null || file.byteLength === null)
    )
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'Included files must retain verified source identity.',
      });
  });
const filesResponseSchema = z
  .strictObject({
    offset: z.number().int().nonnegative(),
    limit: z.literal(50),
    total: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
    items: z.array(viewerFileResponseSchema).max(50),
  })
  .superRefine((page, context) => {
    for (const issue of viewerPageConsistencyIssues(page))
      context.addIssue({
        code: 'custom',
        path: [issue.path],
        message: issue.message,
      });
  });
const followResponseSchema = z
  .strictObject({
    projectId,
    snapshotId: idSchema,
    symbolId: idSchema,
    requiresChoice: z.boolean(),
    candidates: z
      .array(
        z.strictObject({
          projectId,
          projectLabel: z.string().min(1),
          snapshotId: idSchema,
          symbolId: idSchema,
        }),
      )
      .min(1),
  })
  .superRefine((response, context) => {
    if (response.requiresChoice !== response.candidates.length > 1)
      context.addIssue({
        code: 'custom',
        path: ['requiresChoice'],
        message: 'Choice requirement must match the candidate count.',
      });
  });
const projectEnvelope = <T extends z.ZodType>(result: T) =>
  z.strictObject({ projectId, result });

export const viewerApiResponseSchemas = {
  '/api/projects': projectsResponseSchema,
  '/api/catalog': catalogResponseSchema,
  '/api/files': filesResponseSchema,
  '/api/follow-context': followResponseSchema,
  '/api/session': z.union([
    sessionResponseSchema,
    projectEnvelope(sessionResponseSchema),
  ]),
  '/api/symbols': z.union([
    symbolSearchResponseSchema,
    projectEnvelope(symbolSearchResponseSchema),
  ]),
  '/api/neighbors': z.union([
    viewerGraphResponseSchema,
    projectEnvelope(viewerGraphResponseSchema),
  ]),
  '/api/evidence': z.union([
    getSourceEvidenceResponseSchema,
    projectEnvelope(getSourceEvidenceResponseSchema),
  ]),
} as const;

function validateResponse(pathname: string, value: unknown): unknown {
  const schema =
    viewerApiResponseSchemas[pathname as keyof typeof viewerApiResponseSchemas];
  if (!schema) throw new ViewerFailure('NOT_FOUND', 'Resource not found.', 404);
  try {
    return schema.parse(value);
  } catch {
    throw new ViewerFailure(
      'INTERNAL_ERROR',
      'Viewer response failed contract validation.',
      500,
    );
  }
}

export function queryViewer(
  dataset: ViewerDataset,
  pathname: string,
  body: unknown,
): unknown {
  if (pathname === '/api/projects') {
    z.strictObject({}).parse(body);
    return validateResponse(pathname, dataset.projects());
  }
  if (pathname === '/api/catalog') {
    const request = search.parse(body);
    return validateResponse(
      pathname,
      dataset.search(request.query, request.offset),
    );
  }
  if (pathname === '/api/files') {
    const request = z
      .strictObject({ offset: z.number().int().min(0).max(2000).default(0) })
      .parse(body);
    return validateResponse(pathname, dataset.files(request.offset));
  }
  const scope = dataset.repository
    ? envelope.parse(body)
    : { projectId: 'selected', request: body };
  const { snapshot, investigation } = dataset.get(scope.projectId);
  if (pathname === '/api/follow-context') {
    const request = followRequest.parse(scope.request);
    return validateResponse(
      pathname,
      dataset.follow(scope.projectId, request.snapshotId, request.symbolId),
    );
  }
  if (pathname === '/api/symbols') {
    const request = search.parse(scope.request);
    if (
      request.offset >
      (snapshot.resourceProfile === 'repository' ? 20000 : 2000)
    )
      throw new ViewerFailure(
        'INVALID_REQUEST',
        'Symbol offset exceeds the selected resource profile.',
        400,
      );
  }
  const result = querySnapshot(
    snapshot,
    investigation,
    pathname,
    scope.request,
  );
  return validateResponse(
    pathname,
    dataset.repository ? { projectId: scope.projectId, result } : result,
  );
}
