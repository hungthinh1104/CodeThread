import { analysisResourceLimits } from '@codethread/code-model';
import { PROJECT_LIMITS } from '@codethread/symbol-indexer';
import { openRepository } from './repository.ts';
import { createTreeStore } from './tree-store.ts';
import { compareGitPaths } from './tree.ts';
import { supportedPath } from './inventory-query.ts';
import { GitSourceError } from './types.ts';
import type { GitSourceRequest } from './types.ts';
import {
  acquireRepositoryMetadata,
  materializePinnedInput,
} from './repository-metadata.ts';
import type { PinnedEntry } from './repository-metadata.ts';

const MAX_TREES = 8192;
const MAX_TREE_ENTRIES = 100000;
const MAX_TREE_VISITS = 16384;
const MAX_PATH_COMPONENTS = 64;

export async function acquireGitRepository(
  request: Omit<GitSourceRequest, 'selectedPaths'>,
) {
  const started = performance.now(),
    limits = analysisResourceLimits('repository');
  const repository = await openRepository(request, [], {
    deadlineMs: limits.maxDeadlineMs,
    metadataBytes: 16 * 1024 * 1024,
    objectBytes: 1024 * 1024,
    blobBytes: limits.maxTotalBytes + PROJECT_LIMITS.maxMetadataBytes,
  });
  const trees = createTreeStore(repository.reader, repository.objectFormat, {
    trees: MAX_TREES,
    treeEntries: MAX_TREE_ENTRIES,
    objectBytes: 1024 * 1024,
  });
  const pending = [{ path: '', oid: repository.rootTreeId, depth: 0 }];
  const entries = new Map<string, PinnedEntry>();
  const sources: PinnedEntry[] = [],
    excluded: { path: string; reason: 'symlink' | 'gitlink' }[] = [];
  const folded = new Set<string>();
  let visitedEntries = 0;
  for (let offset = 0; offset < pending.length;) {
    repository.reader.checkpoint();
    const batch = pending.slice(offset, offset + 32);
    await trees.load(batch.map((entry) => entry.oid));
    offset += batch.length;
    for (const current of batch)
      for (const entry of trees.get(current.oid)!) {
        if (++visitedEntries > MAX_TREE_ENTRIES)
          throw new GitSourceError(
            'RESOURCE_LIMIT',
            'Repository inventory exceeds its path-entry limit.',
          );
        let name: string;
        try {
          name = new TextDecoder('utf-8', {
            fatal: true,
            ignoreBOM: true,
          }).decode(entry.name);
        } catch {
          throw new GitSourceError(
            'SOURCE_INVENTORY_INCOMPLETE',
            'A committed path has invalid UTF-8.',
          );
        }
        const path = current.path ? current.path + '/' + name : name;
        if (!supportedPath(path) || current.depth + 1 > MAX_PATH_COMPONENTS)
          throw new GitSourceError(
            'SOURCE_INVENTORY_INCOMPLETE',
            'A committed path is outside the supported inventory boundary.',
          );
        if (entry.mode === '40000' || entry.mode === '040000') {
          if (pending.length >= MAX_TREE_VISITS)
            throw new GitSourceError(
              'RESOURCE_LIMIT',
              'Repository inventory exceeds its tree-visit limit.',
            );
          pending.push({ path, oid: entry.oid, depth: current.depth + 1 });
        } else if (entry.mode === '120000' || entry.mode === '160000') {
          if (excluded.length >= limits.maxFiles)
            throw new GitSourceError(
              'RESOURCE_LIMIT',
              'Too many excluded nonregular entries.',
            );
          excluded.push({
            path,
            reason: entry.mode === '120000' ? 'symlink' : 'gitlink',
          });
        } else {
          if (
            entries.has(path) ||
            (path.endsWith('.ts') && folded.has(path.toLowerCase()))
          )
            throw new GitSourceError(
              'INVALID_SELECTION',
              'Repository paths collide by case or identity.',
            );
          if (path.endsWith('.ts')) folded.add(path.toLowerCase());
          const item = { path, oid: entry.oid, mode: entry.mode };
          entries.set(path, item);
          if (path.endsWith('.ts')) {
            if (sources.length >= limits.maxFiles)
              throw new GitSourceError(
                'RESOURCE_LIMIT',
                'Whole-repository selection exceeds 1000 TypeScript files.',
              );
            sources.push(item);
          }
        }
      }
  }
  if (!sources.length)
    throw new GitSourceError(
      'INVALID_SELECTION',
      'The pinned repository has no regular .ts source.',
    );
  const metadata = await acquireRepositoryMetadata(entries, repository.reader);
  sources.sort((a, b) => compareGitPaths(a.path, b.path));
  const blobs = await repository.reader.readObjects(
    sources.map((entry) => entry.oid),
    'blob',
    limits.maxFileBytes,
  );
  const sourceBytes = sources.reduce(
    (count, entry) => count + blobs.get(entry.oid)!.size,
    0,
  );
  if (sourceBytes > limits.maxTotalBytes)
    throw new GitSourceError(
      'RESOURCE_LIMIT',
      'Whole-repository source exceeds 32 MiB.',
    );
  const files = Object.freeze(
    sources.map((entry) =>
      materializePinnedInput(entry, blobs.get(entry.oid)!.bytes),
    ),
  );
  repository.reader.checkpoint();
  return Object.freeze({
    repositoryId: repository.repositoryId,
    commitId: repository.commitId,
    rootTreeId: repository.rootTreeId,
    objectFormat: repository.objectFormat,
    files,
    metadata,
    inventory: Object.freeze({
      complete: true as const,
      sourceFiles: files.length,
      sourceBytes,
      metadataFiles: metadata.length,
      excluded: Object.freeze(
        excluded.sort((a, b) => compareGitPaths(a.path, b.path)),
      ),
    }),
    statistics: repository.statistics(),
    durationMs: performance.now() - started,
  });
}

export type AcquiredGitRepository = Awaited<
  ReturnType<typeof acquireGitRepository>
>;
