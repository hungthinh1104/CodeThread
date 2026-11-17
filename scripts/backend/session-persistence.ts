import type {
  RepositoryInvestigationSession,
  RepositoryProjectState,
} from '../investigation/repository-session.ts';
import type { Database } from './database.ts';
import { hashSourceBytes } from './source-objects.ts';
import { loadSnapshotContentsInTransaction } from './snapshot-persistence.ts';

type Sql = Database;

export async function loadRepositorySession(
  db: Sql,
  jobId: string,
): Promise<RepositoryInvestigationSession> {
  return db.begin(async (transaction) => {
    const scoped = transaction as unknown as Sql;
    await scoped`SELECT pg_advisory_xact_lock_shared(
      1919606127,hashtext(${jobId}::text))`;
    return loadRepositorySessionContents(scoped, jobId);
  });
}

async function loadRepositorySessionContents(
  db: Sql,
  jobId: string,
): Promise<RepositoryInvestigationSession> {
  const job = (
    await db`SELECT repository_id,state,git_object_format,git_commit_oid,session_json
      FROM codethread.scan_job WHERE id=${jobId}`
  )[0];
  if (
    !job ||
    job.state !== 'succeeded' ||
    !job.git_commit_oid ||
    (job.git_object_format !== 'sha1' && job.git_object_format !== 'sha256')
  )
    throw new Error(
      'A completed, pinned scan is required for persistent viewing',
    );
  const rows =
    await db`SELECT p.project_json,p.status,p.snapshot_id,p.diagnostics
    FROM codethread.scan_project p WHERE p.scan_job_id=${jobId}
    ORDER BY p.project_label COLLATE "C",p.project_id COLLATE "C"`;
  const inputRows =
    await db`SELECT i.path,i.git_blob_oid,i.git_mode,i.content_hash,
      i.input_kind,o.bytes,o.byte_length
    FROM codethread.scan_input_file i LEFT JOIN codethread.source_object o
      ON o.sha256=i.content_hash WHERE i.scan_job_id=${jobId}
    ORDER BY i.path COLLATE "C"`;
  for (const file of inputRows) {
    if (!file.bytes)
      throw new Error(
        `Persisted scan input is missing source bytes for ${file.path}`,
      );
    const bytes = Uint8Array.from(file.bytes as Uint8Array);
    if (
      Number(file.byte_length) !== bytes.byteLength ||
      hashSourceBytes(bytes) !== file.content_hash
    )
      throw new Error(
        `Persisted scan input failed integrity checks for ${file.path}`,
      );
  }

  const projects: RepositoryProjectState[] = [];
  for (const row of rows) {
    const project = row.project_json as RepositoryProjectState['project'];
    // The job lock prevents retention from deleting this job or its referenced snapshots.
    const snapshot = row.snapshot_id
      ? {
          ...(await loadSnapshotContentsInTransaction(
            db,
            String(row.snapshot_id),
          )),
          resourceProfile: 'repository' as const,
        }
      : undefined;
    const diagnostics = Array.isArray(row.diagnostics)
      ? (row.diagnostics as { code: string; message: string }[])
      : [];
    projects.push({
      project,
      status: String(row.status) as RepositoryProjectState['status'],
      ...(snapshot
        ? {
            snapshot: snapshot as NonNullable<
              RepositoryProjectState['snapshot']
            >,
          }
        : {}),
      ...(row.status === 'failed' && diagnostics[0]
        ? { error: diagnostics[0] }
        : {}),
    });
  }

  const sourceRows = inputRows.filter((file) => file.input_kind === 'source'),
    stored = job.session_json as Omit<
      RepositoryInvestigationSession,
      'repositoryId' | 'commitId' | 'objectFormat' | 'projects'
    > | null;
  if (stored) {
    const listed = stored.files;
    if (listed.length !== sourceRows.length)
      throw new Error(
        'Persistent viewer manifest differs from admitted source files',
      );
    const byPath = new Map(sourceRows.map((file) => [String(file.path), file]));
    for (const file of listed) {
      const actual = byPath.get(file.path);
      if (
        !actual ||
        actual.content_hash !== file.sha256 ||
        actual.git_blob_oid !== file.blobId ||
        Number(actual.byte_length) !== file.byteLength
      )
        throw new Error(
          'Persistent viewer manifest does not match pinned Git inputs',
        );
    }
  }
  const metadata =
    stored ??
    ({
      inventory: {
        complete: false,
        sourceFiles: sourceRows.length,
        sourceBytes: sourceRows.reduce(
          (total, file) => total + Number(file.byte_length),
          0,
        ),
        metadataFiles: inputRows.length - sourceRows.length,
        excluded: [],
      },
      files: sourceRows.map((file) => ({
        path: String(file.path),
        sha256: String(file.content_hash),
        blobId: String(file.git_blob_oid),
        byteLength: Number(file.byte_length),
        status: 'not_analyzed' as const,
        analysisReason: 'Persisted session summary is unavailable.',
        projectIds: [],
      })),
      diagnostics: [
        {
          code: 'SESSION_SUMMARY_UNAVAILABLE',
          message: 'This scan predates persistent viewer metadata.',
        },
      ],
      sourceCoverageComplete: false,
      contextComplete: false,
      analysisComplete: false,
      metrics: {
        acquisitionMs: 0,
        totalMs: 0,
        resultBytes: 0,
        memberships: 0,
        contextSourceBytes: 0,
        parentPeakRssBytes: 0,
        git: {
          subprocesses: 0,
          metadataChecks: 0,
          commitReads: 0,
          treeReads: 0,
          blobReads: 0,
          metadataBytes: 0,
          blobBytes: 0,
        },
      },
    } satisfies Omit<
      RepositoryInvestigationSession,
      'repositoryId' | 'commitId' | 'objectFormat' | 'projects'
    >);
  return {
    ...metadata,
    repositoryId: String(job.repository_id),
    commitId: String(job.git_commit_oid),
    objectFormat: job.git_object_format,
    projects,
  } as RepositoryInvestigationSession;
}
