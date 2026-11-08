import { createHash } from 'node:crypto';
import {
  createSourcePositionIndex,
  hashSchema,
  isSnapshotPath,
  sourceEvidenceSchema,
} from '@codethread/code-model';
import type {
  AnalysisFacts,
  SourcePositionIndex,
  VerifiedSourceReader,
} from '@codethread/code-model';
import { ensure, TraceError } from './fact-integrity.js';
export interface RetainedSource {
  bytes: Uint8Array;
  text: string;
  positions: SourcePositionIndex;
}

export function validateSources(
  facts: AnalysisFacts,
  reader: VerifiedSourceReader,
): Map<string, RetainedSource> {
  const snapshot = facts.snapshotId;
  const files = new Map(facts.files.map((file) => [file.id, file]));
  const sources = new Map<string, RetainedSource>();
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const file of facts.files) {
    ensure(
      file.snapshotId === snapshot &&
        isSnapshotPath(file.path) &&
        new TextDecoder().decode(new TextEncoder().encode(file.path)) ===
          file.path &&
        !paths.has(file.path.toLowerCase()),
    );
    paths.add(file.path.toLowerCase());
    hashSchema.parse(file.contentHash);
    let input: Uint8Array | null;
    try {
      input = reader.readFile(file.id);
    } catch {
      throw new TraceError(
        'SOURCE_UNAVAILABLE',
        'Retained source is unavailable',
      );
    }
    if (!(input instanceof Uint8Array))
      throw new TraceError(
        'SOURCE_UNAVAILABLE',
        'Retained source is unavailable',
      );
    const bytes = Uint8Array.from(input);
    totalBytes += bytes.length;
    ensure(
      bytes.length === file.byteLength &&
        bytes.length <= 262144 &&
        totalBytes <= 2097152,
    );
    if (createHash('sha256').update(bytes).digest('hex') !== file.contentHash)
      throw new TraceError(
        'HASH_MISMATCH',
        'Retained source does not match its identity',
      );
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        bytes,
      );
    } catch {
      throw new TraceError(
        'SOURCE_UNAVAILABLE',
        'Retained source has invalid encoding',
      );
    }
    sources.set(file.id, {
      bytes,
      text,
      positions: createSourcePositionIndex(text),
    });
  }
  for (const item of facts.evidenceRefs) {
    sourceEvidenceSchema.parse(item);
    const file = files.get(item.fileId),
      source = sources.get(item.fileId);
    ensure(
      file &&
        source &&
        item.snapshotId === snapshot &&
        item.contentHash === file.contentHash &&
        source.positions.validateRange(item.range),
    );
  }
  return sources;
}
