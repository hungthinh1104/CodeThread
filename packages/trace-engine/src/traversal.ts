import {
  findSymbolPathsRequestSchema,
  graphNeighborsRequestSchema,
  parseFindSymbolPathsResult,
  parseGraphNeighborsResult,
} from '@codethread/contracts';
import { TraceError } from './fact-integrity.js';
import type { InvestigationContext } from './context.js';
import { createMetadata, createProjection } from './projection.js';
import type { TruncationReason } from './projection.js';

export function neighbors(
  context: InvestigationContext,
  requestInput: unknown,
) {
  const { scope, requiredSymbol, adjacent } = context;
  const request = graphNeighborsRequestSchema.parse(requestInput);
  scope(request.snapshotId);
  requiredSymbol(request.symbolId);
  const graph = createProjection(context, request.nodeLimit),
    reasons = new Set<TruncationReason>();
  if (!graph.include([request.symbolId], []))
    throw new TraceError(
      'RESOURCE_LIMIT',
      'Root evidence exceeds the graph budget',
    );
  const distances = new Map([[request.symbolId, 0]]),
    queue = [request.symbolId],
    relationKinds = new Set(request.relationKinds);
  let examined = 0,
    stop = false;
  for (let index = 0; index < queue.length && !stop; index++) {
    const current = queue[index]!,
      depth = distances.get(current)!;
    for (const relation of adjacent(
      current,
      request.direction,
      relationKinds,
    )) {
      if (++examined > 10000) {
        reasons.add('search_budget');
        stop = true;
        break;
      }
      if (graph.selectedRelations.has(relation.id)) continue;
      if (depth >= request.depth) {
        reasons.add('depth_limit');
        continue;
      }
      const other =
        relation.resolution.status === 'exact'
          ? relation.sourceSymbolId === current
            ? relation.resolution.targetId
            : relation.sourceSymbolId
          : null;
      if (!graph.include(other ? [other] : [], [relation.id])) {
        reasons.add('result_limit');
        continue;
      }
      if (other && !distances.has(other)) {
        distances.set(other, depth + 1);
        queue.push(other);
      }
    }
  }
  return parseGraphNeighborsResult(request, {
    meta: createMetadata(
      context,
      {
        depth: request.depth,
        nodes: request.nodeLimit,
        relationships: 1000,
        evidence: 5000,
        diagnostics: 200,
        expansions: 10000,
      },
      reasons,
    ),
    rootSymbolId: request.symbolId,
    ...graph.result(),
  });
}
export function paths(context: InvestigationContext, requestInput: unknown) {
  const { scope, requiredSymbol, outgoing } = context;
  const request = findSymbolPathsRequestSchema.parse(requestInput);
  scope(request.snapshotId);
  requiredSymbol(request.fromSymbolId);
  requiredSymbol(request.toSymbolId);
  const graph = createProjection(context, request.nodeLimit),
    reasons = new Set<TruncationReason>();
  const rootIds = [...new Set([request.fromSymbolId, request.toSymbolId])];
  if (!graph.include(rootIds, []))
    throw new TraceError(
      'RESOURCE_LIMIT',
      'Path roots exceed the graph budget',
    );
  type Path = { symbolIds: string[]; relationIds: string[] };
  const returned: Path[] = [];
  const visited = new Set(rootIds);
  const relationKinds = new Set(request.relationKinds);
  const queue: Path[] = [
    { symbolIds: [request.fromSymbolId], relationIds: [] },
  ];
  let examined = 0,
    stop = false;
  if (request.fromSymbolId === request.toSymbolId) returned.push(queue[0]!);
  else
    for (let index = 0; index < queue.length && !stop; index++) {
      const path = queue[index]!,
        current = path.symbolIds.at(-1)!;
      for (const relation of outgoing.get(current) ?? []) {
        if (!relationKinds.has(relation.kind)) continue;
        if (++examined > 10000) {
          reasons.add('search_budget');
          stop = true;
          break;
        }
        if (
          relation.resolution.status !== 'exact' ||
          path.symbolIds.includes(relation.resolution.targetId)
        )
          continue;
        if (path.relationIds.length >= request.depth) {
          reasons.add('depth_limit');
          continue;
        }
        const target = relation.resolution.targetId;
        if (!visited.has(target) && visited.size >= request.nodeLimit) {
          reasons.add('result_limit');
          continue;
        }
        visited.add(target);
        const next = {
          symbolIds: [...path.symbolIds, target],
          relationIds: [...path.relationIds, relation.id],
        };
        if (target === request.toSymbolId) {
          if (returned.length >= request.pathLimit) {
            reasons.add('result_limit');
            stop = true;
            break;
          }
          if (!graph.include(next.symbolIds, next.relationIds)) {
            reasons.add('result_limit');
            continue;
          }
          returned.push(next);
        } else queue.push(next);
      }
    }
  return parseFindSymbolPathsResult(request, {
    meta: createMetadata(
      context,
      {
        depth: request.depth,
        nodes: request.nodeLimit,
        paths: request.pathLimit,
        relationships: 1000,
        evidence: 5000,
        diagnostics: 200,
        expansions: 10000,
      },
      reasons,
    ),
    fromSymbolId: request.fromSymbolId,
    toSymbolId: request.toSymbolId,
    ...graph.result(),
    paths: returned,
  });
}
