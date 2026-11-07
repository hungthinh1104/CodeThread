import {
  graphNeighborsRequestSchema,
  graphNeighborsResponseSchema,
  findSymbolPathsRequestSchema,
  findSymbolPathsResponseSchema,
} from './graph-queries.js';
import { snapshot, ensure, applied } from './result-common.js';

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
  const selectedKinds = new Set(request.relationKinds);
  response.relations.forEach((relation, index) =>
    ensure(selectedKinds.has(relation.kind), 'Unselected relation kind', [
      'relations',
      index,
      'kind',
    ]),
  );
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
  const selectedKinds = new Set(request.relationKinds);
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
  response.relations.forEach((relation, index) => {
    ensure(
      admittedRelations.has(relation.id),
      'Path graph contains an unrelated relation',
      ['relations', index],
    );
    ensure(selectedKinds.has(relation.kind), 'Unselected relation kind', [
      'relations',
      index,
      'kind',
    ]);
  });
  return response;
}
