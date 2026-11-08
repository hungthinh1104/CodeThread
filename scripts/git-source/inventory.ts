import { createHash } from 'node:crypto';
import { z } from 'zod';
import { filterKey } from '@codethread/contracts';
import { GitSourceError } from './types.ts';
import { openRepository } from './repository.ts';
import type { GitRepository } from './repository.ts';
import { createTreeStore } from './tree-store.ts';
import type { TreeEntry } from './tree.ts';
import { ORDER_BYTES, compareGitPaths } from './tree.ts';
import {
  supportedPath,
  queryInventory,
  lookupInventoryPath,
} from './inventory-query.ts';
import {
  selectInventorySources,
  createInventoryAcquirer,
} from './inventory-selection.ts';
import { GIT_INVENTORY_LIMITS } from './inventory-types.ts';
import type {
  GitInventoryLimits,
  GitSourceDiscoveryRequest,
  GitDiscoveryTruncationReason,
  UnsupportedGitPath,
  GitDiscoveredFile,
  InventoryContext,
  GitFileInventory,
  GitInventorySession,
} from './inventory-types.ts';

const limited = (maximum: number) =>
  z.number().int().min(1).max(maximum).default(maximum);
const limitsSchema = z.strictObject({
  files: limited(GIT_INVENTORY_LIMITS.files),
  trees: limited(GIT_INVENTORY_LIMITS.trees),
  treeVisits: limited(GIT_INVENTORY_LIMITS.treeVisits),
  treeEntries: limited(GIT_INVENTORY_LIMITS.treeEntries),
  pathComponents: limited(GIT_INVENTORY_LIMITS.pathComponents),
  objectBytes: limited(GIT_INVENTORY_LIMITS.objectBytes),
  metadataBytes: limited(GIT_INVENTORY_LIMITS.metadataBytes),
  deadlineMs: limited(GIT_INVENTORY_LIMITS.deadlineMs),
});
const reasonOrder: readonly GitDiscoveryTruncationReason[] = [
  'file_limit',
  'tree_limit',
  'tree_visit_limit',
  'entry_limit',
  'path_limit',
  'unsupported_paths',
];
const MAX_UNSUPPORTED_REPORTS = 100;
const TREE_BATCH_SIZE = 32;
interface PendingTree {
  path: string;
  oid: string;
  depth: number;
}
interface InventoryBuild {
  files: Map<string, { file: GitDiscoveredFile; oid: string }>;
  blockedPaths: Set<string>;
  unsupported: UnsupportedGitPath[];
  reasons: Set<GitDiscoveryTruncationReason>;
  unsupportedCount: number;
  nonregularCount: number;
  treeVisits: number;
  stopped: boolean;
}

function reportUnsupported(
  build: InventoryBuild,
  current: PendingTree,
  entry: TreeEntry,
  reason: UnsupportedGitPath['reason'],
): void {
  build.unsupportedCount++;
  build.reasons.add(
    reason === 'path_limit' ? 'path_limit' : 'unsupported_paths',
  );
  if (build.unsupported.length < MAX_UNSUPPORTED_REPORTS)
    build.unsupported.push({
      directory: current.path,
      nameBytesHex: entry.name.subarray(0, 64).toString('hex'),
      nameBytesTruncated: entry.name.length > 64,
      reason,
    });
}

function admitTreeEntries(
  build: InventoryBuild,
  current: PendingTree,
  entries: readonly TreeEntry[],
  pending: PendingTree[],
  limits: GitInventoryLimits,
): void {
  for (const entry of [...entries].sort((a, b) =>
    ORDER_BYTES(a.name, b.name),
  )) {
    const directory = entry.mode === '40000' || entry.mode === '040000';
    let name: string;
    try {
      name = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        entry.name,
      );
    } catch {
      reportUnsupported(build, current, entry, 'invalid_utf8');
      continue;
    }
    const path = current.path ? current.path + '/' + name : name;
    if (!supportedPath(path)) {
      reportUnsupported(build, current, entry, 'unsupported_path');
      continue;
    }
    if (
      current.depth + 1 > limits.pathComponents ||
      (directory && current.depth + 1 === limits.pathComponents)
    ) {
      reportUnsupported(build, current, entry, 'path_limit');
      continue;
    }
    if (directory) {
      if (pending.length >= limits.treeVisits)
        build.reasons.add('tree_visit_limit');
      else pending.push({ path, oid: entry.oid, depth: current.depth + 1 });
      continue;
    }
    if (entry.mode === '120000' || entry.mode === '160000') {
      build.nonregularCount++;
      build.blockedPaths.add(path);
    }
    if (!path.endsWith('.ts')) continue;
    if (build.files.size >= limits.files) {
      build.reasons.add('file_limit');
      build.stopped = true;
      return;
    }
    if (build.files.has(path))
      throw new GitSourceError(
        'CORRUPT_OBJECT',
        'A Git tree produced duplicate source paths.',
      );
    build.files.set(path, {
      file: Object.freeze({ path, mode: entry.mode }),
      oid: entry.oid,
    });
  }
}

async function buildInventory(
  repository: GitRepository,
  limits: Readonly<GitInventoryLimits>,
) {
  const trees = createTreeStore(
    repository.reader,
    repository.objectFormat,
    limits,
    [],
    true,
  );
  const build: InventoryBuild = {
    files: new Map(),
    blockedPaths: new Set(),
    unsupported: [],
    reasons: new Set(),
    unsupportedCount: 0,
    nonregularCount: 0,
    treeVisits: 0,
    stopped: false,
  };
  const pending: PendingTree[] = [
    { path: '', oid: repository.rootTreeId, depth: 0 },
  ];
  let offset = 0;
  while (offset < pending.length && !build.stopped) {
    repository.reader.checkpoint();
    const candidates = pending.slice(offset, offset + TREE_BATCH_SIZE);
    const admitted: PendingTree[] = [],
      missing = new Set<string>();
    let treeLimitReached = false;
    for (const current of candidates) {
      if (!trees.has(current.oid) && !missing.has(current.oid)) {
        if (trees.size() + missing.size >= limits.trees) {
          build.reasons.add('tree_limit');
          treeLimitReached = true;
          break;
        }
        missing.add(current.oid);
      }
      admitted.push(current);
    }
    await trees.load([...missing]);
    for (const current of admitted) {
      repository.reader.checkpoint();
      build.treeVisits++;
      admitTreeEntries(
        build,
        current,
        trees.get(current.oid)!,
        pending,
        limits,
      );
      if (trees.entryLimitReached(current.oid)) {
        build.reasons.add('entry_limit');
        build.stopped = true;
      }
      if (build.stopped) break;
    }
    offset += admitted.length;
    build.stopped ||= treeLimitReached;
  }
  return { build, trees };
}

export async function openGitInventory(
  request: GitSourceDiscoveryRequest,
): Promise<GitInventorySession> {
  if (request.signal?.aborted)
    throw new GitSourceError('CANCELLED', 'Git source discovery cancelled.');
  const parsed = limitsSchema.safeParse(request.limits ?? {});
  if (!parsed.success)
    throw new GitSourceError(
      'INVALID_DISCOVERY_REQUEST',
      'Inventory limits must lower the declared bounds.',
    );
  const limits = Object.freeze({ ...GIT_INVENTORY_LIMITS, ...parsed.data });
  const repository = await openRepository(request, [], limits);
  const { build, trees } = await buildInventory(repository, limits);
  const files = Object.freeze(
    [...build.files.values()]
      .map((entry) => entry.file)
      .sort((a, b) => compareGitPaths(a.path, b.path)),
  );
  const truncationReasons = Object.freeze(
    reasonOrder.filter((reason) => build.reasons.has(reason)),
  );
  const descriptor = {
    version: 1,
    repositoryId: repository.repositoryId,
    commitId: repository.commitId,
    rootTreeId: repository.rootTreeId,
    objectFormat: repository.objectFormat,
    files,
    limits,
    truncationReasons,
  };
  const inventory: GitFileInventory = Object.freeze({
    inventoryId: createHash('sha256')
      .update(filterKey(descriptor))
      .digest('hex'),
    repositoryId: repository.repositoryId,
    commitId: repository.commitId,
    rootTreeId: repository.rootTreeId,
    objectFormat: repository.objectFormat,
    files,
    unsupportedPaths: Object.freeze(
      build.unsupported.map((item) => Object.freeze(item)),
    ),
    counts: Object.freeze({
      files: files.length,
      uniqueTrees: trees.size(),
      treeVisits: build.treeVisits,
      treeEntries: trees.entryCount(),
      unsupportedPaths: build.unsupportedCount,
      unsupportedReportsTruncated:
        build.unsupportedCount > build.unsupported.length,
      nonregularEntries: build.nonregularCount,
    }),
    truncated: truncationReasons.length > 0,
    truncationReasons,
    appliedLimits: limits,
  });
  const context: InventoryContext = {
    inventory,
    repository,
    files: build.files,
    blockedPaths: build.blockedPaths,
  };
  return Object.freeze({
    inventory,
    statistics: repository.statistics,
    query: (input?: unknown) => queryInventory(context, input),
    lookup: (path: unknown) => lookupInventoryPath(context, path),
    select: (input: unknown) => selectInventorySources(context, input),
    acquire: createInventoryAcquirer(context),
  });
}

export async function discoverGitFiles(
  request: GitSourceDiscoveryRequest,
): Promise<GitFileInventory> {
  return (await openGitInventory(request)).inventory;
}
