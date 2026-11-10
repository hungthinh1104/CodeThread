import { posix } from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { isSnapshotPath } from '@codethread/code-model';
import { PROJECT_LIMITS } from '@codethread/symbol-indexer';
import type { ProjectEnvironment } from '@codethread/symbol-indexer';
import type { GitObjectReader } from './objects.ts';
import { GitSourceError } from './types.ts';
import { compareGitPaths } from './tree.ts';

export interface PinnedEntry {
  path: string;
  oid: string;
  mode: '100644' | '100755';
}
export type PinnedInput = ProjectEnvironment['files'][number] & {
  blobId: string;
  mode: '100644' | '100755';
};

const MAX_CONFIG_RELATIONS = 32;
const MAX_CONFIG_PATH_LENGTH = 1024;

export function materializePinnedInput(
  entry: PinnedEntry,
  bytes: Uint8Array,
): PinnedInput {
  return {
    path: entry.path,
    bytes: Uint8Array.from(bytes),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    blobId: entry.oid,
    mode: entry.mode,
  };
}

function relatedConfigurations(
  entry: PinnedEntry,
  bytes: Uint8Array,
  entries: ReadonlyMap<string, PinnedEntry>,
): string[] {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new GitSourceError(
      'INVALID_SELECTION',
      'Pinned metadata is not valid UTF-8.',
    );
  }
  const raw = ts.parseConfigFileTextToJson(entry.path, text).config as
    Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object') return [];
  const related: string[] = [];
  const extensions =
    typeof raw.extends === 'string'
      ? [raw.extends]
      : Array.isArray(raw.extends)
        ? raw.extends
        : [];
  const references = Array.isArray(raw.references) ? raw.references : [];
  if (
    extensions.length > MAX_CONFIG_RELATIONS ||
    references.length > MAX_CONFIG_RELATIONS
  )
    return [];
  for (const value of extensions)
    if (
      typeof value === 'string' &&
      value.length <= MAX_CONFIG_PATH_LENGTH &&
      /^\.\.?\//.test(value)
    ) {
      const path = posix.normalize(
        posix.join(posix.dirname(entry.path), value),
      );
      const candidate = entries.has(path) ? path : path + '.json';
      if (isSnapshotPath(candidate) && entries.has(candidate))
        related.push(candidate);
    }
  if (Array.isArray(raw.references))
    for (const reference of raw.references) {
      const value = (reference as { path?: unknown })?.path;
      if (typeof value !== 'string' || value.length > MAX_CONFIG_PATH_LENGTH)
        continue;
      const path = posix.normalize(
        posix.join(posix.dirname(entry.path), value),
      );
      const candidate = path.endsWith('.json') ? path : path + '/tsconfig.json';
      if (isSnapshotPath(candidate) && entries.has(candidate))
        related.push(candidate);
    }
  return related;
}

/** Acquire only compiler/workspace metadata and its pinned relative configuration closure. */
export async function acquireRepositoryMetadata(
  entries: ReadonlyMap<string, PinnedEntry>,
  reader: GitObjectReader,
): Promise<readonly PinnedInput[]> {
  const requested = new Set(
    [...entries.keys()].filter((path) =>
      /(?:^|\/)(?:tsconfig(?:\.[^/]*)?\.json|package\.json|pnpm-workspace\.yaml)$/.test(
        path,
      ),
    ),
  );
  const collected = new Map<string, PinnedInput>();
  let totalBytes = 0;
  while (collected.size < requested.size) {
    if (requested.size > PROJECT_LIMITS.maxMetadataFiles)
      throw new GitSourceError(
        'RESOURCE_LIMIT',
        'Repository compiler metadata exceeds its file limit.',
      );
    const pending = [...requested]
      .filter((path) => !collected.has(path))
      .sort(compareGitPaths);
    const batch = await reader.readObjects(
      pending.map((path) => entries.get(path)!.oid),
      'blob',
      1024 * 1024,
    );
    for (const path of pending) {
      const entry = entries.get(path)!,
        bytes = batch.get(entry.oid)!.bytes;
      totalBytes += bytes.length;
      if (totalBytes > PROJECT_LIMITS.maxMetadataBytes)
        throw new GitSourceError(
          'RESOURCE_LIMIT',
          'Repository compiler metadata exceeds its byte limit.',
        );
      collected.set(path, materializePinnedInput(entry, bytes));
      if (path.endsWith('.json') && posix.basename(path) !== 'package.json')
        for (const related of relatedConfigurations(entry, bytes, entries))
          requested.add(related);
    }
  }
  return Object.freeze(
    [...collected.values()].sort((a, b) => compareGitPaths(a.path, b.path)),
  );
}
