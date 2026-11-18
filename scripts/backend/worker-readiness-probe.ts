import { randomUUID } from 'node:crypto';
import { ANALYZER_VERSION } from '@codethread/symbol-indexer';
import { digest } from './config.ts';
import type { Database } from './database.ts';

// Exercise representative worker writes inside a transaction that always rolls back.
export async function probeWorkerWrites(
  sql: Database,
  buildHash: string,
): Promise<void> {
  const rollback = new Error('Rollback readiness probe');
  const repositoryId = randomUUID(),
    jobId = randomUUID(),
    snapshotId = randomUUID();
  const fileId = randomUUID(),
    evidenceId = randomUUID(),
    symbolId = randomUUID(),
    relationId = randomUUID();
  const zero = '0'.repeat(64),
    gitOid = '0'.repeat(40),
    emptyHash = digest('');
  try {
    await sql.begin(async (tx) => {
      const db = tx as unknown as Database;
      await db`SET LOCAL statement_timeout='5s'`;
      await db`SET LOCAL lock_timeout='3s'`;
      await db`INSERT INTO codethread.repository(id,local_locator,desired_generation)
        VALUES(${repositoryId},'readiness-probe',1)`;
      await db`INSERT INTO codethread.scan_job
        (id,repository_id,generation,idempotency_key,request_hash,revision_selector,
         configuration_hash,analyzer_version,analyzer_build_hash,state)
        VALUES(${jobId},${repositoryId},1,${jobId},${zero},'probe',${zero},
          ${ANALYZER_VERSION},${buildHash},'queued')`;
      const claimable = await db`SELECT j.id,j.repository_id,j.generation,
          j.revision_selector,j.attempt,j.git_object_format,j.git_commit_oid,
          j.git_tree_oid,j.analyzer_build_hash,j.analyzer_version,r.local_locator
        FROM codethread.scan_job j JOIN codethread.repository r
          ON r.id=j.repository_id
        WHERE j.id=${jobId} AND j.state='queued'
        LIMIT 1 FOR UPDATE OF j SKIP LOCKED`;
      if (!claimable.length)
        throw new Error(
          'Worker claim readiness probe could not read queued work',
        );
      await db`UPDATE codethread.scan_job SET state='running',attempt=1 WHERE id=${jobId}`;
      await db`UPDATE codethread.scan_job SET git_object_format='sha1',git_commit_oid=${gitOid},
        git_tree_oid=${gitOid} WHERE id=${jobId}`;
      await db`INSERT INTO codethread.source_object(sha256,bytes,byte_length)
        VALUES(${emptyHash},${Buffer.alloc(0)},0) ON CONFLICT (sha256) DO NOTHING`;
      await db`INSERT INTO codethread.scan_input_file
        (scan_job_id,path,git_blob_oid,git_mode,content_hash,input_kind)
        VALUES(${jobId},'probe.ts',${gitOid},'100644',${emptyHash},'source')`;
      await db`INSERT INTO codethread.repository_snapshot
        (id,repository_id,source_fingerprint,analyzer_version,analyzer_build_hash,
         configuration_hash,coverage,facts_json)
        VALUES(${snapshotId},${repositoryId},${zero},${ANALYZER_VERSION},${buildHash},
          ${zero},'not_analyzed','{}'::jsonb)`;
      await db`INSERT INTO codethread.snapshot_file(snapshot_id,id,path,content_hash,byte_length)
        VALUES(${snapshotId},${fileId},'probe.ts',${emptyHash},0)`;
      await db`INSERT INTO codethread.source_evidence
        (snapshot_id,id,file_id,content_hash,start_utf16,end_utf16,range_json,kind,extractor_name,extractor_version)
        VALUES(${snapshotId},${evidenceId},${fileId},${emptyHash},0,0,'{}'::jsonb,'probe','probe','1')`;
      await db`INSERT INTO codethread.code_symbol
        (snapshot_id,id,file_id,canonical_key,name,kind,declaration_evidence_id,symbol_json)
        VALUES(${snapshotId},${symbolId},${fileId},'probe','probe','function',${evidenceId},'{}'::jsonb)`;
      await db`INSERT INTO codethread.diagnostic(snapshot_id,id,file_id,code,severity,message)
        VALUES(${snapshotId},${randomUUID()},${fileId},'probe','info','probe')`;
      await db`INSERT INTO codethread.code_relation
        (snapshot_id,id,canonical_key,source_symbol_id,target_symbol_id,kind,resolution,site_evidence_id)
        VALUES(${snapshotId},${relationId},'probe',${symbolId},${symbolId},'calls','exact',${evidenceId})`;
      await db`INSERT INTO codethread.relation_evidence(snapshot_id,relation_id,evidence_id)
        VALUES(${snapshotId},${relationId},${evidenceId})`;
      await db`INSERT INTO codethread.snapshot_capability(snapshot_id,capability_key,coverage)
        VALUES(${snapshotId},'readiness-probe','not_analyzed')`;
      await db`UPDATE codethread.repository_snapshot SET state='published',published_at=now()
        WHERE id=${snapshotId}`;
      await db`INSERT INTO codethread.scan_project
        (repository_id,scan_job_id,project_id,project_label,project_json,status,snapshot_id,diagnostics)
        VALUES(${repositoryId},${jobId},'readiness-probe','readiness-probe','{}'::jsonb,'ready',${snapshotId},'[]'::jsonb)`;
      await db`UPDATE codethread.scan_job SET state='succeeded',activation_result='activated' WHERE id=${jobId}`;
      await db`UPDATE codethread.repository SET active_job_id=${jobId} WHERE id=${repositoryId}`;
      await db`SET CONSTRAINTS ALL IMMEDIATE`;
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}
