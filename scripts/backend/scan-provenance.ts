import { createHash } from 'node:crypto';
import type { PinnedInput } from '../git-source/repository-metadata.ts';
import type { Database } from './database.ts';
import { storeSourceObjects } from './source-objects.ts';

export interface PinnedRevision {
  commitId: string;
  rootTreeId: string;
  objectFormat: 'sha1' | 'sha256';
}

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function persistScanPin(
  sql: Database,
  jobId: string,
  repositoryId: string,
  generation: string,
  attempt: number,
  pin: PinnedRevision,
): Promise<void> {
  const rows = await sql`
    UPDATE codethread.scan_job
    SET git_object_format=${pin.objectFormat}, git_commit_oid=${pin.commitId},
        git_tree_oid=${pin.rootTreeId}, updated_at=now()
    WHERE id=${jobId} AND repository_id=${repositoryId}
      AND generation=${generation}::bigint AND attempt=${attempt} AND state='running'
      AND (git_commit_oid IS NULL OR
        (git_object_format=${pin.objectFormat} AND git_commit_oid=${pin.commitId}
          AND git_tree_oid=${pin.rootTreeId}))
    RETURNING id`;
  if (!rows.length)
    throw new Error('Scan pin was rejected by the worker fencing check');
}

export async function persistScanInputs(
  sql: Database,
  jobId: string,
  repositoryId: string,
  generation: string,
  attempt: number,
  pin: PinnedRevision,
  files: readonly PinnedInput[],
  sourcePaths: ReadonlySet<string>,
): Promise<void> {
  await sql.begin(async (transaction) => {
    const db = transaction as unknown as Database;
    const job = (
      await db`SELECT git_object_format,git_commit_oid,git_tree_oid
        FROM codethread.scan_job WHERE id=${jobId} AND repository_id=${repositoryId}
          AND generation=${generation}::bigint AND attempt=${attempt}
          AND state='running' FOR UPDATE`
    )[0];
    if (
      !job ||
      job.git_object_format !== pin.objectFormat ||
      job.git_commit_oid !== pin.commitId ||
      job.git_tree_oid !== pin.rootTreeId
    )
      throw new Error('Scan inputs do not match the fenced pinned revision');

    for (const file of files)
      if (sha(file.bytes) !== file.sha256)
        throw new Error(`Pinned input hash mismatch for ${file.path}`);
    await storeSourceObjects(db, files);

    for (let offset = 0; offset < files.length; offset += 200) {
      const chunk = files.slice(offset, offset + 200),
        columns = [
          'scan_job_id',
          'path',
          'git_blob_oid',
          'git_mode',
          'content_hash',
          'input_kind',
        ],
        parameters = chunk.flatMap((file) => [
          jobId,
          file.path,
          file.blobId,
          file.mode,
          file.sha256,
          sourcePaths.has(file.path) ? 'source' : 'metadata',
        ]),
        values = chunk.map(
          (_, row) =>
            '(' +
            columns
              .map((__, column) => '$' + (row * columns.length + column + 1))
              .join(',') +
            ')',
        );
      if (chunk.length)
        await db.unsafe(
          `INSERT INTO codethread.scan_input_file (${columns.join(',')})
           VALUES ${values.join(',')}
           ON CONFLICT (scan_job_id,path) DO NOTHING`,
          parameters as Parameters<Database['unsafe']>[1],
        );
    }

    const stored =
      await db`SELECT path,git_blob_oid,git_mode,content_hash,input_kind
      FROM codethread.scan_input_file WHERE scan_job_id=${jobId} ORDER BY path`;
    const expected = [...files].sort((a, b) => a.path.localeCompare(b.path));
    if (stored.length !== expected.length)
      throw new Error(
        'Persisted scan input manifest has a different file count',
      );
    for (let index = 0; index < expected.length; index++) {
      const actual = stored[index]!,
        file = expected[index]!;
      if (
        actual.path !== file.path ||
        actual.git_blob_oid !== file.blobId ||
        actual.git_mode !== file.mode ||
        actual.content_hash !== file.sha256 ||
        actual.input_kind !==
          (sourcePaths.has(file.path) ? 'source' : 'metadata')
      )
        throw new Error(
          'Persisted scan input manifest differs from pinned Git blobs',
        );
    }
  });
}
