import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ANALYSIS_LIMITS } from '@codethread/symbol-indexer';
import { failure, withRejected } from './selection.ts';
import { parseDecimal, verifyObject } from './tree.ts';
import type { GitProcessResult } from './process.ts';
import type { GitSelectionStatus } from './types.ts';

export type GitObjectType = 'commit' | 'tree' | 'blob';
export interface GitObject {
  type: GitObjectType;
  size: number;
  bytes: Buffer;
}
export interface GitOperationCounts {
  subprocesses: number;
  metadataChecks: number;
  commitReads: number;
  treeReads: number;
  blobReads: number;
  metadataBytes: number;
  blobBytes: number;
}
export type GitRun = (
  args: readonly string[],
  maximum?: number,
  input?: Buffer,
) => Promise<GitProcessResult>;

interface ReaderContext {
  objectFormat: 'sha1' | 'sha256';
  gitDirectory: string;
  run: GitRun;
  checkpoint(): void;
  metadataLimit: number;
  selection: readonly GitSelectionStatus[];
  counts: GitOperationCounts;
}
interface BatchRequest {
  oids: readonly string[];
  expectedType: GitObjectType;
  maxBytes: number;
  sourceIndexes?: readonly number[];
}
type Metadata = Map<string, { type: GitObjectType; size: number }>;

function rejected(context: ReaderContext, batch: BatchRequest, oid: string) {
  const index = batch.sourceIndexes?.[batch.oids.indexOf(oid)];
  return index === undefined
    ? context.selection
    : withRejected(context.selection, index);
}

async function missingObject(
  context: ReaderContext,
  batch: BatchRequest,
  oid: string,
): Promise<never> {
  let corrupt = false;
  try {
    await lstat(
      resolve(context.gitDirectory, 'objects', oid.slice(0, 2), oid.slice(2)),
    );
    corrupt = true;
  } catch {
    // Git also checks packs; the existence of an unreadable loose object is diagnostic only.
  }
  throw failure(
    corrupt ? 'CORRUPT_OBJECT' : 'MISSING_OBJECT',
    corrupt
      ? 'A loose Git object is corrupt or unreadable.'
      : 'A required Git object is missing.',
    rejected(context, batch, oid),
  );
}

async function readMetadata(
  context: ReaderContext,
  batch: BatchRequest,
  uniqueOids: readonly string[],
  input: Buffer,
): Promise<Metadata> {
  const width = context.objectFormat === 'sha1' ? 40 : 64;
  context.counts.metadataChecks += uniqueOids.length;
  const result = await context.run(
    ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
    uniqueOids.length * (width + 64),
    input,
  );
  const lines = result.stdout.toString('latin1').split('\n');
  if (lines.at(-1) !== '' || lines.length !== uniqueOids.length + 1)
    throw failure(
      'GIT_PROTOCOL',
      'Git returned malformed batch metadata.',
      context.selection,
    );
  const metadata: Metadata = new Map();
  for (const [index, oid] of uniqueOids.entries()) {
    const line = lines[index]!;
    if (line === `${oid} missing`) await missingObject(context, batch, oid);
    const match = /^([0-9a-f]+) (commit|tree|blob) (0|[1-9][0-9]*)$/.exec(line);
    if (!match || match[1] !== oid)
      throw failure(
        'GIT_PROTOCOL',
        'Git returned malformed batch metadata.',
        context.selection,
      );
    if (match[2] !== batch.expectedType)
      throw failure(
        'CORRUPT_OBJECT',
        'A Git object has an unexpected type.',
        context.selection,
      );
    const size = parseDecimal(match[3]!);
    if (size > batch.maxBytes)
      throw failure(
        'RESOURCE_LIMIT',
        'A Git object exceeds its byte limit.',
        rejected(context, batch, oid),
      );
    metadata.set(oid, { type: batch.expectedType, size });
  }
  return metadata;
}

function checkBatchBudget(
  context: ReaderContext,
  batch: BatchRequest,
  metadata: Metadata,
  phaseMetadataBytes: number,
): number {
  const bytes = [...metadata.values()].reduce(
    (total, object) => total + object.size,
    0,
  );
  if (
    batch.expectedType !== 'blob' &&
    phaseMetadataBytes + bytes > context.metadataLimit
  )
    throw failure(
      'RESOURCE_LIMIT',
      'Git metadata exceeds its cumulative byte limit.',
      context.selection,
    );
  if (batch.sourceIndexes) {
    let total = 0;
    for (const [index, oid] of batch.oids.entries()) {
      total += metadata.get(oid)!.size;
      if (total > ANALYSIS_LIMITS.maxTotalBytes)
        throw failure(
          'RESOURCE_LIMIT',
          'Selected source exceeds the analyzer total-byte limit.',
          withRejected(context.selection, batch.sourceIndexes[index]!),
        );
    }
  }
  return bytes;
}

async function parseContents(
  context: ReaderContext,
  batch: BatchRequest,
  uniqueOids: readonly string[],
  metadata: Metadata,
  bytes: Buffer,
): Promise<Map<string, GitObject>> {
  const objects = new Map<string, GitObject>();
  let cursor = 0;
  for (const oid of uniqueOids) {
    const lineEnd = bytes.indexOf(0x0a, cursor);
    if (lineEnd < 0)
      throw failure(
        'GIT_PROTOCOL',
        'Git returned a truncated object header.',
        context.selection,
      );
    const header = bytes.subarray(cursor, lineEnd).toString('latin1');
    if (header === `${oid} missing`) await missingObject(context, batch, oid);
    const match = /^([0-9a-f]+) (commit|tree|blob) (0|[1-9][0-9]*)$/.exec(
      header,
    );
    const expected = metadata.get(oid)!;
    if (
      !match ||
      match[1] !== oid ||
      match[2] !== expected.type ||
      parseDecimal(match[3]!) !== expected.size
    )
      throw failure(
        'GIT_PROTOCOL',
        'Git returned inconsistent object metadata.',
        context.selection,
      );
    const bodyStart = lineEnd + 1,
      bodyEnd = bodyStart + expected.size;
    if (bodyEnd >= bytes.length || bytes[bodyEnd] !== 0x0a)
      throw failure(
        'GIT_PROTOCOL',
        'Git returned a truncated object body.',
        context.selection,
      );
    const body = bytes.subarray(bodyStart, bodyEnd);
    if (!verifyObject(context.objectFormat, expected.type, body, oid))
      throw failure(
        'CORRUPT_OBJECT',
        'A Git object failed content identity verification.',
        rejected(context, batch, oid),
      );
    objects.set(oid, { ...expected, bytes: Buffer.from(body) });
    if (expected.type === 'blob') {
      context.counts.blobReads++;
      context.counts.blobBytes += expected.size;
    } else {
      if (expected.type === 'commit') context.counts.commitReads++;
      else context.counts.treeReads++;
      context.counts.metadataBytes += expected.size;
    }
    cursor = bodyEnd + 1;
  }
  if (cursor !== bytes.length)
    throw failure(
      'GIT_PROTOCOL',
      'Git returned trailing object data.',
      context.selection,
    );
  return objects;
}

export function createObjectReader(context: ReaderContext) {
  const metadataStart = context.counts.metadataBytes;
  return {
    checkpoint: context.checkpoint,
    async readObjects(
      oids: readonly string[],
      expectedType: GitObjectType,
      maxBytes: number,
      sourceIndexes?: readonly number[],
    ): Promise<Map<string, GitObject>> {
      context.checkpoint();
      const uniqueOids = [...new Set(oids)];
      if (uniqueOids.length === 0) return new Map();
      const width = context.objectFormat === 'sha1' ? 40 : 64;
      for (const oid of uniqueOids)
        if (!new RegExp(`^[0-9a-f]{${width}}$`).test(oid))
          throw failure(
            'CORRUPT_OBJECT',
            'A Git object reference is malformed.',
            context.selection,
          );
      const batch: BatchRequest = {
        oids,
        expectedType,
        maxBytes,
        ...(sourceIndexes === undefined ? {} : { sourceIndexes }),
      };
      const input = Buffer.from(
        uniqueOids.map((oid) => `${oid}\n`).join(''),
        'ascii',
      );
      const metadata = await readMetadata(context, batch, uniqueOids, input);
      const bodyBytes = checkBatchBudget(
        context,
        batch,
        metadata,
        context.counts.metadataBytes - metadataStart,
      );
      const content = await context.run(
        ['cat-file', '--batch'],
        bodyBytes + uniqueOids.length * (width + 64),
        input,
      );
      const objects = await parseContents(
        context,
        batch,
        uniqueOids,
        metadata,
        content.stdout,
      );
      context.checkpoint();
      return objects;
    },
  };
}

export type GitObjectReader = ReturnType<typeof createObjectReader>;
