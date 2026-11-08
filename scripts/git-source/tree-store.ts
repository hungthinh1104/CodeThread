import { parseTree } from './tree.ts';
import type { TreeEntry } from './tree.ts';
import type { GitObjectReader } from './objects.ts';
import { failure } from './selection.ts';
import type { GitSelectionStatus } from './types.ts';

export function createTreeStore(
  reader: GitObjectReader,
  objectFormat: 'sha1' | 'sha256',
  limits: { trees: number; treeEntries: number; objectBytes: number },
  selection: readonly GitSelectionStatus[] = [],
  allowEntryTruncation = false,
) {
  const cache = new Map<string, readonly TreeEntry[]>();
  const entryTruncations = new Set<string>();
  let entryCount = 0;
  return {
    has: (oid: string) => cache.has(oid),
    size: () => cache.size,
    entryCount: () => entryCount,
    entryLimitReached: (oid: string) => entryTruncations.has(oid),
    get: (oid: string) => cache.get(oid),
    async load(oids: readonly string[]): Promise<void> {
      reader.checkpoint();
      const missing = [...new Set(oids)].filter((oid) => !cache.has(oid));
      if (cache.size + missing.length > limits.trees)
        throw failure(
          'RESOURCE_LIMIT',
          'Selected paths visit too many Git trees.',
          selection,
        );
      const objects = await reader.readObjects(
        missing,
        'tree',
        limits.objectBytes,
      );
      for (const [oid, object] of objects) {
        const parsed = parseTree(
          object.bytes,
          objectFormat === 'sha1' ? 20 : 32,
          limits.treeEntries - entryCount,
          allowEntryTruncation,
        );
        entryCount += parsed.entries.length;
        if (parsed.truncated) entryTruncations.add(oid);
        cache.set(oid, parsed.entries);
      }
    },
  };
}

export type GitTreeStore = ReturnType<typeof createTreeStore>;
