import {
  coverageByCapabilitySchema,
  coverageSchema,
  diagnosticSchema,
  idSchema,
  snapshotIdentitySchema,
  summarizeCoverage,
  symbolSchema,
} from '@codethread/code-model';
import { z } from 'zod';
import { viewerPageConsistencyIssues } from './viewer-page.js';
import {
  graphNeighborsRequestSchema,
  graphNeighborsResponseSchema,
} from './graph-queries.js';
import {
  getSourceEvidenceRequestSchema,
  getSourceEvidenceResponseSchema,
} from './source-queries.js';

const projectId = z.string().min(1).max(64);
const analysisCountsSchema = z.strictObject({
  files: z.number().int().nonnegative(),
  declarations: z.number().int().nonnegative(),
  callSites: z.number().int().nonnegative(),
  exact: z.number().int().nonnegative(),
  unresolved: z.number().int().nonnegative(),
  ambiguous: z.number().int().nonnegative(),
  unsupported: z.number().int().nonnegative(),
  notAnalyzedInputs: z.number().int().nonnegative(),
});
const projectDiagnosticSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string().min(1),
  path: z.string().optional(),
});

export const viewerSessionResponseSchema = z
  .strictObject({
    snapshotId: idSchema,
    identity: snapshotIdentitySchema,
    counts: analysisCountsSchema,
    coverage: coverageSchema,
    coverageByCapability: coverageByCapabilitySchema,
  })
  .superRefine((session, context) => {
    if (session.coverage !== summarizeCoverage(session.coverageByCapability))
      context.addIssue({
        code: 'custom',
        path: ['coverage'],
        message:
          'Session coverage must match summarizeCoverage(coverageByCapability).',
      });
  });

export const viewerSymbolSearchResponseSchema = z
  .strictObject({
    snapshotId: idSchema,
    query: z.string().max(256),
    offset: z.number().int().min(0).max(20000),
    limit: z.literal(50),
    total: z.number().int().nonnegative(),
    nextOffset: z.number().int().min(0).max(20000).nullable(),
    items: z.array(symbolSchema).max(50),
  })
  .superRefine((page, context) => {
    for (const issue of viewerPageConsistencyIssues(page))
      context.addIssue({
        code: 'custom',
        path: [issue.path],
        message: issue.message,
      });
    page.items.forEach((symbol, index) => {
      if (symbol.snapshotId !== page.snapshotId)
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'snapshotId'],
          message: 'Symbol must belong to the declared page snapshot.',
        });
    });
  });

const unsupportedObservationSchema = z.strictObject({
  evidenceId: idSchema,
  status: z.enum(['ambiguous', 'unresolved', 'unsupported']),
  diagnostic: diagnosticSchema.nullable(),
});
export const viewerGraphResponseSchema = z
  .strictObject({
    graph: graphNeighborsResponseSchema,
    unknowns: z.strictObject({
      total: z.number().int().nonnegative(),
      items: z.array(unsupportedObservationSchema).max(50),
    }),
  })
  .superRefine((response, context) => {
    if (response.unknowns.items.length > response.unknowns.total)
      context.addIssue({
        code: 'custom',
        path: ['unknowns', 'total'],
        message: 'Unknown observation items cannot exceed unknowns.total.',
      });
    response.unknowns.items.forEach((item, index) => {
      if (
        item.diagnostic &&
        item.diagnostic.snapshotId !== response.graph.meta.snapshotId
      )
        context.addIssue({
          code: 'custom',
          path: ['unknowns', 'items', index, 'diagnostic', 'snapshotId'],
          message:
            'Unknown observation diagnostic must belong to the graph snapshot.',
        });
    });
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
      diagnostics: z.array(projectDiagnosticSchema).max(10),
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
    const seen = new Set<string>();
    response.candidates.forEach((candidate, index) => {
      const key = `${candidate.projectId}:${candidate.snapshotId}:${candidate.symbolId}`;
      if (seen.has(key))
        context.addIssue({
          code: 'custom',
          path: ['candidates', index],
          message: 'Follow candidates must be distinct.',
        });
      seen.add(key);
    });
  });
const projectEnvelope = <T extends z.ZodType>(result: T) =>
  z.strictObject({ projectId, result });
const requestEnvelope = <T extends z.ZodType>(request: T) =>
  z.strictObject({ projectId, request });
const sessionRequestSchema = z.strictObject({});
const followContextRequestSchema = z.strictObject({
  snapshotId: idSchema,
  symbolId: idSchema,
});
const symbolSearchRequestSchema = z.strictObject({
  query: z.string().max(256).default(''),
  offset: z.number().int().min(0).max(20000).default(0),
});
const boundedGraphRequestSchema = graphNeighborsRequestSchema.superRefine(
  (request, context) => {
    if (request.depth > 2 || request.nodeLimit > 50)
      context.addIssue({
        code: 'custom',
        path: ['depth'],
        message: 'Viewer graph bounds are depth two and fifty symbols.',
      });
    if (
      request.relationKinds.some(
        (kind) => kind !== 'calls' && kind !== 'references',
      )
    )
      context.addIssue({
        code: 'custom',
        path: ['relationKinds'],
        message: 'Viewer supports CALLS and REFERENCES only.',
      });
  },
);

const repositoryRequestSchemas = {
  '/api/projects': z.strictObject({}),
  '/api/catalog': z.strictObject({
    query: z.string().max(256).default(''),
    offset: z.number().int().min(0).max(640000).default(0),
  }),
  '/api/files': z.strictObject({
    offset: z.number().int().min(0).max(2000).default(0),
  }),
  '/api/follow-context': requestEnvelope(followContextRequestSchema),
  '/api/session': requestEnvelope(sessionRequestSchema),
  '/api/symbols': requestEnvelope(symbolSearchRequestSchema),
  '/api/neighbors': requestEnvelope(boundedGraphRequestSchema),
  '/api/evidence': requestEnvelope(getSourceEvidenceRequestSchema),
} as const;

export const viewerApiRepositoryRequestSchemas = repositoryRequestSchemas;

export const viewerApiRequestSchemas = {
  '/api/projects': repositoryRequestSchemas['/api/projects'],
  '/api/catalog': repositoryRequestSchemas['/api/catalog'],
  '/api/files': repositoryRequestSchemas['/api/files'],
  '/api/follow-context': z.union([
    followContextRequestSchema,
    repositoryRequestSchemas['/api/follow-context'],
  ]),
  '/api/session': z.union([
    sessionRequestSchema,
    repositoryRequestSchemas['/api/session'],
  ]),
  '/api/symbols': z.union([
    symbolSearchRequestSchema,
    repositoryRequestSchemas['/api/symbols'],
  ]),
  '/api/neighbors': z.union([
    boundedGraphRequestSchema,
    repositoryRequestSchemas['/api/neighbors'],
  ]),
  '/api/evidence': z.union([
    getSourceEvidenceRequestSchema,
    repositoryRequestSchemas['/api/evidence'],
  ]),
} as const;

export const viewerApiResponseSchemas = {
  '/api/projects': projectsResponseSchema,
  '/api/catalog': catalogResponseSchema,
  '/api/files': filesResponseSchema,
  '/api/follow-context': followResponseSchema,
  '/api/session': z.union([
    viewerSessionResponseSchema,
    projectEnvelope(viewerSessionResponseSchema),
  ]),
  '/api/symbols': z.union([
    viewerSymbolSearchResponseSchema,
    projectEnvelope(viewerSymbolSearchResponseSchema),
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
