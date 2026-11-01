import { z } from 'zod';
import {
  codeRelationSchema,
  coverageSchema,
  diagnosticSchema,
  idSchema,
  snapshotPathSchema,
  sourceEvidenceSchema,
  symbolSchema,
  testCaseSchema,
  testCodeLinkSchema,
  testStepSchema,
} from '@codethread/code-model';

export const queryNames = [
  'list_tests',
  'related_symbols',
  'tests_for_symbol',
  'diagnostics',
] as const;
export const cursorPayloadSchema = z.strictObject({
  version: z.literal(1),
  snapshotId: idSchema,
  query: z.enum(queryNames),
  filterKey: z.string().max(4096),
  order: z.literal('source-v1'),
  position: z.strictObject({
    filePath: z.union([snapshotPathSchema, z.literal('')]),
    offset: z.number().int().nonnegative(),
    key: z.string().min(1).max(1024),
  }),
});
export type CursorPayload = z.infer<typeof cursorPayloadSchema>;

/** Canonicalization is for validated query values, not arbitrary source objects. */
export function filterKey(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
      );
    }
    return item;
  });
}

export function encodeCursor(value: CursorPayload): string {
  const bytes = new TextEncoder().encode(
    JSON.stringify(cursorPayloadSchema.parse(value)),
  );
  const token = btoa(
    Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''),
  )
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
  if (token.length > 8192) throw new Error('INVALID_CURSOR');
  return token;
}
export function decodeCursor(token: string): CursorPayload {
  if (token.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(token))
    throw new Error('INVALID_CURSOR');
  try {
    const bytes = Uint8Array.from(
      atob(token.replaceAll('-', '+').replaceAll('_', '/')),
      (character) => character.charCodeAt(0),
    );
    const payload = cursorPayloadSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
    if (encodeCursor(payload) !== token) throw new Error('Noncanonical cursor');
    return payload;
  } catch {
    throw new Error('INVALID_CURSOR');
  }
}

function checkCursor(
  cursor: string | undefined,
  snapshotId: string,
  query: CursorPayload['query'],
  filters: unknown,
  context: z.RefinementCtx,
): void {
  if (cursor === undefined) return;
  try {
    const payload = decodeCursor(cursor);
    if (
      payload.snapshotId !== snapshotId ||
      payload.query !== query ||
      payload.filterKey !== filterKey(filters)
    ) {
      throw new Error('Cursor scope mismatch');
    }
  } catch {
    context.addIssue({
      code: 'custom',
      path: ['cursor'],
      message: 'INVALID_CURSOR',
    });
  }
}

const pageFields = {
  snapshotId: idSchema,
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(8192).optional(),
};
const testFiltersSchema = z.strictObject({
  text: z.string().min(1).max(256).optional(),
  filePath: snapshotPathSchema.optional(),
  suite: z.string().min(1).max(1024).optional(),
});
export const listTestsRequestSchema = z
  .strictObject({ ...pageFields, filters: testFiltersSchema.default({}) })
  .superRefine((request, context) =>
    checkCursor(
      request.cursor,
      request.snapshotId,
      'list_tests',
      request.filters,
      context,
    ),
  );
export const relatedProductionSymbolsRequestSchema = z
  .strictObject({ ...pageFields, testId: idSchema })
  .superRefine((request, context) =>
    checkCursor(
      request.cursor,
      request.snapshotId,
      'related_symbols',
      { testId: request.testId },
      context,
    ),
  );
export const findTestsForSymbolRequestSchema = z
  .strictObject({ ...pageFields, symbolId: idSchema })
  .superRefine((request, context) =>
    checkCursor(
      request.cursor,
      request.snapshotId,
      'tests_for_symbol',
      { symbolId: request.symbolId },
      context,
    ),
  );
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
export const getTestTraceRequestSchema = z.strictObject({
  snapshotId: idSchema,
  testId: idSchema,
  stepLimit: z.number().int().min(1).max(500).default(500),
  symbolLimit: z.number().int().min(1).max(200).default(200),
  relationLimit: z.number().int().min(1).max(1000).default(1000),
});
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
export const graphNeighborsRequestSchema = z.strictObject({
  snapshotId: idSchema,
  symbolId: idSchema,
  direction: z.enum(['outgoing', 'incoming', 'both']).default('outgoing'),
  depth: z.number().int().min(1).max(5).default(2),
  nodeLimit: z.number().int().min(1).max(200).default(200),
});
export const findSymbolPathsRequestSchema = z.strictObject({
  snapshotId: idSchema,
  fromSymbolId: idSchema,
  toSymbolId: idSchema,
  depth: z.number().int().min(1).max(5).default(2),
  nodeLimit: z.number().int().min(1).max(200).default(200),
  pathLimit: z.number().int().min(1).max(20).default(20),
});

const appliedLimitsSchema = z
  .strictObject({
    pageSize: z.number().int().min(1).max(200).optional(),
    steps: z.number().int().min(1).max(500).optional(),
    symbols: z.number().int().min(1).max(200).optional(),
    relationships: z.number().int().min(1).max(1000).optional(),
    evidence: z.number().int().min(1).max(5000).optional(),
    diagnostics: z.number().int().min(1).max(200).optional(),
    depth: z.number().int().min(1).max(5).optional(),
    nodes: z.number().int().min(1).max(200).optional(),
    paths: z.number().int().min(1).max(20).optional(),
    expansions: z.number().int().min(1).max(10000).optional(),
  })
  .refine(
    (limits) => Object.keys(limits).length > 0,
    'Applied limits are required',
  );
export const queryMetaSchema = z
  .strictObject({
    snapshotId: idSchema,
    evidenceBasis: z.literal('static'),
    coverage: coverageSchema,
    truncated: z.boolean(),
    truncationReasons: z
      .array(z.enum(['result_limit', 'depth_limit', 'search_budget']))
      .max(3),
    appliedLimits: appliedLimitsSchema,
  })
  .refine(
    (meta) => meta.truncated === meta.truncationReasons.length > 0,
    'Truncation reasons must match the flag',
  );

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** Every nested snapshot-bearing value must belong to the response snapshot. */
function scoped<T extends z.ZodType>(
  schema: T,
  cursorQuery?: CursorPayload['query'],
): T {
  return schema.superRefine((value, context) => {
    if (!record(value) || !record(value['meta'])) return;
    const snapshotId = value['meta']['snapshotId'];
    function visit(item: unknown): void {
      if (Array.isArray(item)) {
        item.forEach(visit);
        return;
      }
      if (!record(item)) return;
      if ('snapshotId' in item && item['snapshotId'] !== snapshotId) {
        context.addIssue({
          code: 'custom',
          message: 'Cross-snapshot response reference',
        });
      }
      Object.values(item).forEach(visit);
    }
    visit(value);
    const meta = value['meta'];
    const limits = meta['appliedLimits'];
    if (!record(limits)) return;
    function bound(count: number, limit: unknown, label: string): void {
      if (typeof limit !== 'number' || count > limit)
        context.addIssue({
          code: 'custom',
          message: `Missing or exceeded applied ${label} limit`,
        });
    }
    for (const [field, limitName] of [
      ['steps', 'steps'],
      ['evidenceRefs', 'evidence'],
      ['diagnostics', 'diagnostics'],
      ['paths', 'paths'],
    ] as const) {
      if (Array.isArray(value[field]))
        bound(value[field].length, limits[limitName], limitName);
    }
    if (Array.isArray(value['symbols']))
      bound(
        value['symbols'].length,
        limits['symbols'] ?? limits['nodes'],
        'symbols/nodes',
      );
    if (Array.isArray(value['relations'])) {
      const links = Array.isArray(value['links']) ? value['links'].length : 0;
      bound(
        value['relations'].length + links,
        limits['relationships'],
        'relationships',
      );
    }
    if (Array.isArray(value['items'])) {
      const items = value['items'];
      bound(
        items.length,
        'nextCursor' in value ? limits['pageSize'] : limits['evidence'],
        'items',
      );
      const links = items.flatMap((item: unknown) =>
        record(item) && Array.isArray(item['links']) ? item['links'] : [],
      );
      if (links.length > 0)
        bound(links.length, limits['relationships'], 'relationships');
      const identities = items.map((item: unknown) => {
        if (!record(item)) return undefined;
        for (const child of [
          item,
          item['test'],
          item['symbol'],
          item['evidence'],
        ]) {
          if (record(child) && typeof child['id'] === 'string')
            return child['id'];
        }
        return item['evidenceId'];
      });
      if (new Set(identities).size !== identities.length)
        context.addIssue({
          code: 'custom',
          message: 'Duplicate result identity',
        });
    }
    if (typeof value['nextCursor'] === 'string') {
      try {
        const payload = decodeCursor(value['nextCursor']);
        if (
          payload.snapshotId !== snapshotId ||
          payload.query !== cursorQuery ||
          meta['truncated'] !== true ||
          !Array.isArray(meta['truncationReasons']) ||
          !meta['truncationReasons'].includes('result_limit') ||
          !Array.isArray(value['items']) ||
          value['items'].length === 0
        )
          throw new Error('Invalid continuation');
      } catch {
        context.addIssue({
          code: 'custom',
          message: 'Invalid response continuation cursor',
        });
      }
    }
  });
}

const nextCursor = z.string().min(1).max(8192).nullable();
export const listTestsResponseSchema = scoped(
  z.strictObject({
    meta: queryMetaSchema,
    items: z.array(testCaseSchema).max(200),
    nextCursor,
  }),
  'list_tests',
);
const graphFields = {
  symbols: z.array(symbolSchema).max(200),
  relations: z.array(codeRelationSchema).max(1000),
  evidenceRefs: z.array(sourceEvidenceSchema).max(5000),
  diagnostics: z.array(diagnosticSchema).max(200),
};
type Graph = {
  [K in keyof typeof graphFields]: z.infer<(typeof graphFields)[K]>;
};
function graphIntegrity(graph: Graph, context: z.RefinementCtx): void {
  for (const values of [
    graph.symbols,
    graph.relations,
    graph.evidenceRefs,
    graph.diagnostics,
  ]) {
    if (new Set(values.map((item) => item.id)).size !== values.length) {
      context.addIssue({ code: 'custom', message: 'Duplicate graph identity' });
    }
  }
  const symbolIds = new Set(graph.symbols.map((item) => item.id));
  const evidenceIds = new Set(graph.evidenceRefs.map((item) => item.id));
  const diagnosticIds = new Set(graph.diagnostics.map((item) => item.id));
  for (const symbol of graph.symbols) {
    if (symbol.evidenceIds.some((id) => !evidenceIds.has(id))) {
      context.addIssue({
        code: 'custom',
        message: 'Missing symbol evidence reference',
      });
    }
  }
  for (const relation of graph.relations) {
    if (
      !symbolIds.has(relation.sourceSymbolId) ||
      (relation.resolution.status === 'exact' &&
        !symbolIds.has(relation.resolution.targetId))
    ) {
      context.addIssue({ code: 'custom', message: 'Dangling graph endpoint' });
    }
    checkResolutionReferences(
      relation.resolution,
      evidenceIds,
      diagnosticIds,
      context,
    );
  }
}
type ResolutionReferences = z.infer<typeof codeRelationSchema>['resolution'];
function checkResolutionReferences(
  resolution: ResolutionReferences,
  evidence: Set<string>,
  diagnostics: Set<string>,
  context: z.RefinementCtx,
): void {
  if (
    resolution.evidenceIds.some((id) => !evidence.has(id)) ||
    (resolution.status !== 'exact' &&
      resolution.diagnosticIds.some((id) => !diagnostics.has(id)))
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Missing resolution evidence or diagnostic reference',
    });
  }
}

export const getTestTraceResponseSchema = scoped(
  z
    .strictObject({
      meta: queryMetaSchema,
      test: testCaseSchema,
      steps: z.array(testStepSchema).max(500),
      links: z.array(testCodeLinkSchema).max(1000),
      ...graphFields,
    })
    .superRefine((trace, context) => {
      graphIntegrity(trace, context);
      const evidenceIds = new Set(trace.evidenceRefs.map((item) => item.id));
      const diagnosticIds = new Set(trace.diagnostics.map((item) => item.id));
      const symbolIds = new Set(trace.symbols.map((item) => item.id));
      const stepIds = new Set(trace.steps.map((item) => item.id));
      if (
        stepIds.size !== trace.steps.length ||
        new Set(trace.links.map((link) => link.id)).size !== trace.links.length
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Duplicate trace identity',
        });
      }
      if (!evidenceIds.has(trace.test.declarationEvidenceId))
        context.addIssue({
          code: 'custom',
          message: 'Missing test declaration evidence',
        });
      const parents = new Map(
        trace.steps.map((step) => [step.id, step.parentStepId]),
      );
      for (const step of trace.steps) {
        if (
          step.testId !== trace.test.id ||
          (step.parentStepId !== null && !stepIds.has(step.parentStepId)) ||
          step.evidenceIds.some((id) => !evidenceIds.has(id))
        ) {
          context.addIssue({
            code: 'custom',
            message: 'Invalid step ownership or evidence',
          });
        }
        const visited = new Set<string>();
        let current: string | null | undefined = step.id;
        while (current !== null && current !== undefined) {
          if (visited.has(current)) {
            context.addIssue({
              code: 'custom',
              message: 'Cyclic step containment',
            });
            break;
          }
          visited.add(current);
          current = parents.get(current);
        }
      }
      for (const link of trace.links) {
        if (
          link.testId !== trace.test.id ||
          !stepIds.has(link.stepId) ||
          (link.resolution.status === 'exact' &&
            !symbolIds.has(link.resolution.targetId))
        ) {
          context.addIssue({
            code: 'custom',
            message: 'Invalid test-link ownership or endpoint',
          });
        }
        checkResolutionReferences(
          link.resolution,
          evidenceIds,
          diagnosticIds,
          context,
        );
      }
    }),
);

export const relatedProductionSymbolsResponseSchema = scoped(
  z
    .strictObject({
      meta: queryMetaSchema,
      testId: idSchema,
      items: z
        .array(
          z.strictObject({
            symbol: symbolSchema,
            links: z.array(testCodeLinkSchema).min(1).max(1000),
          }),
        )
        .max(200),
      nextCursor,
    })
    .superRefine((response, context) => {
      for (const item of response.items) {
        if (
          item.links.some(
            (link) =>
              link.testId !== response.testId ||
              link.resolution.status !== 'exact' ||
              link.resolution.targetId !== item.symbol.id,
          )
        ) {
          context.addIssue({
            code: 'custom',
            message: 'Related symbol requires matching exact test links',
          });
        }
      }
    }),
  'related_symbols',
);
export const findTestsForSymbolResponseSchema = scoped(
  z
    .strictObject({
      meta: queryMetaSchema,
      symbolId: idSchema,
      items: z
        .array(
          z.strictObject({
            test: testCaseSchema,
            links: z.array(testCodeLinkSchema).min(1).max(1000),
          }),
        )
        .max(200),
      nextCursor,
    })
    .superRefine((response, context) => {
      for (const item of response.items) {
        if (
          item.links.some(
            (link) =>
              link.testId !== item.test.id ||
              link.resolution.status !== 'exact' ||
              link.resolution.targetId !== response.symbolId,
          )
        ) {
          context.addIssue({
            code: 'custom',
            message: 'Reverse lookup requires matching exact test links',
          });
        }
      }
    }),
  'tests_for_symbol',
);

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
  z.strictObject({
    meta: queryMetaSchema,
    items: z
      .array(z.union([sourceSuccessSchema, sourceFailureSchema]))
      .max(100),
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
export const graphNeighborsResponseSchema = scoped(
  z
    .strictObject({
      meta: queryMetaSchema,
      rootSymbolId: idSchema,
      ...graphFields,
    })
    .superRefine((graph, context) => {
      graphIntegrity(graph, context);
      if (!graph.symbols.some((symbol) => symbol.id === graph.rootSymbolId))
        context.addIssue({ code: 'custom', message: 'Missing root symbol' });
    }),
);
export const findSymbolPathsResponseSchema = scoped(
  z
    .strictObject({
      meta: queryMetaSchema,
      fromSymbolId: idSchema,
      toSymbolId: idSchema,
      ...graphFields,
      paths: z
        .array(
          z.strictObject({
            symbolIds: z.array(idSchema).min(1).max(6),
            relationIds: z.array(idSchema).max(5),
          }),
        )
        .max(20),
    })
    .superRefine((graph, context) => {
      graphIntegrity(graph, context);
      const relations = new Map(
        graph.relations.map((relation) => [relation.id, relation]),
      );
      const symbols = new Set(graph.symbols.map((symbol) => symbol.id));
      for (const path of graph.paths) {
        if (
          path.symbolIds.length !== path.relationIds.length + 1 ||
          new Set(path.symbolIds).size !== path.symbolIds.length ||
          path.symbolIds.some((id) => !symbols.has(id)) ||
          path.symbolIds[0] !== graph.fromSymbolId ||
          path.symbolIds.at(-1) !== graph.toSymbolId
        ) {
          context.addIssue({
            code: 'custom',
            message: 'Invalid cycle-safe path',
          });
        }
        path.relationIds.forEach((id, index) => {
          const relation = relations.get(id);
          if (
            !relation ||
            relation.sourceSymbolId !== path.symbolIds[index] ||
            relation.resolution.status !== 'exact' ||
            relation.resolution.targetId !== path.symbolIds[index + 1]
          ) {
            context.addIssue({
              code: 'custom',
              message: 'Path relation does not connect its symbols',
            });
          }
        });
      }
    }),
);

export const queryErrorSchema = z.strictObject({
  code: z.enum([
    'INVALID_REQUEST',
    'INVALID_CURSOR',
    'SNAPSHOT_NOT_FOUND',
    'SNAPSHOT_NOT_PUBLISHED',
    'ENTITY_NOT_FOUND',
    'SOURCE_UNAVAILABLE',
    'HASH_MISMATCH',
    'RESOURCE_LIMIT',
    'QUERY_TIMEOUT',
  ]),
  message: z.string().min(1).max(1024),
});

export type ListTestsRequest = z.infer<typeof listTestsRequestSchema>;
export type TestTrace = z.infer<typeof getTestTraceResponseSchema>;
export type QueryMeta = z.infer<typeof queryMetaSchema>;
export type GetTestTraceRequest = z.infer<typeof getTestTraceRequestSchema>;
export type RelatedProductionSymbolsRequest = z.infer<
  typeof relatedProductionSymbolsRequestSchema
>;
export type RelatedProductionSymbolsResponse = z.infer<
  typeof relatedProductionSymbolsResponseSchema
>;
export type FindTestsForSymbolRequest = z.infer<
  typeof findTestsForSymbolRequestSchema
>;
export type FindTestsForSymbolResponse = z.infer<
  typeof findTestsForSymbolResponseSchema
>;
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
export type GraphNeighborsRequest = z.infer<typeof graphNeighborsRequestSchema>;
export type GraphNeighborsResponse = z.infer<
  typeof graphNeighborsResponseSchema
>;
export type FindSymbolPathsRequest = z.infer<
  typeof findSymbolPathsRequestSchema
>;
export type FindSymbolPathsResponse = z.infer<
  typeof findSymbolPathsResponseSchema
>;
export type ListTestsResponse = z.infer<typeof listTestsResponseSchema>;
