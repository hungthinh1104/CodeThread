import { createHash } from 'node:crypto';
import { ANALYSIS_LIMITS, COMPILER_PROFILE } from '@codethread/symbol-indexer';
import type { AnalysisInput } from '@codethread/symbol-indexer';
import { openRepository } from './repository.ts';
import type { GitRepository } from './repository.ts';
import type { GitObjectReader } from './objects.ts';
import { createTreeStore } from './tree-store.ts';
import {
  failure,
  gitFailure,
  validateSelection,
  withRejected,
} from './selection.ts';
import {
  MAX_VISITED_TREES,
  MAX_TREE_ENTRIES,
  MAX_OBJECT_BYTES,
} from './types.ts';
import type {
  AcquiredGitSources,
  GitSourceProvenance,
  GitSourceRequest,
  GitSelectionStatus,
} from './types.ts';

export interface SelectedGitFile {
  path: string;
  oid: string;
  mode: '100644' | '100755';
}

async function resolveSelectedFiles(
  repository: GitRepository,
  paths: readonly string[],
  selection: readonly GitSelectionStatus[],
): Promise<SelectedGitFile[]> {
  const reader = repository.reader;
  const trees = createTreeStore(
    reader,
    repository.objectFormat,
    {
      trees: MAX_VISITED_TREES,
      treeEntries: MAX_TREE_ENTRIES,
      objectBytes: MAX_OBJECT_BYTES,
    },
    selection,
  );
  let pending = paths.map((path, index) => ({
    path,
    index,
    components: path.split('/'),
    depth: 0,
    treeOid: repository.rootTreeId,
  }));
  const files: SelectedGitFile[] = [];
  while (pending.length > 0) {
    reader.checkpoint();
    await trees.load(pending.map((item) => item.treeOid));
    const next: typeof pending = [];
    for (const item of pending) {
      const component = Buffer.from(item.components[item.depth]!, 'utf8');
      const matching = trees
        .get(item.treeOid)!
        .find((entry) => entry.name.equals(component));
      if (!matching)
        throw failure(
          'FILE_NOT_FOUND',
          'A selected source path is absent from the pinned commit.',
          withRejected(selection, item.index),
        );
      if (item.depth < item.components.length - 1) {
        if (matching.mode !== '40000' && matching.mode !== '040000')
          throw failure(
            'INVALID_SELECTION',
            'A selected path component is not a directory.',
            withRejected(selection, item.index),
          );
        next.push({ ...item, depth: item.depth + 1, treeOid: matching.oid });
      } else {
        const mode = matching.mode;
        if (mode !== '100644' && mode !== '100755')
          throw failure(
            'UNSUPPORTED_FILE_MODE',
            'Selected source is not a regular Git blob.',
            withRejected(selection, item.index),
          );
        files.push({ path: item.path, mode, oid: matching.oid });
      }
    }
    pending = next;
  }
  return files;
}

export async function acquireVerifiedFiles(
  repository: GitRepository,
  files: readonly SelectedGitFile[],
  selection: readonly GitSelectionStatus[],
  reader: GitObjectReader,
): Promise<AcquiredGitSources> {
  const ordered = [...files].sort((a, b) =>
    Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
  );
  const indexes = ordered.map((file) =>
    selection.findIndex((item) => item.path === file.path),
  );
  const blobs = await reader.readObjects(
    ordered.map((file) => file.oid),
    'blob',
    ANALYSIS_LIMITS.maxFileBytes,
    indexes,
  );
  const admitted: AnalysisInput['files'][number][] = [];
  const provenance: GitSourceProvenance['files'][number][] = [];
  for (const file of ordered) {
    const bytes = Uint8Array.from(blobs.get(file.oid)!.bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    admitted.push({ path: file.path, bytes, sha256 });
    provenance.push({
      path: file.path,
      blobId: file.oid,
      mode: file.mode,
      sha256,
    });
  }
  reader.checkpoint();
  return {
    input: {
      repositoryId: repository.repositoryId,
      compilerOptions: COMPILER_PROFILE,
      files: admitted,
    },
    provenance: {
      commitId: repository.commitId,
      objectFormat: repository.objectFormat,
      files: provenance,
    },
    selection: ordered.map((file) => ({ path: file.path, status: 'admitted' })),
  };
}

export async function acquireGitSources(
  request: GitSourceRequest,
): Promise<AcquiredGitSources> {
  const paths = [...request.selectedPaths];
  const selection = validateSelection(paths);
  try {
    const repository = await openRepository(request, selection);
    const files = await resolveSelectedFiles(repository, paths, selection);
    return await acquireVerifiedFiles(
      repository,
      files,
      selection,
      repository.reader,
    );
  } catch (error) {
    gitFailure(error, selection);
  }
}
