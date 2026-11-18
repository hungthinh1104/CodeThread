import type { Database } from './database.ts';

export async function readQueuedScanForClaim(db: Database, jobId?: string) {
  const rows =
    await db`SELECT j.id,j.repository_id,j.generation,j.revision_selector,
    j.attempt,j.git_object_format,j.git_commit_oid,j.git_tree_oid,j.analyzer_build_hash,j.analyzer_version,
    r.local_locator FROM codethread.scan_job j JOIN codethread.repository r
      ON r.id=j.repository_id
    WHERE j.state='queued' ${jobId === undefined ? db`` : db`AND j.id=${jobId}`}
    ORDER BY j.created_at,j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED`;
  return rows[0];
}

export async function markScanRunning(
  db: Database,
  jobId: string,
): Promise<number> {
  const [claimed] = await db`UPDATE codethread.scan_job SET state='running',
    attempt=attempt+1,error_code=NULL,error_message=NULL,updated_at=now() WHERE id=${jobId}
    RETURNING attempt`;
  if (!claimed) throw new Error('Worker claim did not update the queued job');
  return Number(claimed.attempt);
}
