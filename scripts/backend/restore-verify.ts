import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackendQueryService } from './query-service.ts';
import { connect, assertMigrations } from './database.ts';
import { localPostgresConnection } from './local-postgres-url.ts';
import { runPgRestore } from './postgres-tools.ts';
import { loadRepositorySession } from './session-persistence.ts';
import { loadSnapshot } from './snapshot-persistence.ts';
import { createInvestigation } from '@codethread/trace-engine';

export interface RoleGrantAudit {
  runtime_can_read: boolean;
  runtime_can_delete: boolean;
  runtime_can_create: boolean;
  runtime_can_prune: boolean;
  retention_can_prune: boolean;
  public_can_use_schema: boolean;
  public_can_create_schema: boolean;
  public_can_prune: boolean;
  runtime_can_write_migrations: boolean;
}

export async function queryRoleGrants(
  db: ReturnType<typeof connect>,
): Promise<RoleGrantAudit | undefined> {
  const roles = await db<RoleGrantAudit[]>`SELECT
    has_table_privilege('codethread_runtime','codethread.scan_job','SELECT') AS runtime_can_read,
    has_table_privilege('codethread_runtime','codethread.scan_job','DELETE') AS runtime_can_delete,
    has_schema_privilege('codethread_runtime','codethread','CREATE') AS runtime_can_create,
    has_function_privilege('codethread_runtime',
      'codethread.prune_inactive_data(timestamp with time zone,integer,integer,integer)',
      'EXECUTE') AS runtime_can_prune,
    has_function_privilege('codethread_retention',
      'codethread.prune_inactive_data(timestamp with time zone,integer,integer,integer)',
      'EXECUTE') AS retention_can_prune,
    has_schema_privilege('public','codethread','USAGE') AS public_can_use_schema,
    has_schema_privilege('public','codethread','CREATE') AS public_can_create_schema,
    has_function_privilege('public',
      'codethread.prune_inactive_data(timestamp with time zone,integer,integer,integer)',
      'EXECUTE') AS public_can_prune,
    (has_table_privilege('codethread_runtime','codethread.schema_migration','INSERT') OR
     has_table_privilege('codethread_runtime','codethread.schema_migration','UPDATE') OR
     has_table_privilege('codethread_runtime','codethread.schema_migration','DELETE')) AS runtime_can_write_migrations`;
  return roles[0];
}

export function assertRoleGrants(grants: RoleGrantAudit | undefined): void {
  if (
    !grants ||
    !grants.runtime_can_read ||
    grants.runtime_can_delete ||
    grants.runtime_can_create ||
    grants.runtime_can_prune ||
    !grants.retention_can_prune ||
    grants.public_can_use_schema ||
    grants.public_can_create_schema ||
    grants.public_can_prune ||
    grants.runtime_can_write_migrations
  )
    throw new Error('Restored runtime and retention role grants are unsafe');
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function verifyDatabase(db: ReturnType<typeof connect>) {
  await assertMigrations(db);
  const snapshots = await db`SELECT id FROM codethread.repository_snapshot
    WHERE state='published' ORDER BY id`;
  const snapshotSummaries: Record<string, unknown>[] = [];
  let verifiedFiles = 0,
    verifiedSymbols = 0,
    verifiedEvidence = 0,
    verifiedGraphs = 0;
  for (const row of snapshots) {
    const snapshotId = String(row.id),
      snapshot = await loadSnapshot(db, snapshotId),
      facts = snapshot.facts,
      sourceHashes = facts.files.map((file) => {
        const bytes = snapshot.source.readFile(file.id);
        if (!bytes) throw new Error('Restored source file is unavailable');
        return {
          path: file.path,
          declaredHash: file.contentHash,
          actualHash: digest(bytes),
        };
      });
    verifiedFiles += facts.files.length;
    verifiedSymbols += facts.symbols.length;
    const investigation = createInvestigation(facts, snapshot.source, {
      resourceProfile: 'repository',
    });
    const symbol = facts.symbols[0];
    if (symbol) {
      const graph = investigation.neighbors({
        snapshotId,
        symbolId: symbol.id,
      });
      if (graph.meta.snapshotId !== snapshotId)
        throw new Error('Restored graph query returned a different snapshot');
      verifiedGraphs++;
    }
    const evidenceId =
      symbol?.declarationEvidenceId ?? facts.evidenceRefs[0]?.id;
    if (evidenceId) {
      const evidence = investigation.sourceEvidence({
        snapshotId,
        evidenceIds: [evidenceId],
      }).items[0];
      if (!evidence || evidence.status !== 'available')
        throw new Error('Restored source evidence is unavailable');
      verifiedEvidence++;
    }
    snapshotSummaries.push({
      snapshotId,
      factsHash: digest(stableJson(facts)),
      sourceHashes,
      relationHash: digest(stableJson(facts.relations)),
      evidenceHash: digest(stableJson(facts.evidenceRefs)),
      capabilityHash: digest(stableJson(facts.coverageByCapability)),
    });
  }

  const representative =
    await db`SELECT p.scan_job_id,p.project_id,p.snapshot_id
    FROM codethread.scan_project p JOIN codethread.scan_job j
      ON j.id=p.scan_job_id
    WHERE p.status='ready' AND p.snapshot_id IS NOT NULL AND j.state='succeeded'
    ORDER BY p.snapshot_id::text COLLATE "C",p.scan_job_id::text COLLATE "C",
      p.project_id COLLATE "C" LIMIT 1`;
  let queryOutputs: unknown = null;
  if (representative[0]) {
    const {
      scan_job_id: jobId,
      project_id: projectId,
      snapshot_id: snapshotId,
    } = representative[0];
    const queries = new BackendQueryService(db, {
      async publishedSnapshot(selectedJobId, selectedProjectId) {
        const row = (
          await db`SELECT p.snapshot_id,p.status FROM codethread.scan_project p
            JOIN codethread.scan_job j ON j.id=p.scan_job_id
            WHERE p.scan_job_id=${selectedJobId}
              AND p.project_id=${selectedProjectId} AND j.state='succeeded'`
        )[0];
        if (!row || row.status !== 'ready' || !row.snapshot_id)
          throw new Error('Restored API project is unavailable');
        return String(row.snapshot_id);
      },
    });
    const symbolPage = await queries.symbols(String(jobId), String(projectId), {
      query: '',
      offset: 0,
      limit: 50,
    });
    const symbol = symbolPage.items[0];
    const neighbors = symbol
      ? await queries.project(String(jobId), String(projectId), 'neighbors', {
          snapshotId: String(snapshotId),
          symbolId: symbol.id,
          direction: 'outgoing',
          depth: 2,
          nodeLimit: 50,
        })
      : null;
    const snapshot = await loadSnapshot(db, String(snapshotId)),
      exact = snapshot.facts.relations.find(
        (relation) => relation.resolution.status === 'exact',
      ),
      paths =
        exact && exact.resolution.status === 'exact'
          ? await queries.project(String(jobId), String(projectId), 'paths', {
              snapshotId: String(snapshotId),
              fromSymbolId: exact.sourceSymbolId,
              toSymbolId: exact.resolution.targetId,
              depth: 2,
              nodeLimit: 50,
              pathLimit: 5,
            })
          : null,
      evidenceId = symbol?.declarationEvidenceId;
    const evidence = evidenceId
      ? await queries.project(String(jobId), String(projectId), 'evidence', {
          snapshotId: String(snapshotId),
          evidenceIds: [evidenceId],
        })
      : null;
    queryOutputs = { symbolPage, neighbors, paths, evidence };
  }

  const activeRows = await db`SELECT id,active_job_id FROM codethread.repository
    WHERE active_job_id IS NOT NULL ORDER BY id`;
  const activeSessions: Record<string, unknown>[] = [];
  for (const row of activeRows) {
    const session = await loadRepositorySession(db, String(row.active_job_id));
    activeSessions.push({
      repositoryId: String(row.id),
      activeJobId: String(row.active_job_id),
      commitId: session.commitId,
      objectFormat: session.objectFormat,
      inventory: session.inventory,
      files: session.files,
      diagnostics: session.diagnostics,
      sourceCoverageComplete: session.sourceCoverageComplete,
      contextComplete: session.contextComplete,
      analysisComplete: session.analysisComplete,
      metrics: session.metrics,
      projects: session.projects.map((project) => ({
        project: project.project,
        status: project.status,
        error: project.error ?? null,
        snapshotId: project.snapshot?.facts.snapshotId ?? null,
        factsHash: project.snapshot
          ? digest(stableJson(project.snapshot.facts))
          : null,
      })),
    });
  }
  const tableCountRows = await db`SELECT
    (SELECT count(*)::integer FROM codethread.repository) AS repository,
    (SELECT count(*)::integer FROM codethread.scan_job) AS scan_job,
    (SELECT count(*)::integer FROM codethread.scan_input_file) AS scan_input_file,
    (SELECT count(*)::integer FROM codethread.source_object) AS source_object,
    (SELECT count(*)::integer FROM codethread.repository_snapshot) AS repository_snapshot,
    (SELECT count(*)::integer FROM codethread.scan_project) AS scan_project,
    (SELECT count(*)::integer FROM codethread.snapshot_file) AS snapshot_file,
    (SELECT count(*)::integer FROM codethread.source_evidence) AS source_evidence,
    (SELECT count(*)::integer FROM codethread.code_symbol) AS code_symbol,
    (SELECT count(*)::integer FROM codethread.diagnostic) AS diagnostic,
    (SELECT count(*)::integer FROM codethread.code_relation) AS code_relation,
    (SELECT count(*)::integer FROM codethread.relation_evidence) AS relation_evidence,
    (SELECT count(*)::integer FROM codethread.snapshot_capability) AS snapshot_capability`;
  const [allRepos, allJobs, allSources] = await Promise.all([
    db`SELECT id,local_locator,desired_generation,active_job_id
      FROM codethread.repository ORDER BY id`,
    db`SELECT id,repository_id,generation,state,attempt,git_commit_oid,activation_result,error_code
      FROM codethread.scan_job ORDER BY id`,
    db`SELECT sha256,byte_length FROM codethread.source_object ORDER BY sha256`,
  ]);
  return {
    snapshots: snapshots.length,
    verifiedFiles,
    verifiedSymbols,
    verifiedEvidence,
    verifiedGraphs,
    activeInvestigations: activeRows.length,
    tableCounts: tableCountRows[0] ?? {},
    inventoryDigest: digest(
      stableJson({ repos: allRepos, jobs: allJobs, sources: allSources }),
    ),
    snapshotDigest: digest(stableJson(snapshotSummaries)),
    queryOutputDigest: digest(stableJson(queryOutputs)),
    activeSessionDigest: digest(stableJson(activeSessions)),
  };
}

async function main() {
  const archive = process.env.CODETHREAD_BACKUP_FILE,
    sourceUrl = process.env.CODETHREAD_BACKUP_DATABASE_URL,
    targetUrl = process.env.CODETHREAD_RESTORE_TEST_DATABASE_URL;
  if (!archive || !sourceUrl || !targetUrl)
    throw new Error(
      'CODETHREAD_BACKUP_FILE, CODETHREAD_BACKUP_DATABASE_URL and CODETHREAD_RESTORE_TEST_DATABASE_URL are required',
    );
  await access(archive);
  const source = localPostgresConnection(sourceUrl, 'Backup source'),
    target = localPostgresConnection(targetUrl, 'Restore target'),
    sourceDb = connect(source.url),
    db = connect(target.url);
  try {
    const existing = await db`SELECT to_regnamespace('codethread') AS schema`;
    if (existing[0]?.schema)
      throw new Error('Restore target already contains a CodeThread schema');
    const sourceSummary = await verifyDatabase(sourceDb);
    if (
      sourceSummary.snapshots === 0 &&
      process.env.CODETHREAD_RESTORE_ALLOW_EMPTY !== '1'
    )
      throw new Error(
        'Backup source contains no published snapshots to verify; set CODETHREAD_RESTORE_ALLOW_EMPTY=1 to allow empty-schema verification',
      );
    await runPgRestore(
      process.env.CODETHREAD_PG_RESTORE_BIN ?? 'pg_restore',
      [
        '--exit-on-error',
        '--no-owner',
        '--no-privileges',
        `--dbname=${target.env.PGDATABASE}`,
      ],
      archive,
      target.env,
    );
    await assertMigrations(db);
    await db.unsafe(
      await readFile(new URL('../../db/roles.sql', import.meta.url), 'utf8'),
    );
    const roleGrants = await queryRoleGrants(db);
    assertRoleGrants(roleGrants);
    const restoredSummary = await verifyDatabase(db);
    if (stableJson(sourceSummary) !== stableJson(restoredSummary))
      throw new Error(
        'Isolated restore differs from source snapshot/API/session evidence',
      );
    const verificationDigest = digest(
      stableJson({
        sourceSummary,
        restoredSummary,
        runtimeRoles: roleGrants,
      }),
    );
    console.log(
      JSON.stringify({
        status: 'verified',
        ...restoredSummary,
        roles: roleGrants,
        verificationDigest,
      }),
    );
  } finally {
    await sourceDb.end({ timeout: 5 });
    await db.end({ timeout: 5 });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
