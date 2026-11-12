import { randomUUID } from 'node:crypto';
import { COMPILER_PROFILE } from '@codethread/symbol-indexer';
import { acquireGitRepository } from '../git-source/repository-intake.ts';
import { analyzeGitRepository } from '../investigation/repository-session.ts';
import { allowedRepository, digest } from './config.ts';
import { requestHash } from './database.ts';
import type { Database } from './database.ts';
import { persistScan } from './persistence.ts';

export class ServiceError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}
export type BackendConfig = {
  root: string; analyzerBuildHash: string;
};
const analyzerVersion = 'ct-index-001b/typescript-6.0.3';
const configurationHash = digest(JSON.stringify({ compiler: COMPILER_PROFILE,
  resource: 'repository', planner: 'project-context-v1' }));

export class ScanService {
  private stopped = false;
  private currentController: AbortController | null = null;
  constructor(private readonly db: Database, private readonly config: BackendConfig) {}

  async register(locator: string) {
    const safe = await allowedRepository(locator, this.config.root).catch(() => {
      throw new ServiceError(400,'INVALID_REPOSITORY','Repository must exist inside configured root');
    });
    const id = randomUUID();
    await this.db`INSERT INTO codethread.repository(id,local_locator)
      VALUES(${id},${safe})`;
    return {id,locator:safe};
  }
  async repositories() {
    return this.db`SELECT id, local_locator AS locator, desired_generation,
      active_job_id FROM codethread.repository ORDER BY created_at DESC LIMIT 50`;
  }
  async repository(id: string) {
    const row = (await this.db`SELECT id,local_locator AS locator,desired_generation,
      active_job_id FROM codethread.repository WHERE id=${id}`)[0];
    if (!row) throw new ServiceError(404,'NOT_FOUND','Repository not found');
    return row;
  }
  async accept(id: string, revision: string, idempotencyKey: string) {
    const reqHash = requestHash({ repositoryId:id, revision, configurationHash,
      analyzerVersion, analyzerBuildHash:this.config.analyzerBuildHash, scope:'repository' });
    return this.db.begin(async tx => {
      const db=tx as unknown as Database;
      const repo=(await db`SELECT id,desired_generation FROM codethread.repository
        WHERE id=${id} FOR UPDATE`)[0];
      if (!repo) throw new ServiceError(404,'NOT_FOUND','Repository not found');
      const existing=(await db`SELECT id,request_hash,state FROM codethread.scan_job
        WHERE repository_id=${id} AND idempotency_key=${idempotencyKey}`)[0];
      if (existing) {
        if (existing.request_hash !== reqHash)
          throw new ServiceError(409,'IDEMPOTENCY_CONFLICT','Idempotency key belongs to a different request');
        return {id:existing.id,repositoryId:id,state:existing.state,reused:true};
      }
      const jobId=randomUUID(),generation=BigInt(repo.desired_generation)+1n;
      await db`UPDATE codethread.repository SET desired_generation=${generation.toString()},
        updated_at=now() WHERE id=${id}`;
      await db`INSERT INTO codethread.scan_job (id,repository_id,generation,idempotency_key,
        request_hash,revision_selector,configuration_hash,analyzer_version,analyzer_build_hash,state)
        VALUES(${jobId},${id},${generation.toString()},${idempotencyKey},${reqHash},
          ${revision},${configurationHash},${analyzerVersion},
          ${this.config.analyzerBuildHash},'queued')`;
      return {id:jobId,repositoryId:id,state:'queued',reused:false};
    });
  }
  async job(id: string) {
    const row=(await this.db`SELECT id,repository_id,generation,state,attempt,revision_selector,
      git_commit_oid,git_tree_oid,activation_result,error_code,error_message,created_at,updated_at
      FROM codethread.scan_job WHERE id=${id}`)[0];
    if (!row) throw new ServiceError(404,'NOT_FOUND','Scan not found');
    return row;
  }
  async projects(jobId: string) {
    await this.job(jobId);
    return this.db`SELECT project_id,project_label,status,snapshot_id,diagnostics
      FROM codethread.scan_project WHERE scan_job_id=${jobId} ORDER BY project_label,project_id LIMIT 32`;
  }
  async files(jobId: string,offset: number) {
    await this.job(jobId);
    const count=(await this.db`SELECT count(*)::integer AS total FROM codethread.scan_input_file
      WHERE scan_job_id=${jobId}`)[0]?.total ?? 0;
    const items=await this.db`SELECT path,content_hash,git_blob_oid,git_mode
      FROM codethread.scan_input_file WHERE scan_job_id=${jobId}
      ORDER BY path LIMIT 50 OFFSET ${offset}`;
    return {items,total:count,nextOffset:offset+items.length<count?offset+items.length:null};
  }
  async publishedSnapshot(jobId: string,projectId: string) {
    const row=(await this.db`SELECT p.snapshot_id,p.status
      FROM codethread.scan_project p JOIN codethread.scan_job j ON j.id=p.scan_job_id
      WHERE p.scan_job_id=${jobId} AND p.project_id=${projectId}
        AND j.state='succeeded'`)[0];
    if (!row) throw new ServiceError(404,'NOT_FOUND','Project or completed scan not found');
    if (row.status !== 'ready' || !row.snapshot_id)
      throw new ServiceError(409,'PROJECT_NOT_READY','Project context is not available for graph queries');
    return row.snapshot_id as string;
  }
  async cancel(id: string) {
    const rows=await this.db`UPDATE codethread.scan_job SET state='cancelled',updated_at=now()
      WHERE id=${id} AND state IN ('queued','running') RETURNING id`;
    if (!rows.length) throw new ServiceError(409,'NOT_CANCELLABLE','Scan is missing or terminal');
    this.currentController?.abort();
    return {id,state:'cancelled'};
  }
  async recover() {
    // A single DB advisory lock protects the worker; after a crash, running jobs are safe to retry.
    await this.db`UPDATE codethread.scan_job SET state='queued',updated_at=now()
      WHERE state='running'`;
  }
  private async processOne(): Promise<boolean> {
    const job=await this.db.begin(async tx => {
      const db=tx as unknown as Database;
      const row=(await db`SELECT j.id,j.repository_id,j.generation,j.revision_selector,
        r.local_locator FROM codethread.scan_job j JOIN codethread.repository r
          ON r.id=j.repository_id
        WHERE j.state='queued' ORDER BY j.created_at,j.id
        LIMIT 1 FOR UPDATE OF j SKIP LOCKED`)[0];
      if (!row) return null;
      await db`UPDATE codethread.scan_job SET state='running',attempt=attempt+1,
        updated_at=now() WHERE id=${row.id}`;
      return row;
    });
    if (!job) return false;
    const controller=new AbortController();
    this.currentController=controller;
    try {
      const locator=await allowedRepository(job.local_locator as string,this.config.root);
      const request={repositoryPath:locator,repositoryId:job.repository_id as string,
        revision:job.revision_selector as string,signal:controller.signal};
      const acquired=await acquireGitRepository(request);
      // Always resolve subsequent analysis using the exact acquired commit, not a moving ref.
      const session=await analyzeGitRepository({...request,revision:acquired.commitId});
      await persistScan(this.db,job.id as string,job.repository_id as string,
        acquired,session,Number(job.generation));
    } catch(e) {
      const code=e instanceof Error && 'code' in e && typeof e.code==='string'
        ? e.code : 'ANALYSIS_FAILED';
      const message= e instanceof Error ? e.message.slice(0,256) : 'Scan failed';
      await this.db`UPDATE codethread.scan_job SET state='failed',
        error_code=${code},error_message=${message},updated_at=now()
        WHERE id=${job.id} AND state='running'`;
    } finally {
      this.currentController=null;
    }
    return true;
  }
  async run(): Promise<void> {
    while (!this.stopped) {
      try {
        if (await this.processOne()) continue;
      } catch(e) {
        console.error('Scan worker error',e);
      }
      await new Promise(resolve=>setTimeout(resolve,500));
    }
  }
  stop() { this.stopped=true; this.currentController?.abort(); }
}
