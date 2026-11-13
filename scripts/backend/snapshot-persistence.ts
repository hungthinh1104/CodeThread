import type {
  AnalysisFacts,
  VerifiedSourceReader,
} from '@codethread/code-model';
import { createSourcePositionIndex } from '@codethread/code-model';
import { createInvestigation } from '@codethread/trace-engine';
import type { Database } from './database.ts';
import { hashSourceBytes } from './source-objects.ts';
import {
  assertSnapshotEnvelope,
  verifyNormalizedSnapshot,
} from './snapshot-integrity.ts';

type Sql = Database;
type Snapshot = { facts: AnalysisFacts; source: VerifiedSourceReader };

export async function loadSnapshot(
  db: Sql,
  snapshotId: string,
): Promise<Snapshot> {
  return db.begin(async (transaction) => {
    const scoped = transaction as unknown as Sql;
    await scoped`SELECT pg_advisory_xact_lock_shared(
      1919606126,hashtext(${snapshotId}::text))`;
    return loadSnapshotContentsInTransaction(scoped, snapshotId);
  });
}

export async function loadSnapshotContentsInTransaction(
  db: Sql,
  snapshotId: string,
): Promise<Snapshot> {
  const row = (
    await db`SELECT facts_json,repository_id,source_fingerprint,analyzer_version,
      analyzer_build_hash,configuration_hash,coverage FROM codethread.repository_snapshot
    WHERE id=${snapshotId} AND state='published'`
  )[0];
  if (!row) throw new Error('Published snapshot not found');
  const facts = row.facts_json as AnalysisFacts;
  if (facts.snapshotId !== snapshotId)
    throw new Error('Snapshot identity mismatch');
  assertSnapshotEnvelope(row, facts);
  await verifyNormalizedSnapshot(db, snapshotId, facts);
  const files = await db`SELECT f.id,f.path,f.content_hash,f.byte_length,o.bytes
    FROM codethread.snapshot_file f LEFT JOIN codethread.source_object o
      ON o.sha256=f.content_hash WHERE f.snapshot_id=${snapshotId}`;
  if (files.length !== facts.files.length)
    throw new Error('Stored snapshot file count differs from immutable facts');
  const bytes = new Map<
    string,
    { path: string; bytes: Uint8Array; text: string }
  >();
  for (const f of files) {
    if (!f.bytes)
      throw new Error(
        `Stored source object is missing for snapshot file ${f.path}`,
      );
    const raw = Uint8Array.from(f.bytes as Uint8Array);
    if (
      hashSourceBytes(raw) !== f.content_hash ||
      raw.byteLength !== Number(f.byte_length)
    )
      throw new Error(`Stored source object integrity mismatch for ${f.path}`);
    bytes.set(f.id as string, {
      path: f.path as string,
      bytes: raw,
      text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        raw,
      ),
    });
  }
  const refs = new Map(facts.evidenceRefs.map((e) => [e.id, e]));
  const source: VerifiedSourceReader = {
    readFile(id) {
      const file = bytes.get(id);
      return file ? Uint8Array.from(file.bytes) : null;
    },
    readEvidence(id) {
      const evidence = refs.get(id);
      const unavailable = (
        code:
          | 'EVIDENCE_NOT_FOUND'
          | 'SOURCE_UNAVAILABLE'
          | 'HASH_MISMATCH'
          | 'INVALID_ENCODING'
          | 'EVIDENCE_TOO_LARGE',
      ) => ({
        status: 'unavailable' as const,
        snapshotId,
        evidenceId: id,
        code,
      });
      if (!evidence) return unavailable('EVIDENCE_NOT_FOUND');
      const file = bytes.get(evidence.fileId);
      if (!file) return unavailable('SOURCE_UNAVAILABLE');
      if (hashSourceBytes(file.bytes) !== evidence.contentHash)
        return unavailable('HASH_MISMATCH');
      if (!createSourcePositionIndex(file.text).validateRange(evidence.range))
        return unavailable('SOURCE_UNAVAILABLE');
      if (evidence.range.end.offset - evidence.range.start.offset > 65536)
        return unavailable('EVIDENCE_TOO_LARGE');
      return {
        status: 'available' as const,
        evidence,
        filePath: file.path,
        text: file.text.slice(
          evidence.range.start.offset,
          evidence.range.end.offset,
        ),
      };
    },
  };
  createInvestigation(facts, source, { resourceProfile: 'repository' });
  return { facts, source };
}
