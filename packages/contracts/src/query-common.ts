import { z } from 'zod';
import {
  idSchema,
  snapshotPathSchema,
  coverageSchema,
  coverageByCapabilitySchema,
  summarizeCoverage,
} from '@codethread/code-model';
import { checkLocations, checkUnique } from './integrity.js';

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

export function checkCursor(
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

export const pageFields = {
  snapshotId: idSchema,
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(8192).optional(),
};

export type PageRequest = z.infer<z.ZodObject<typeof pageFields>>;

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
    coverageByCapability: coverageByCapabilitySchema,
    truncated: z.boolean(),
    truncationReasons: z
      .array(z.enum(['result_limit', 'depth_limit', 'search_budget']))
      .max(3)
      .refine(
        (reasons) => new Set(reasons).size === reasons.length,
        'Duplicate truncation reasons',
      ),
    appliedLimits: appliedLimitsSchema,
  })
  .refine(
    (meta) =>
      Object.keys(meta.coverageByCapability).length > 0 &&
      meta.coverage === summarizeCoverage(meta.coverageByCapability),
    'Aggregate coverage must match capability coverage',
  )
  .refine(
    (meta) => meta.truncated === meta.truncationReasons.length > 0,
    'Truncation reasons must match the flag',
  );

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Every nested snapshot-bearing value must belong to the response snapshot. */
export function scoped<T extends z.ZodType>(
  schema: T,
  cursorQuery?: CursorPayload['query'],
): T {
  return schema.superRefine((value, context) => {
    if (!record(value) || !record(value['meta'])) return;
    const snapshotId = value['meta']['snapshotId'];
    const locations: { fileId: string; filePath: string }[] = [];
    function visit(item: unknown): void {
      if (Array.isArray(item)) {
        item.forEach(visit);
        return;
      }
      if (!record(item)) return;
      if (
        typeof item['fileId'] === 'string' &&
        typeof item['filePath'] === 'string'
      )
        locations.push({ fileId: item['fileId'], filePath: item['filePath'] });
      if ('snapshotId' in item && item['snapshotId'] !== snapshotId) {
        context.addIssue({
          code: 'custom',
          message: 'Cross-snapshot response reference',
        });
      }
      Object.values(item).forEach(visit);
    }
    visit(value);
    checkLocations(locations, context);
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
        'nextCursor' in value || 'nextOffset' in value
          ? limits['pageSize']
          : limits['evidence'],
        'items',
      );
      const links = items.flatMap((item: unknown) =>
        record(item) && Array.isArray(item['links']) ? item['links'] : [],
      );
      if (links.length > 0)
        bound(links.length, limits['relationships'], 'relationships');
      const identities = items.flatMap((item: unknown) => {
        if (!record(item)) return [];
        for (const child of [
          item,
          item['test'],
          item['symbol'],
          item['evidence'],
        ]) {
          if (record(child) && typeof child['id'] === 'string')
            return [
              {
                id: child['id'],
                ...(typeof child['key'] === 'string'
                  ? { key: child['key'] }
                  : {}),
              },
            ];
        }
        return typeof item['evidenceId'] === 'string'
          ? [{ id: item['evidenceId'] }]
          : [];
      });
      checkUnique(identities, context, ['items']);
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

export const nextCursor = z.string().min(1).max(8192).nullable();

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

export type QueryMeta = z.infer<typeof queryMetaSchema>;
