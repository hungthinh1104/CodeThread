import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { COMPILER_PROFILE } from '@codethread/symbol-indexer';
import { acquireGitRepository } from '../git-source/repository-intake.ts';
import { analyzeGitRepository } from '../investigation/repository-session.ts';
import { allowedRepository, digest } from './config.ts';
import { requestHash } from './database.ts';
import type { Database } from './database.ts';
import { persistScan } from './scan-persistence.ts';
import { persistScanInputs, persistScanPin } from './scan-provenance.ts';

export class ServiceError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export type BackendConfig = {
  root: string;
  analyzerBuildHash: string;
  onPhase?: (
    phase: 'source_acquisition' | 'analysis' | 'persistence',
    durationMs: number,
  ) => void;
  onPhaseStart?: (
    phase: 'source_acquisition' | 'analysis' | 'persistence',
  ) => void;
};
const analyzerVersion = 'ct-index-001b/typescript-6.0.3';
const configurationHash = digest(
  JSON.stringify({
    compiler: COMPILER_PROFILE,
    resource: 'repository',
    planner: 'project-context-v1',
  }),
);

export class ScanService {
  private stopped = false;
  private workerRunning = false;
  private currentController: AbortController | null = null;
  private currentJobId: string | null = null;
  private readonly db: Database;
  private readonly config: BackendConfig;

  constructor(db: Database, config: BackendConfig) {
    this.db = db;
    this.config = config;
  }

  get workerReady(): boolean {
    return this.workerRunning && !this.stopped;
  }

  private async measure<T>(
    phase: 'source_acquisition' | 'analysis' | 'persistence',
    work: () => Promise<T>,
  ): Promise<T> {
    const started = performance.now();
    try {
      this.config.onPhaseStart?.(phase);
    } catch {
      // Optional phase observers must not alter scan outcomes.
    }
    try {
      return await work();
    } finally {
      try {
        this.config.onPhase?.(phase, performance.now() - started);
      } catch {
        // Optional observability must not alter scan outcomes.
      }
    }
  }

  async register(locator: string) {
    const safe = await allowedRepository(locator, this.config.root).catch(
      () => {
        throw new ServiceError(
          400,
          'INVALID_REPOSITORY',
          'Repository must exist inside configured root',
        );
      },
    );
    const id = randomUUID();
    await this.db`INSERT INTO codethread.repository(id,local_locator)
      VALUES(${id},${safe})`;
    return { id, locator: safe };
  }
  async repositories() {
    return this.db`SELECT id, local_locator AS locator, desired_generation,
      active_job_id FROM codethread.repository ORDER BY created_at DESC LIMIT 50`;
  }
  async repository(id: string) {
    const row = (
      await this.db`SELECT id,local_locator AS locator,desired_generation,
      active_job_id FROM codethread.repository WHERE id=${id}`
    )[0];
    if (!row) throw new ServiceError(404, 'NOT_FOUND', 'Repository not found');
    return row;
  }
  async accept(id: string, revision: string, idempotencyKey: string) {
    const reqHash = requestHash({
      repositoryId: id,
      revision,
      configurationHash,
      analyzerVersion,
      analyzerBuildHash: this.config.analyzerBuildHash,
      scope: 'repository',
    });
    return this.db.begin(async (tx) => {
      const db = tx as unknown as Database;
      const repo = (
        await db`SELECT id,desired_generation FROM codethread.repository
        WHERE id=${id} FOR UPDATE`
      )[0];
      if (!repo)
        throw new ServiceError(404, 'NOT_FOUND', 'Repository not found');
      const existing = (
        await db`SELECT id,request_hash,state FROM codethread.scan_job
        WHERE repository_id=${id} AND idempotency_key=${idempotencyKey}`
      )[0];
      if (existing) {
        if (existing.request_hash !== reqHash)
          throw new ServiceError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'Idempotency key belongs to a different request',
          );
        return {
          id: existing.id,
          repositoryId: id,
          state: existing.state,
          reused: true,
        };
      }
      const jobId = randomUUID(),
        generation = BigInt(repo.desired_generation) + 1n;
      await db`UPDATE codethread.repository SET desired_generation=${generation.toString()},
        updated_at=now() WHERE id=${id}`;
      await db`INSERT INTO codethread.scan_job (id,repository_id,generation,idempotency_key,
        request_hash,revision_selector,configuration_hash,analyzer_version,analyzer_build_hash,state)
        VALUES(${jobId},${id},${generation.toString()},${idempotencyKey},${reqHash},
          ${revision},${configurationHash},${analyzerVersion},
          ${this.config.analyzerBuildHash},'queued')`;
      return { id: jobId, repositoryId: id, state: 'queued', reused: false };
    });
  }
  async job(id: string) {
    const row = (
      await this
        .db`SELECT id,repository_id,generation,state,attempt,revision_selector,
      git_commit_oid,git_tree_oid,activation_result,error_code,error_message,created_at,updated_at
      FROM codethread.scan_job WHERE id=${id}`
    )[0];
    if (!row) throw new ServiceError(404, 'NOT_FOUND', 'Scan not found');
    return row;
  }
  async projects(jobId: string) {
    await this.job(jobId);
    return this
      .db`SELECT project_id,project_label,status,snapshot_id,diagnostics
      FROM codethread.scan_project WHERE scan_job_id=${jobId} ORDER BY project_label,project_id LIMIT 32`;
  }
  async files(jobId: string, offset: number) {
    await this.job(jobId);
    const count =
      (
        await this
          .db`SELECT count(*)::integer AS total FROM codethread.scan_input_file
      WHERE scan_job_id=${jobId}`
      )[0]?.total ?? 0;
    const items = await this.db`SELECT path,content_hash,git_blob_oid,git_mode
      FROM codethread.scan_input_file WHERE scan_job_id=${jobId}
      ORDER BY path COLLATE "C" LIMIT 50 OFFSET ${offset}`;
    return {
      items,
      total: count,
      nextOffset: offset + items.length < count ? offset + items.length : null,
    };
  }
  async publishedSnapshot(jobId: string, projectId: string) {
    const row = (
      await this.db`SELECT p.snapshot_id,p.status
      FROM codethread.scan_project p JOIN codethread.scan_job j ON j.id=p.scan_job_id
      WHERE p.scan_job_id=${jobId} AND p.project_id=${projectId}
        AND j.state='succeeded'`
    )[0];
    if (!row)
      throw new ServiceError(
        404,
        'NOT_FOUND',
        'Project or completed scan not found',
      );
    if (row.status !== 'ready' || !row.snapshot_id)
      throw new ServiceError(
        409,
        'PROJECT_NOT_READY',
        'Project context is not available for graph queries',
      );
    return row.snapshot_id as string;
  }
  async cancel(id: string) {
    const rows = await this
      .db`UPDATE codethread.scan_job SET state='cancelled',updated_at=now()
      WHERE id=${id} AND state IN ('queued','running') RETURNING id`;
    if (!rows.length)
      throw new ServiceError(
        409,
        'NOT_CANCELLABLE',
        'Scan is missing or terminal',
      );
    if (this.currentJobId === id) this.currentController?.abort();
    return { id, state: 'cancelled' };
  }
  async recover() {
    await this.db`UPDATE codethread.scan_job SET
      state=CASE WHEN git_commit_oid IS NULL THEN 'failed' ELSE 'queued' END,
      error_code=CASE WHEN git_commit_oid IS NULL THEN 'REVISION_NOT_PINNED' ELSE NULL END,
      error_message=CASE WHEN git_commit_oid IS NULL
        THEN 'Worker stopped before the revision was pinned; submit a new scan.' ELSE NULL END,
      updated_at=now()
      WHERE state='running'`;
  }
  private async processOne(): Promise<boolean> {
    const job = await this.db.begin(async (tx) => {
      const db = tx as unknown as Database;
      const row = (
        await db`SELECT j.id,j.repository_id,j.generation,j.revision_selector,
        j.attempt,j.git_object_format,j.git_commit_oid,j.git_tree_oid,
        r.local_locator FROM codethread.scan_job j JOIN codethread.repository r
          ON r.id=j.repository_id
        WHERE j.state='queued' ORDER BY j.created_at,j.id
        LIMIT 1 FOR UPDATE OF j SKIP LOCKED`
      )[0];
      if (!row) return null;
      const claimed = await db`UPDATE codethread.scan_job SET state='running',
        attempt=attempt+1,updated_at=now() WHERE id=${row.id}
        RETURNING attempt`;
      return {
        id: row.id as string,
        repository_id: row.repository_id as string,
        generation: String(row.generation),
        revision_selector: row.revision_selector as string,
        attempt: Number(claimed[0]!.attempt),
        git_object_format: row.git_object_format as 'sha1' | 'sha256' | null,
        git_commit_oid: row.git_commit_oid as string | null,
        git_tree_oid: row.git_tree_oid as string | null,
        local_locator: row.local_locator as string,
      };
    });
    if (!job) return false;
    const controller = new AbortController();
    this.currentController = controller;
    this.currentJobId = job.id as string;
    const generation = String(job.generation),
      attempt = Number(job.attempt),
      pinnedCommit = job.git_commit_oid as string | null,
      pin = pinnedCommit
        ? {
            commitId: pinnedCommit,
            rootTreeId: job.git_tree_oid as string,
            objectFormat: job.git_object_format as 'sha1' | 'sha256',
          }
        : null;
    try {
      const locator = await allowedRepository(
        job.local_locator as string,
        this.config.root,
      );
      const request = {
        repositoryPath: locator,
        repositoryId: job.repository_id as string,
        revision: pin?.commitId ?? (job.revision_selector as string),
        signal: controller.signal,
      };
      let resolvedPin: {
        commitId: string;
        rootTreeId: string;
        objectFormat: 'sha1' | 'sha256';
      } | null = null;
      const acquired = await this.measure('source_acquisition', () =>
        acquireGitRepository(request, () => {}, {
          onPinned: async (resolved) => {
            await persistScanPin(
              this.db,
              job.id as string,
              job.repository_id as string,
              generation,
              attempt,
              resolved,
            );
            resolvedPin = resolved;
          },
          onFilesAcquired: async (files, sourcePaths) => {
            if (!resolvedPin)
              throw new Error(
                'Git source inventory completed before revision pinning',
              );
            await persistScanInputs(
              this.db,
              job.id as string,
              job.repository_id as string,
              generation,
              attempt,
              resolvedPin,
              files,
              new Set(sourcePaths),
            );
          },
        }),
      );
      const session = await this.measure('analysis', () =>
        analyzeGitRepository(
          {
            ...request,
            revision: acquired.commitId,
          },
          acquired,
        ),
      );
      await this.measure('persistence', () =>
        persistScan(
          this.db,
          job.id as string,
          job.repository_id as string,
          acquired,
          session,
          generation,
          attempt,
        ),
      );
    } catch (e) {
      const code =
        e instanceof Error && 'code' in e && typeof e.code === 'string'
          ? e.code
          : 'ANALYSIS_FAILED';
      const message =
        e instanceof Error ? e.message.slice(0, 256) : 'Scan failed';
      await this.db`UPDATE codethread.scan_job SET state='failed',
        error_code=${code},error_message=${message},updated_at=now()
        WHERE id=${job.id} AND generation=${generation}::bigint
          AND attempt=${attempt} AND state='running'`;
    } finally {
      this.currentController = null;
      this.currentJobId = null;
    }
    return true;
  }
  async run(): Promise<void> {
    this.workerRunning = true;
    try {
      while (!this.stopped) {
        try {
          if (await this.processOne()) continue;
        } catch (e) {
          console.error('Scan worker error', e);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } finally {
      this.workerRunning = false;
    }
  }
  stop() {
    this.stopped = true;
    this.currentController?.abort();
  }
}
