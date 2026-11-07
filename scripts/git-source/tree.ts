import { createHash } from 'node:crypto';
import { GitSourceError } from './types.ts';

export const ORDER_BYTES = (left: Buffer, right: Buffer): number =>
  Buffer.compare(left, right);

export const compareGitPaths = (left: string, right: string): number =>
  ORDER_BYTES(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));

export interface TreeEntry {
  name: Buffer;
  readonly mode: '100644' | '100755' | '120000' | '160000' | '40000' | '040000';
  oid: string;
}

function parseTreeMode(value: string): TreeEntry['mode'] | null {
  switch (value) {
    case '100644':
    case '100755':
    case '120000':
    case '160000':
    case '40000':
    case '040000':
      return value;
    default:
      return null;
  }
}

export function verifyObject(
  objectFormat: 'sha1' | 'sha256',
  type: string,
  bytes: Buffer,
  expectedOid: string,
): boolean {
  const digest = createHash(objectFormat)
    .update(`${type} ${bytes.length}\0`, 'utf8')
    .update(bytes)
    .digest('hex');
  return digest === expectedOid;
}

export function parseTree(
  bytes: Buffer,
  oidWidth: number,
  remainingEntryLimit: number,
  allowTruncation = false,
): { entries: TreeEntry[]; truncated: boolean } {
  const entries: TreeEntry[] = [],
    names = new Set<string>();
  let cursor = 0,
    truncated = false;
  while (cursor < bytes.length) {
    const space = bytes.indexOf(0x20, cursor),
      nul = bytes.indexOf(0, space + 1);
    if (space <= cursor || nul <= space || nul + 1 + oidWidth > bytes.length)
      throw new GitSourceError(
        'CORRUPT_OBJECT',
        'A Git tree object is malformed.',
      );
    const mode = parseTreeMode(
        bytes.subarray(cursor, space).toString('latin1'),
      ),
      name = bytes.subarray(space + 1, nul),
      rawOid = bytes.subarray(nul + 1, nul + 1 + oidWidth),
      nameKey = name.toString('hex');
    if (
      mode === null ||
      name.length === 0 ||
      name.includes(0x2f) ||
      name.equals(Buffer.from('.')) ||
      name.equals(Buffer.from('..')) ||
      names.has(nameKey)
    )
      throw new GitSourceError(
        'CORRUPT_OBJECT',
        'A Git tree entry is malformed.',
      );
    if (entries.length >= remainingEntryLimit) {
      if (!allowTruncation)
        throw new GitSourceError(
          'RESOURCE_LIMIT',
          'Selected paths expose too many Git tree entries.',
        );
      truncated = true;
      break;
    }
    names.add(nameKey);
    entries.push({
      name: Buffer.from(name),
      mode,
      oid: rawOid.toString('hex'),
    });
    cursor = nul + 1 + oidWidth;
  }
  return { entries, truncated };
}

export function parseDecimal(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value))
    throw new GitSourceError(
      'GIT_PROTOCOL',
      'Git returned malformed object metadata.',
    );
  const number = Number(value);
  if (!Number.isSafeInteger(number))
    throw new GitSourceError(
      'RESOURCE_LIMIT',
      'Git object size exceeds the supported range.',
    );
  return number;
}
