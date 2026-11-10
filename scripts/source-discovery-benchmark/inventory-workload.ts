import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { analyzeManifest } from '@codethread/symbol-indexer';
import { GitSourceError } from '../git-source/types.ts';
import { openGitInventory } from '../git-source/inventory.ts';
import type { GitInventorySession } from '../git-source/inventory-types.ts';
import { createRepository } from './repository.ts';
import {
  queryRepeats,
  repeats,
  repositoryId,
  type BenchmarkResult,
  type BenchmarkShape,
  type StageMeasurement,
} from './config.ts';
import { assertInventoryIdentityStable } from './verification.ts';
import { measure, median, pageAll } from './timing.ts';

export async function prepareInventory(
  base: string,
  shape: BenchmarkShape,
  entries: number,
) {
  process.stderr.write(`Benchmark start: ${shape}/${entries} tree entries.\n`);
  const repository = await createRepository(base, shape, entries);
  const openTimes: number[] = [];
  const inventoryIdentitySamples: string[] = [];
  let session: GitInventorySession | undefined;
  const openStage = await measure(1, async () => {
    const started = performance.now();
    session = await openGitInventory({
      repositoryPath: repository.root,
      repositoryId,
      revision: 'HEAD',
    });
    inventoryIdentitySamples.push(session.inventory.inventoryId);
    openTimes.push(Number((performance.now() - started).toFixed(3)));
  });
  if (!session) throw new Error('Inventory did not open.');
  const identityStableAcrossSamples = assertInventoryIdentityStable(
    inventoryIdentitySamples,
  );
  process.stderr.write(`Benchmark inventory opened: ${shape}/${entries}.\n`);
  const inventory = session.inventory;
  const statsBeforeSources = session.statistics();
  if (statsBeforeSources.blobReads !== 0)
    throw new Error('Inventory browsing read source blobs.');
  if (inventory.commitId !== repository.commit)
    throw new Error('Inventory was not bound to the expected commit.');
  const verifiedLookupPaths = inventory.files.map((file) => file.path);
  if (verifiedLookupPaths.length === 0)
    throw new Error(
      'The generated inventory contains no verified source paths.',
    );
  const verifiedPathSet = new Set(verifiedLookupPaths);
  const omittedPath = repository.paths.find(
    (path) => !verifiedPathSet.has(path),
  );
  let omittedPathLookup: BenchmarkResult['inventory']['omittedPathLookup'] =
    'not_applicable';
  if (omittedPath) {
    if (
      !inventory.truncated ||
      session.lookup(omittedPath).status !== 'not_verified'
    )
      throw new Error(
        'A path omitted by partial inventory was not marked unverified.',
      );
    omittedPathLookup = 'not_verified';
  } else if (inventory.truncated) {
    throw new Error('A truncated synthetic inventory omitted no source path.');
  }
  const pagePaths = await pageAll(session);
  if (pagePaths.length !== inventory.files.length)
    throw new Error('Pagination omitted a known inventory path.');
  const prefix = repository.paths[0]!.split('/')[0]!;
  const directoryQuery = session.query({ prefix, limit: 200 });
  const firstPaths = verifiedLookupPaths.slice(0, 20);
  const plan = session.select({ paths: firstPaths });
  if (plan.selection.length !== 20)
    throw new Error(
      'The synthetic exact-file selection did not contain 20 files.',
    );
  const selection = inspectDirectorySelection(
    session,
    shape,
    inventory,
    prefix,
  );
  return {
    shape,
    entries,
    repository,
    session,
    inventory,
    openStage,
    openTimes,
    identityStableAcrossSamples,
    statsBeforeSources,
    verifiedLookupPaths,
    omittedPathLookup,
    pagePaths,
    prefix,
    directoryQuery,
    firstPaths,
    plan,
    ...selection,
  };
}

function inspectDirectorySelection(
  session: GitInventorySession,
  shape: BenchmarkShape,
  inventory: GitInventorySession['inventory'],
  prefix: string,
) {
  let directoryCount: number | null = null;
  let oversizedDirectoryRejected = false;
  if (shape === 'wide' && !inventory.truncated) {
    directoryCount = session.select({ directories: ['module-000'] }).selection
      .length;
  } else {
    try {
      session.select({
        directories: [shape === 'wide' ? 'module-000' : prefix],
      });
    } catch (error) {
      oversizedDirectoryRejected =
        error instanceof GitSourceError &&
        error.code ===
          (inventory.truncated ? 'INCOMPLETE_INVENTORY' : 'RESOURCE_LIMIT');
    }
    if (!oversizedDirectoryRejected)
      throw new Error('An unsafe directory selection did not fail explicitly.');
  }
  return { directoryCount, oversizedDirectoryRejected };
}

export async function measureBrowseOperations(
  context: Awaited<ReturnType<typeof prepareInventory>>,
): Promise<Record<string, StageMeasurement>> {
  const {
    directoryCount,
    firstPaths,
    inventory,
    openStage,
    openTimes,
    prefix,
    session,
    statsBeforeSources,
    verifiedLookupPaths,
  } = context;
  const stages: Record<string, StageMeasurement> = {
    repositoryOpenAndTreeTraversal: {
      ...openStage,
      samplesMs: openTimes,
      medianMs: median(openTimes),
      meanMsPerOperation: Number(
        (openTimes.reduce((sum, value) => sum + value, 0) / repeats).toFixed(6),
      ),
    },
    literalSearch: await measure(queryRepeats, async () => {
      for (let index = 0; index < queryRepeats; index++) {
        const result = session.query({ text: 'item-000', limit: 50 });
        if (
          result.items.length > 50 ||
          result.knownMatches < result.items.length
        )
          throw new Error('Search exceeded its bounds.');
        await new Promise<void>((next) => setImmediate(next));
      }
    }),
    directoryPrefixFilter: await measure(queryRepeats, async () => {
      for (let index = 0; index < queryRepeats; index++) {
        const result = session.query({ prefix, limit: 200 });
        if (result.items.some((file) => !file.path.startsWith(prefix + '/')))
          throw new Error('Directory filtering crossed a path boundary.');
        await new Promise<void>((next) => setImmediate(next));
      }
    }),
    cursorPagination: await measure(1, async () => {
      const paths = await pageAll(session);
      if (paths.length !== inventory.files.length)
        throw new Error(
          'Cursor paging did not reach the end of verified results.',
        );
    }),
    exactLookup: await measure(queryRepeats, async () => {
      for (let index = 0; index < queryRepeats; index++) {
        if (
          session.lookup(
            verifiedLookupPaths[index % verifiedLookupPaths.length]!,
          ).status !== 'found'
        )
          throw new Error('A verified inventory path could not be looked up.');
        await new Promise<void>((next) => setImmediate(next));
      }
    }),
    exactSelectionValidation: await measure(queryRepeats, async () => {
      for (let index = 0; index < queryRepeats; index++) {
        if (session.select({ paths: firstPaths }).selection.length !== 20)
          throw new Error('Exact selection was not admitted atomically.');
        await new Promise<void>((next) => setImmediate(next));
      }
    }),
    directorySelectionValidation: await measure(queryRepeats, async () => {
      await measureDirectorySelection(context);
    }),
  };
  if (directoryCount !== null && directoryCount !== 15)
    throw new Error(
      'The supported directory selection changed its membership.',
    );
  if (
    JSON.stringify(session.statistics()) !== JSON.stringify(statsBeforeSources)
  )
    throw new Error(
      'Browse queries or selection performed additional Git reads.',
    );
  return stages;
}

async function measureDirectorySelection(
  context: Awaited<ReturnType<typeof prepareInventory>>,
): Promise<void> {
  const { inventory, prefix, session, shape } = context;
  for (let index = 0; index < queryRepeats; index++) {
    let rejected = false;
    try {
      const directoryPlan = session.select({
        directories: [shape === 'wide' ? 'module-000' : prefix],
      });
      if (
        shape === 'wide' &&
        !inventory.truncated &&
        directoryPlan.selection.length !== 15
      )
        throw new Error(
          'The supported directory selection changed its membership.',
        );
    } catch (error) {
      rejected =
        error instanceof GitSourceError &&
        error.code ===
          (inventory.truncated ? 'INCOMPLETE_INVENTORY' : 'RESOURCE_LIMIT');
      if (shape === 'wide' && !inventory.truncated)
        throw new Error('A complete small directory selection was rejected.', {
          cause: error,
        });
      if (!rejected) throw error;
    }
    if (inventory.truncated && !rejected)
      throw new Error('Directory selection accepted incomplete membership.');
    await new Promise<void>((next) => setImmediate(next));
  }
}

export async function measureAcquisition(
  context: Awaited<ReturnType<typeof prepareInventory>>,
): Promise<{
  stage: StageMeasurement;
  snapshotId: string;
  declarations: number;
  files: number;
}> {
  const { entries, plan, session, shape } = context;
  let snapshotId = '';
  let declarations = 0;
  let files = 0;
  const stage = await measure(1, async () => {
    try {
      const acquired = await session.acquire(plan);
      const result = await analyzeManifest(acquired.input);
      if (snapshotId && snapshotId !== result.facts.snapshotId)
        throw new Error(
          'Repeated analysis changed the manifest snapshot identity.',
        );
      snapshotId = result.facts.snapshotId;
      declarations = result.facts.symbols.length;
      files = result.facts.files.length;
    } catch (error) {
      const detail =
        error instanceof GitSourceError
          ? `${error.code}: ${error.message}`
          : error instanceof Error
            ? error.message
            : 'unknown failure';
      throw new Error(
        `Acquisition or analysis failed for ${shape}/${entries}: ${detail}`,
        { cause: error },
      );
    }
  });
  return { stage, snapshotId, declarations, files };
}

export async function verifyInventoryLimits(
  context: Awaited<ReturnType<typeof prepareInventory>>,
): Promise<void> {
  const { inventory, repository } = context;
  const limited = await openGitInventory({
    repositoryPath: repository.root,
    repositoryId,
    revision: inventory.commitId,
    limits: { trees: 1 },
  });
  if (
    !limited.inventory.truncated ||
    !limited.inventory.truncationReasons.length
  )
    throw new Error('Lowered tree limit did not report partial inventory.');
  const controller = new AbortController();
  controller.abort();
  let cancelCode = '';
  try {
    await openGitInventory({
      repositoryPath: repository.root,
      repositoryId,
      revision: inventory.commitId,
      signal: controller.signal,
    });
  } catch (error) {
    if (!(error instanceof GitSourceError)) throw error;
    cancelCode = error.code;
  }
  if (cancelCode !== 'CANCELLED')
    throw new Error('Cancellation status was not typed.');
}

export function inventoryDigest(
  context: Awaited<ReturnType<typeof prepareInventory>>,
): string {
  const { directoryQuery, inventory, pagePaths } = context;
  return createHash('sha256')
    .update(
      JSON.stringify({
        commitId: inventory.commitId,
        files: inventory.files,
        counts: inventory.counts,
        truncationReasons: inventory.truncationReasons,
        pagePaths,
        filtered: directoryQuery.items,
      }),
    )
    .digest('hex');
}
