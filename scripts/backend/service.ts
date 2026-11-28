import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  ANALYZER_VERSION,
  analyzerBuildHash,
  COMPILER_PROFILE,
} from '@codethread/symbol-indexer';
import { PostgresError } from 'postgres';
import { acquireGitRepository } from '../git-source/repository-intake.ts';
import { analyzeGitRepository } from '../investigation/repository-session.ts';
import { allowedRepository, digest } from './config.ts';
import { requestHash } from './database.ts';
import type { Database } from './database.ts';
import type { WorkerLease } from './worker-lease.ts';
import { persistScan } from './scan-persistence.ts';
import { persistScanInputs, persistScanPin } from './scan-provenance.ts';
import { markScanRunning, readQueuedScanForClaim } from './worker-claim.ts';
import { probeWorkerWrites } from './worker-readiness-probe.ts';

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
const analyzerVersion = ANALYZER_VERSION;
const MAX_OUTSTANDING_SCANS = 32;
const MAX_WORKER_FAILURES = 3;
const MAX_SETTLEMENT_ATTEMPTS = 5;
const MAX_SCAN_ATTEMPTS = 5;
const CLAIM_DEADLINE_MS = 7_000;
const DATABASE_WORK_DEADLINE_MS = 15_000;
const RECOVERY_PROBE_INTERVAL_MS = 5_000;
const PERIODIC_PROBE_INTERVAL_MS = 30_000;
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
  private workerPolled = false;
  private workerProbed = false;
  private workerFailures = 0;
  private claimFailed = false;
  private processingFailure = false;
  private installationInvalid = false;
  private claimStartedAt: number | null = null;
  private databaseDeadline: number | null = null;
  private nextRecoveryProbe = 0;
  private nextBuildCheck = 0;
  private nextPeriodicProbe = 0;
  private pendingFailure: {
    id: string;
    generation: string;
    attempt: number;
    code: string;
    message: string;
    retry: boolean;
    attempts: number;
  } | null = null;
  private currentController: AbortController | null = null;
  private currentJobId: string | null = null;
  private readonly db: Database;
  private readonly config: BackendConfig;
  private readonly worker: WorkerLease | undefined;

  constructor(db: Database, config: BackendConfig, worker?: WorkerLease) {
    if (config.analyzerBuildHash !== analyzerBuildHash())
      throw new Error(
        'Analyzer build identity does not match installed analyzer',
      );
    this.db = db;
    this.config = config;
    this.worker = worker;
    worker?.signal.addEventListener('abort', () => this.stop(), { once: true });
  }

  get workerReady(): boolean {
    return (
      this.workerRunning &&
      this.workerPolled &&
      this.workerProbed &&
      !this.stopped &&
      !!this.worker?.active &&
      this.workerFailures < MAX_WORKER_FAILURES &&
      !this.installationInvalid &&
      (this.databaseDeadline === null ||
        performance.now() < this.databaseDeadline) &&
      (this.claimStartedAt === null ||
        performance.now() - this.claimStartedAt < CLAIM_DEADLINE_MS)
    );
  }

  private workerDatabase(): Database {
    if (!this.worker?.active)
      throw new Error('Active worker lease is required');
    return this.worker.db;
  }

  private verifyCurrentBuild(): boolean {
    try {
      this.installationInvalid =
        analyzerBuildHash() !== this.config.analyzerBuildHash;
    } catch {
      this.installationInvalid = true;
    }
    return !this.installationInvalid;
  }

  private async databaseWork<T>(
    work: () => Promise<T>,
    timeout = DATABASE_WORK_DEADLINE_MS,
  ): Promise<T> {
    this.databaseDeadline = performance.now() + timeout;
    try {
      return await work();
    } finally {
      this.databaseDeadline = null;
    }
  }

  private async checkWorkerWrites(): Promise<void> {
    try {
      await this.databaseWork(
        () =>
          probeWorkerWrites(
            this.workerDatabase(),
            this.config.analyzerBuildHash,
          ),
        CLAIM_DEADLINE_MS,
      );
      this.workerProbed = true;
      this.nextPeriodicProbe = performance.now() + PERIODIC_PROBE_INTERVAL_MS;
    } catch (error) {
      this.workerProbed = false;
      throw error;
    }
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
  async repositoryScans(repositoryId: string) {
    await this.repository(repositoryId);
    return this
      .db`SELECT id,repository_id,generation,state,attempt,revision_selector,
      git_commit_oid,git_tree_oid,activation_result,error_code,error_message,created_at,updated_at
      FROM codethread.scan_job WHERE repository_id=${repositoryId}
      ORDER BY created_at DESC, id DESC LIMIT 25`;
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
        await db`SELECT id,request_hash,state,analyzer_version,analyzer_build_hash FROM codethread.scan_job
        WHERE repository_id=${id} AND idempotency_key=${idempotencyKey}`
      )[0];
      if (existing) {
        const originalBuildRequestHash = requestHash({
          repositoryId: id,
          revision,
          configurationHash,
          analyzerVersion: existing.analyzer_version,
          analyzerBuildHash: existing.analyzer_build_hash,
          scope: 'repository',
        });
        if (existing.request_hash !== originalBuildRequestHash)
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
      if (!this.verifyCurrentBuild())
        throw new ServiceError(
          503,
          'ANALYZER_BUILD_MISMATCH',
          'Installed analyzer build is unavailable',
        );
      // Admission is global, so serialize submissions from different repositories.
      await db`SELECT pg_advisory_xact_lock(1919606128, 1)`;
      const outstanding = Number(
        (
          await db`SELECT count(*)::integer AS total FROM codethread.scan_job
            WHERE state IN ('queued','running')`
        )[0]?.total ?? 0,
      );
      if (outstanding >= MAX_OUTSTANDING_SCANS)
        throw new ServiceError(
          429,
          'SCAN_QUEUE_FULL',
          'The scan queue is full; retry after a scan completes or is cancelled.',
        );
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
  async publishedSnapshot(jobId: string, projectId: string, db = this.db) {
    const row = (
      await db`SELECT p.snapshot_id,p.status
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
    const db = this.workerDatabase();
    await db`UPDATE codethread.scan_job SET state='failed',
      error_code='RETRY_LIMIT_EXCEEDED',
      error_message='Pinned scan exhausted its retry limit.',updated_at=now()
      WHERE state='queued' AND attempt >= ${MAX_SCAN_ATTEMPTS}`;
    await db`UPDATE codethread.scan_job SET
      state=CASE WHEN git_commit_oid IS NULL OR attempt >= ${MAX_SCAN_ATTEMPTS} THEN 'failed' ELSE 'queued' END,
      error_code=CASE WHEN git_commit_oid IS NULL THEN 'REVISION_NOT_PINNED'
        WHEN attempt >= ${MAX_SCAN_ATTEMPTS} THEN 'RETRY_LIMIT_EXCEEDED' ELSE NULL END,
      error_message=CASE WHEN git_commit_oid IS NULL
        THEN 'Worker stopped before the revision was pinned; submit a new scan.'
        WHEN attempt >= ${MAX_SCAN_ATTEMPTS} THEN 'Pinned scan exhausted its retry limit.' ELSE NULL END,
      updated_at=now()
      WHERE state='running'`;
  }
  private async settleFailure(): Promise<void> {
    const failure = this.pendingFailure;
    if (!failure) return;
    failure.attempts++;
    await this.databaseWork(
      () => this.workerDatabase()`UPDATE codethread.scan_job SET
      state=CASE WHEN ${failure.retry} AND git_commit_oid IS NOT NULL
        AND attempt < ${MAX_SCAN_ATTEMPTS} THEN 'queued' ELSE 'failed' END,
      error_code=${failure.code},error_message=${failure.message},updated_at=now()
      WHERE id=${failure.id} AND generation=${failure.generation}::bigint
        AND attempt=${failure.attempt} AND state='running'`,
      CLAIM_DEADLINE_MS,
    );
    this.pendingFailure = null;
  }

  private async processOne(): Promise<'idle' | 'completed' | 'failed'> {
    const workerDb = this.workerDatabase();
    if (this.pendingFailure) {
      await this.settleFailure();
      return 'failed';
    }
    this.claimStartedAt = performance.now();
    const job = await workerDb
      .begin(async (tx) => {
        const db = tx as unknown as Database;
        const row = await readQueuedScanForClaim(db);
        if (!row) return null;
        if (Number(row.attempt) >= MAX_SCAN_ATTEMPTS) {
          await db`UPDATE codethread.scan_job SET state='failed',
            error_code='RETRY_LIMIT_EXCEEDED',error_message='Scan exhausted its retry limit.',
            updated_at=now() WHERE id=${row.id} AND state='queued'`;
          return { exhausted: true as const };
        }
        const attempt = await markScanRunning(db, row.id as string);
        return {
          id: row.id as string,
          repository_id: row.repository_id as string,
          generation: String(row.generation),
          revision_selector: row.revision_selector as string,
          attempt,
          git_object_format: row.git_object_format as 'sha1' | 'sha256' | null,
          git_commit_oid: row.git_commit_oid as string | null,
          git_tree_oid: row.git_tree_oid as string | null,
          local_locator: row.local_locator as string,
          analyzer_build_hash: row.analyzer_build_hash as string,
          analyzer_version: row.analyzer_version as string,
        };
      })
      .catch((error) => {
        this.claimFailed = true;
        throw error;
      })
      .finally(() => {
        this.claimStartedAt = null;
      });
    this.workerPolled = true;
    if (!job) return 'idle';
    if ('exhausted' in job) return 'failed';
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
      if (
        job.analyzer_build_hash !== this.config.analyzerBuildHash ||
        job.analyzer_version !== analyzerVersion ||
        !this.verifyCurrentBuild()
      )
        throw Object.assign(
          new Error('Accepted analyzer build is unavailable'),
          {
            code: 'ANALYZER_BUILD_MISMATCH',
          },
        );
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
            await this.databaseWork(() =>
              persistScanPin(
                workerDb,
                job.id as string,
                job.repository_id as string,
                generation,
                attempt,
                resolved,
              ),
            );
            resolvedPin = resolved;
          },
          onFilesAcquired: async (files, sourcePaths) => {
            if (!resolvedPin)
              throw new Error(
                'Git source inventory completed before revision pinning',
              );
            const inputPin = resolvedPin;
            await this.databaseWork(() =>
              persistScanInputs(
                workerDb,
                job.id as string,
                job.repository_id as string,
                generation,
                attempt,
                inputPin,
                files,
                new Set(sourcePaths),
              ),
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
        this.databaseWork(() =>
          persistScan(
            workerDb,
            job.id as string,
            job.repository_id as string,
            acquired,
            session,
            generation,
            attempt,
          ),
        ),
      );
      return 'completed';
    } catch (e) {
      this.verifyCurrentBuild();
      if (e instanceof PostgresError) this.processingFailure = true;
      const code =
        e instanceof Error && 'code' in e && typeof e.code === 'string'
          ? e.code
          : 'ANALYSIS_FAILED';
      const message =
        e instanceof Error ? e.message.slice(0, 256) : 'Scan failed';
      if (!this.stopped && this.worker?.active) {
        this.pendingFailure = {
          id: job.id,
          generation,
          attempt,
          code,
          message,
          retry: e instanceof PostgresError,
          attempts: 0,
        };
        await this.settleFailure();
      }
      if (e instanceof PostgresError) {
        throw e;
      }
      return 'failed';
    } finally {
      this.currentController = null;
      this.currentJobId = null;
    }
  }
  async run(): Promise<void> {
    this.workerDatabase();
    if (this.workerRunning) throw new Error('Scan worker is already running');
    this.workerRunning = true;
    try {
      while (!this.stopped) {
        try {
          if (!this.workerProbed) {
            if (performance.now() < this.nextRecoveryProbe) {
              await new Promise((resolve) => setTimeout(resolve, 500));
              continue;
            }
            this.nextRecoveryProbe =
              performance.now() + RECOVERY_PROBE_INTERVAL_MS;
            await this.checkWorkerWrites();
          }
          const result = await this.processOne();
          if (result === 'completed') {
            this.workerFailures = 0;
            this.processingFailure = false;
          } else if (result === 'idle' && !this.processingFailure) {
            this.workerFailures = 0;
            if (performance.now() >= this.nextBuildCheck) {
              this.nextBuildCheck =
                performance.now() + RECOVERY_PROBE_INTERVAL_MS;
              this.verifyCurrentBuild();
            }
            if (performance.now() >= this.nextPeriodicProbe)
              await this.checkWorkerWrites();
          } else if (
            result === 'idle' &&
            performance.now() >= this.nextRecoveryProbe
          ) {
            this.nextRecoveryProbe =
              performance.now() + RECOVERY_PROBE_INTERVAL_MS;
            await this.checkWorkerWrites();
            this.processingFailure = false;
            this.workerFailures = 0;
          }
          if (result !== 'idle') continue;
        } catch (e) {
          if (this.claimFailed) {
            this.claimFailed = false;
            this.workerProbed = false;
            this.workerPolled = false;
            this.nextRecoveryProbe =
              performance.now() + RECOVERY_PROBE_INTERVAL_MS;
          }
          this.workerFailures = Math.min(
            MAX_WORKER_FAILURES,
            this.workerFailures + 1,
          );
          console.error('Scan worker error', e);
          if ((this.pendingFailure?.attempts ?? 0) >= MAX_SETTLEMENT_ATTEMPTS) {
            this.stop();
            break;
          }
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
