import { z } from 'zod';
import type { CursorPayload, PageRequest, QueryMeta } from './query-common.js';
import { decodeCursor, filterKey } from './query-common.js';

export function ensure(
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

export function snapshot(requestId: string, meta: QueryMeta): void {
  ensure(
    meta.snapshotId === requestId,
    'Response snapshot does not match request',
    ['meta', 'snapshotId'],
  );
}

export function applied(
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

export function pageChecks(
  request: PageRequest,
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
