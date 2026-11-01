import { z } from 'zod';
import {
  decodeCursor,
  filterKey,
  listTestsRequestSchema,
  listTestsResponseSchema,
  relatedProductionSymbolsRequestSchema,
  relatedProductionSymbolsResponseSchema,
  findTestsForSymbolRequestSchema,
  findTestsForSymbolResponseSchema,
  getSourceEvidenceRequestSchema,
  getSourceEvidenceResponseSchema,
  getTestTraceRequestSchema,
  getTestTraceResponseSchema,
  getDiagnosticsRequestSchema,
  getDiagnosticsResponseSchema,
  graphNeighborsRequestSchema,
  graphNeighborsResponseSchema,
  findSymbolPathsRequestSchema,
  findSymbolPathsResponseSchema,
} from './schemas.js';
import { sourceEvidenceSchema, testStepSchema } from '@codethread/code-model';
import type {
  CodeSymbol,
  TestCase,
  TestCodeLink,
} from '@codethread/code-model';
import {
  checkUnique,
  indexEvidence,
  checkDeclaration,
  checkSite,
  checkStepHierarchy,
} from './integrity.js';
import type { CursorPayload, ListTestsRequest, QueryMeta } from './schemas.js';

function ensure(
  condition: unknown,
  message: string,
  path: (string | number)[] = [],
): asserts condition {
  if (!condition)
    throw new z.ZodError([
      { code: 'custom', path: ['response', ...path], message },
    ]);
}
function compareText(left: string, right: string): number {
  const a = new TextEncoder().encode(left),
    b = new TextEncoder().encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}
type Position = CursorPayload['position'];
function comparePosition(left: Position, right: Position): number {
  return (
    compareText(left.filePath, right.filePath) ||
    left.offset - right.offset ||
    compareText(left.key, right.key)
  );
}
function snapshot(requestId: string, meta: QueryMeta): void {
  ensure(
    meta.snapshotId === requestId,
    'Response snapshot does not match request',
    ['meta', 'snapshotId'],
  );
}
function applied(
  meta: QueryMeta,
  key: keyof QueryMeta['appliedLimits'],
  requested: number,
  actual: number,
): number {
  const limit = meta.appliedLimits[key];
  ensure(
    limit !== undefined && limit <= requested && actual <= limit,
    'Missing or exceeded requested/applied ' + key + ' limit',
    ['meta', 'appliedLimits', key],
  );
  return limit;
}
function pageChecks(
  request: Pick<ListTestsRequest, 'snapshotId' | 'limit' | 'cursor'>,
  response: { meta: QueryMeta; nextCursor: string | null },
  query: CursorPayload['query'],
  filters: unknown,
  positions: readonly Position[],
): void {
  snapshot(request.snapshotId, response.meta);
  applied(response.meta, 'pageSize', request.limit, positions.length);
  let previous =
    request.cursor === undefined
      ? undefined
      : decodeCursor(request.cursor).position;
  positions.forEach((position, index) => {
    ensure(
      previous === undefined || comparePosition(previous, position) < 0,
      'Page ordering must strictly advance beyond the input cursor',
      ['items', index],
    );
    previous = position;
  });
  if (response.nextCursor !== null) {
    const cursor = decodeCursor(response.nextCursor);
    ensure(
      cursor.snapshotId === request.snapshotId &&
        cursor.query === query &&
        cursor.filterKey === filterKey(filters),
      'Continuation scope/filter does not match request',
      ['nextCursor'],
    );
    const last = positions.at(-1);
    ensure(
      last !== undefined && comparePosition(last, cursor.position) === 0,
      'Invalid continuation position',
      ['nextCursor'],
    );
  }
}

export function parseListTestsResult(
  requestInput: unknown,
  responseInput: unknown,
) {
  const request = listTestsRequestSchema.parse(requestInput),
    response = listTestsResponseSchema.parse(responseInput);
  pageChecks(
    request,
    response,
    'list_tests',
    request.filters,
    response.items.map((test) => ({
      filePath: test.filePath,
      offset: test.range.start.offset,
      key: test.key,
    })),
  );
  return response;
}

const linkContextSchema = z.strictObject({
  steps: z.array(testStepSchema).max(1000),
  evidenceRefs: z.array(sourceEvidenceSchema).max(5000),
});
export type LinkValidationContext = z.infer<typeof linkContextSchema>;

function supportingLinks(
  input: unknown,
  snapshotId: string,
  links: readonly TestCodeLink[],
  declarations: readonly (CodeSymbol | TestCase)[],
): void {
  linkContextSchema
    .superRefine((support, context) => {
      checkUnique(support.steps, context, ['steps']);
      checkStepHierarchy(support.steps, context);
      const evidence = indexEvidence(support.evidenceRefs, snapshotId, context);
      const steps = new Map(support.steps.map((step) => [step.id, step]));
      for (const declaration of declarations) {
        checkDeclaration(declaration, evidence, context, [
          'declarations',
          declaration.id,
        ]);
        if (
          'evidenceIds' in declaration &&
          declaration.evidenceIds.some((id) => !evidence.has(id))
        )
          context.addIssue({
            code: 'custom',
            message: 'Missing supporting declaration evidence',
          });
      }
      for (const step of support.steps) {
        if (
          step.snapshotId !== snapshotId ||
          step.evidenceIds.some((id) => !evidence.has(id))
        )
          context.addIssue({
            code: 'custom',
            path: ['steps', step.id],
            message: 'Invalid supporting step snapshot/evidence',
          });
        const parent =
          step.parentStepId === null ? undefined : steps.get(step.parentStepId);
        if (parent && parent.testId !== step.testId)
          context.addIssue({
            code: 'custom',
            path: ['steps', step.id],
            message: 'Invalid supporting parent step ownership',
          });
      }
      for (const link of links) {
        const step = steps.get(link.stepId);
        if (!step || step.testId !== link.testId)
          context.addIssue({
            code: 'custom',
            path: ['links', link.id, 'stepId'],
            message: 'Invalid link step ownership',
          });
        if (link.resolution.evidenceIds.some((id) => !evidence.has(id)))
          context.addIssue({
            code: 'custom',
            path: ['links', link.id],
            message: 'Missing supporting link evidence',
          });
        if (step)
          checkSite(
            link.siteEvidenceId,
            step.sourceEvidenceId,
            evidence,
            context,
            ['links', link.id, 'siteEvidenceId'],
          );
      }
    })
    .parse(input);
}

export function parseRelatedProductionSymbolsResult(
  requestInput: unknown,
  responseInput: unknown,
  context: unknown,
) {
  const request = relatedProductionSymbolsRequestSchema.parse(requestInput),
    response = relatedProductionSymbolsResponseSchema.parse(responseInput);
  ensure(
    request.testId === response.testId,
    'Related test selection does not match request',
    ['testId'],
  );
  pageChecks(
    request,
    response,
    'related_symbols',
    { testId: request.testId },
    response.items.map(({ symbol }) => ({
      filePath: symbol.filePath,
      offset: symbol.range.start.offset,
      key: symbol.key,
    })),
  );
  supportingLinks(
    context,
    request.snapshotId,
    response.items.flatMap((item) => item.links),
    response.items.map((item) => item.symbol),
  );
  return response;
}

export function parseFindTestsForSymbolResult(
  requestInput: unknown,
  responseInput: unknown,
  context: unknown,
) {
  const request = findTestsForSymbolRequestSchema.parse(requestInput),
    response = findTestsForSymbolResponseSchema.parse(responseInput);
  ensure(
    request.symbolId === response.symbolId,
    'Reverse symbol selection does not match request',
    ['symbolId'],
  );
  pageChecks(
    request,
    response,
    'tests_for_symbol',
    { symbolId: request.symbolId },
    response.items.map(({ test }) => ({
      filePath: test.filePath,
      offset: test.range.start.offset,
      key: test.key,
    })),
  );
  supportingLinks(
    context,
    request.snapshotId,
    response.items.flatMap((item) => item.links),
    response.items.map((item) => item.test),
  );
  return response;
}

/** Checks correspondence and structure; source-byte authenticity belongs to a source adapter. */
export function parseGetSourceEvidenceResult(
  requestInput: unknown,
  responseInput: unknown,
) {
  const request = getSourceEvidenceRequestSchema.parse(requestInput),
    response = getSourceEvidenceResponseSchema.parse(responseInput);
  snapshot(request.snapshotId, response.meta);
  applied(response.meta, 'evidence', 100, response.items.length);
  const returned = response.items.map((item) =>
    item.status === 'available' ? item.evidence.id : item.evidenceId,
  );
  ensure(
    returned.length === request.evidenceIds.length &&
      returned.every((id, index) => id === request.evidenceIds[index]),
    'Results must match requested evidence IDs and order',
    ['items'],
  );
  return response;
}

export function parseGetTestTraceResult(
  requestInput: unknown,
  responseInput: unknown,
) {
  const request = getTestTraceRequestSchema.parse(requestInput),
    response = getTestTraceResponseSchema.parse(responseInput);
  snapshot(request.snapshotId, response.meta);
  ensure(
    request.testId === response.test.id,
    'Trace test selection does not match request',
    ['test', 'id'],
  );
  applied(response.meta, 'steps', request.stepLimit, response.steps.length);
  applied(
    response.meta,
    'symbols',
    request.symbolLimit,
    response.symbols.length,
  );
  applied(
    response.meta,
    'relationships',
    request.relationLimit,
    response.links.length + response.relations.length,
  );
  return response;
}

export function parseGetDiagnosticsResult(
  requestInput: unknown,
  responseInput: unknown,
) {
  const request = getDiagnosticsRequestSchema.parse(requestInput),
    response = getDiagnosticsResponseSchema.parse(responseInput);
  pageChecks(
    request,
    response,
    'diagnostics',
    request.filters,
    response.items.map((diagnostic) => ({
      filePath: diagnostic.filePath ?? '',
      offset: diagnostic.range?.start.offset ?? 0,
      key: diagnostic.id,
    })),
  );
  return response;
}

export function parseGraphNeighborsResult(
  requestInput: unknown,
  responseInput: unknown,
) {
  const request = graphNeighborsRequestSchema.parse(requestInput),
    response = graphNeighborsResponseSchema.parse(responseInput);
  snapshot(request.snapshotId, response.meta);
  ensure(
    response.rootSymbolId === request.symbolId,
    'Graph root selection does not match request',
    ['rootSymbolId'],
  );
  const depth = applied(response.meta, 'depth', request.depth, 0);
  applied(response.meta, 'nodes', request.nodeLimit, response.symbols.length);
  const adjacency = new Map<string, string[]>();
  function connect(from: string, to: string): void {
    const neighbors = adjacency.get(from);
    if (neighbors) neighbors.push(to);
    else adjacency.set(from, [to]);
  }
  for (const relation of response.relations) {
    if (relation.resolution.status !== 'exact') continue;
    if (request.direction !== 'incoming')
      connect(relation.sourceSymbolId, relation.resolution.targetId);
    if (request.direction !== 'outgoing')
      connect(relation.resolution.targetId, relation.sourceSymbolId);
  }
  const distances = new Map([[request.symbolId, 0]]),
    queue = [request.symbolId];
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index]!;
    const distance = distances.get(current)!;
    if (distance >= depth) continue;
    for (const next of adjacency.get(current) ?? []) {
      if (!distances.has(next)) {
        distances.set(next, distance + 1);
        queue.push(next);
      }
    }
  }
  response.symbols.forEach((symbol, index) =>
    ensure(
      distances.has(symbol.id),
      'Returned symbol is not reachable in the requested direction/depth',
      ['symbols', index],
    ),
  );
  response.relations.forEach((relation, index) => {
    const sourceDepth = distances.get(relation.sourceSymbolId) ?? Infinity;
    const targetDepth =
      relation.resolution.status === 'exact'
        ? (distances.get(relation.resolution.targetId) ?? Infinity)
        : Infinity;
    const frontier =
      relation.resolution.status !== 'exact'
        ? request.direction !== 'incoming' && sourceDepth < depth
        : request.direction === 'outgoing'
          ? sourceDepth < depth
          : request.direction === 'incoming'
            ? targetDepth < depth
            : Math.min(sourceDepth, targetDepth) < depth;
    ensure(frontier, 'Relation is outside the traversable frontier', [
      'relations',
      index,
    ]);
  });
  return response;
}

export function parseFindSymbolPathsResult(
  requestInput: unknown,
  responseInput: unknown,
) {
  const request = findSymbolPathsRequestSchema.parse(requestInput),
    response = findSymbolPathsResponseSchema.parse(responseInput);
  snapshot(request.snapshotId, response.meta);
  ensure(
    request.fromSymbolId === response.fromSymbolId &&
      request.toSymbolId === response.toSymbolId,
    'Path root selection does not match request',
    ['fromSymbolId'],
  );
  const depth = applied(response.meta, 'depth', request.depth, 0);
  applied(response.meta, 'nodes', request.nodeLimit, response.symbols.length);
  applied(response.meta, 'paths', request.pathLimit, response.paths.length);
  const admittedSymbols = new Set([request.fromSymbolId, request.toSymbolId]),
    admittedRelations = new Set<string>();
  const pathSequences = new Set<string>();
  response.paths.forEach((path, index) => {
    const sequence = JSON.stringify([path.symbolIds, path.relationIds]);
    ensure(!pathSequences.has(sequence), 'Duplicate path sequence', [
      'paths',
      index,
    ]);
    pathSequences.add(sequence);
    ensure(
      path.relationIds.length <= depth,
      'Path depth exceeds requested/applied depth',
      ['paths', index],
    );
    for (const id of path.symbolIds) admittedSymbols.add(id);
    for (const id of path.relationIds) admittedRelations.add(id);
  });
  response.symbols.forEach((symbol, index) =>
    ensure(
      admittedSymbols.has(symbol.id),
      'Path graph contains an unrelated symbol',
      ['symbols', index],
    ),
  );
  response.relations.forEach((relation, index) =>
    ensure(
      admittedRelations.has(relation.id),
      'Path graph contains an unrelated relation',
      ['relations', index],
    ),
  );
  return response;
}
