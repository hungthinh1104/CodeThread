import { idSchema } from '@codethread/code-model';
import type { SourceRange } from '@codethread/code-model';
export class TraceError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_FACTS'
      | 'SOURCE_UNAVAILABLE'
      | 'HASH_MISMATCH'
      | 'SNAPSHOT_NOT_FOUND'
      | 'ENTITY_NOT_FOUND'
      | 'RESOURCE_LIMIT',
    message: string,
  ) {
    super(message);
    this.name = 'TraceError';
  }
}
export function ensure(value: unknown): asserts value {
  if (!value) throw new TraceError('INVALID_FACTS', 'Invalid semantic facts');
}
export function unique(items: readonly { id: string; key?: string }[]): void {
  const ids = new Set<string>(),
    keys = new Set<string>();
  for (const item of items) {
    const id = idSchema.parse(item.id);
    ensure(id === item.id && !ids.has(id));
    ids.add(id);
    if (item.key !== undefined) {
      ensure(!keys.has(item.key));
      keys.add(item.key);
    }
  }
}
export function sameRange(a: SourceRange, b: SourceRange): boolean {
  return (['start', 'end'] as const).every((edge) =>
    (['offset', 'line', 'column'] as const).every(
      (coordinate) => a[edge][coordinate] === b[edge][coordinate],
    ),
  );
}
