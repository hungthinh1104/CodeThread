import { createHash } from 'node:crypto';
import { z } from 'zod';
import { hashSchema, isSnapshotPath } from '@codethread/code-model';
import { filterKey } from '@codethread/contracts';
import { GitSourceError } from './types.ts';
import type {
  GitInventoryPage,
  InventoryContext,
  GitPathLookup,
} from './inventory-types.ts';

export function supportedPath(path: string): boolean {
  return (
    isSnapshotPath(path) &&
    !/\p{Cc}/u.test(path) &&
    Buffer.from(path, 'utf8').toString('utf8') === path
  );
}
export function withinDirectory(path: string, prefix: string): boolean {
  return prefix === '' || path.startsWith(prefix + '/');
}
const querySchema = z.strictObject({
  text: z
    .string()
    .min(1)
    .max(256)
    .refine(
      (text) =>
        !/\p{Cc}/u.test(text) &&
        Buffer.from(text, 'utf8').toString('utf8') === text,
    )
    .optional(),
  prefix: z
    .string()
    .max(1024)
    .refine((value) => value === '' || supportedPath(value))
    .optional(),
  exactPath: z
    .string()
    .refine((value) => supportedPath(value) && value.endsWith('.ts'))
    .optional(),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(8192).optional(),
});
const cursorSchema = z.strictObject({
  version: z.literal(1),
  inventoryId: hashSchema,
  commitId: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  queryKey: hashSchema,
  order: z.literal('git-path-utf8-v1'),
  after: z.string().refine(supportedPath),
});
type InventoryCursor = z.infer<typeof cursorSchema>;

function encodeCursor(payload: InventoryCursor): string {
  const token = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64url',
  );
  if (token.length > 8192)
    throw new GitSourceError(
      'RESOURCE_LIMIT',
      'Inventory cursor exceeds its byte limit.',
    );
  return token;
}
function decodeCursor(token: string): InventoryCursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new Error('encoding');
    const payload = cursorSchema.parse(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
          Buffer.from(token, 'base64url'),
        ),
      ),
    );
    if (encodeCursor(payload) !== token) throw new Error('canonical spelling');
    return payload;
  } catch {
    throw new GitSourceError(
      'INVALID_CURSOR',
      'Inventory cursor is malformed or noncanonical.',
    );
  }
}

export function queryInventory(
  context: InventoryContext,
  input: unknown = {},
): GitInventoryPage {
  const parsed = querySchema.safeParse(input);
  if (!parsed.success)
    throw new GitSourceError(
      parsed.error.issues.some((issue) => issue.path[0] === 'cursor')
        ? 'INVALID_CURSOR'
        : 'INVALID_QUERY',
      'Inventory query is invalid or exceeds its bounds.',
    );
  const request = parsed.data,
    inventory = context.inventory;
  const normalized = {
    text: request.text ?? '',
    prefix: request.prefix ?? '',
    exactPath: request.exactPath ?? null,
  };
  const queryKey = createHash('sha256')
    .update(filterKey(normalized))
    .digest('hex');
  const matches = inventory.files.filter(
    (file) =>
      file.path.includes(normalized.text) &&
      withinDirectory(file.path, normalized.prefix) &&
      (normalized.exactPath === null || file.path === normalized.exactPath),
  );
  let offset = 0;
  if (request.cursor !== undefined) {
    const cursor = decodeCursor(request.cursor);
    if (
      cursor.inventoryId !== inventory.inventoryId ||
      cursor.commitId !== inventory.commitId ||
      cursor.queryKey !== queryKey
    )
      throw new GitSourceError(
        'INVALID_CURSOR',
        'Inventory cursor does not match the pinned inventory or query.',
      );
    const index = matches.findIndex((file) => file.path === cursor.after);
    if (index < 0)
      throw new GitSourceError(
        'INVALID_CURSOR',
        'Inventory cursor position is absent from the query.',
      );
    offset = index + 1;
  }
  const items = matches.slice(offset, offset + request.limit);
  const more = offset + items.length < matches.length;
  const nextCursor = more
    ? encodeCursor({
        version: 1,
        inventoryId: inventory.inventoryId,
        commitId: inventory.commitId,
        queryKey,
        order: 'git-path-utf8-v1',
        after: items.at(-1)!.path,
      })
    : null;
  return Object.freeze({
    inventoryId: inventory.inventoryId,
    commitId: inventory.commitId,
    items: Object.freeze(items),
    nextCursor,
    knownMatches: matches.length,
    inventoryComplete: !inventory.truncated,
    searchComplete: !inventory.truncated,
    endOfVerifiedResults: !more,
    truncationReasons: inventory.truncationReasons,
    appliedLimits: Object.freeze({
      ...inventory.appliedLimits,
      pageSize: request.limit,
    }),
  });
}

export function lookupInventoryPath(
  context: InventoryContext,
  input: unknown,
): GitPathLookup {
  if (
    typeof input !== 'string' ||
    !supportedPath(input) ||
    !input.endsWith('.ts') ||
    input.split('/').length > context.inventory.appliedLimits.pathComponents
  )
    return { status: 'unsupported', code: 'INVALID_SELECTION' };
  const components = input.split('/');
  let prefix = '';
  for (const component of components) {
    prefix = prefix ? prefix + '/' + component : component;
    if (context.blockedPaths.has(prefix))
      return { status: 'unsupported', code: 'UNSUPPORTED_FILE_MODE' };
  }
  const known = context.files.get(input);
  if (known) {
    if (known.file.mode !== '100644' && known.file.mode !== '100755')
      return { status: 'unsupported', code: 'UNSUPPORTED_FILE_MODE' };
    return { status: 'found', file: known.file };
  }
  return context.inventory.truncated
    ? { status: 'not_verified', code: 'INCOMPLETE_INVENTORY' }
    : { status: 'not_found' };
}
