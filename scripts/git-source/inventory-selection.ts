import { createHash } from 'node:crypto';
import { z } from 'zod';
import { hashSchema } from '@codethread/code-model';
import { filterKey } from '@codethread/contracts';
import { ANALYSIS_LIMITS } from '@codethread/symbol-indexer';
import { GitSourceError } from './types.ts';
import { gitFailure, validateSelection } from './selection.ts';
import { acquireVerifiedFiles } from './acquire.ts';
import type { SelectedGitFile } from './acquire.ts';
import {
  supportedPath,
  withinDirectory,
  lookupInventoryPath,
} from './inventory-query.ts';
import { compareGitPaths } from './tree.ts';
import type { InventoryContext, GitSelectionPlan } from './inventory-types.ts';

const inputSchema = z.strictObject({
  paths: z.array(z.string().max(1024)).default([]),
  directories: z
    .array(
      z
        .string()
        .max(1024)
        .refine((path) => path === '' || supportedPath(path)),
    )
    .default([]),
});
const planSchema = z.strictObject({
  inventoryId: hashSchema,
  commitId: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  selectionId: hashSchema,
  paths: z.array(z.string()).max(20),
  directories: z.array(z.string()).max(20),
  selection: z
    .array(z.strictObject({ path: z.string(), status: z.literal('selected') }))
    .max(20),
});

function checkInputSize(input: unknown): void {
  if (input !== null && typeof input === 'object')
    for (const key of ['paths', 'directories']) {
      const value = Reflect.get(input, key);
      if (Array.isArray(value) && value.length > ANALYSIS_LIMITS.maxFiles)
        throw new GitSourceError(
          'RESOURCE_LIMIT',
          'Source selection exceeds the input-count limit.',
        );
    }
}

export function selectInventorySources(
  context: InventoryContext,
  input: unknown,
): GitSelectionPlan {
  checkInputSize(input);
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success)
    throw new GitSourceError(
      'INVALID_SELECTION',
      'Source selection is malformed.',
    );
  const { paths, directories } = parsed.data;
  if (new Set(directories).size !== directories.length)
    throw new GitSourceError(
      'INVALID_SELECTION',
      'Duplicate directory selections are not allowed.',
    );
  if (directories.length > 0 && context.inventory.truncated)
    throw new GitSourceError(
      'INCOMPLETE_INVENTORY',
      'Directory selection requires a complete pinned inventory.',
    );
  const expanded = [...paths];
  for (const directory of directories) {
    const matches = context.inventory.files.filter((file) =>
      withinDirectory(file.path, directory),
    );
    if (matches.length === 0)
      throw new GitSourceError(
        'INVALID_SELECTION',
        'The directory has no committed TypeScript source candidates.',
      );
    expanded.push(...matches.map((file) => file.path));
  }
  const selection = validateSelection(expanded);
  for (const path of expanded) {
    const result = lookupInventoryPath(context, path);
    if (result.status === 'found') continue;
    const code = result.status === 'not_found' ? 'FILE_NOT_FOUND' : result.code;
    throw new GitSourceError(
      code,
      result.status === 'not_verified'
        ? 'The selected path was not verified before inventory traversal stopped.'
        : 'A selected path is absent or unsupported in the pinned inventory.',
      selection.map((item) => ({
        path: item.path,
        status: item.path === path ? 'rejected' : 'not-admitted',
      })),
    );
  }
  const descriptor = {
    inventoryId: context.inventory.inventoryId,
    commitId: context.inventory.commitId,
    paths: [...paths].sort(compareGitPaths),
    directories: [...directories].sort(compareGitPaths),
    selection: selection.sort((a, b) => compareGitPaths(a.path, b.path)),
  };
  const selectionId = createHash('sha256')
    .update(filterKey(descriptor))
    .digest('hex');
  return Object.freeze({
    ...descriptor,
    selectionId,
    paths: Object.freeze(descriptor.paths),
    directories: Object.freeze(descriptor.directories),
    selection: Object.freeze(
      descriptor.selection.map((item) => Object.freeze(item)),
    ),
  });
}

function validatePlan(
  context: InventoryContext,
  input: unknown,
): GitSelectionPlan {
  const parsed = planSchema.safeParse(input);
  if (!parsed.success)
    throw new GitSourceError(
      'INVALID_SELECTION',
      'The selection plan is malformed.',
    );
  const plan = parsed.data;
  if (
    plan.inventoryId !== context.inventory.inventoryId ||
    plan.commitId !== context.inventory.commitId
  )
    throw new GitSourceError(
      'INVENTORY_MISMATCH',
      'The selection belongs to a different pinned inventory.',
    );
  const expected = selectInventorySources(context, {
    paths: plan.paths,
    directories: plan.directories,
  });
  if (
    plan.selectionId !== expected.selectionId ||
    filterKey(plan.selection) !== filterKey(expected.selection)
  )
    throw new GitSourceError(
      'INVALID_SELECTION',
      'The selection plan no longer matches its complete source set.',
    );
  return expected;
}

export function createInventoryAcquirer(context: InventoryContext) {
  let acquiring = false;
  return async (input: unknown, signal?: AbortSignal) => {
    if (acquiring)
      throw new GitSourceError(
        'RESOURCE_LIMIT',
        'An acquisition is already active in this inventory session.',
      );
    const plan = validatePlan(context, input);
    const files: SelectedGitFile[] = plan.selection.map((item) => {
      const known = context.files.get(item.path)!;
      const mode = known.file.mode;
      if (mode !== '100644' && mode !== '100755')
        throw new GitSourceError(
          'UNSUPPORTED_FILE_MODE',
          'Selected source is not a regular Git blob.',
        );
      return { path: item.path, oid: known.oid, mode };
    });
    acquiring = true;
    try {
      const reader = context.repository.acquisitionStage(
        plan.selection,
        signal,
      );
      return await acquireVerifiedFiles(
        context.repository,
        files,
        plan.selection,
        reader,
      );
    } catch (error) {
      gitFailure(error, plan.selection);
    } finally {
      acquiring = false;
    }
  };
}
