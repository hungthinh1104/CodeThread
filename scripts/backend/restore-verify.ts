import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { BackendQueryService } from './query-service.ts';
import { connect, assertMigrations } from './database.ts';
import { runPgRestore } from './postgres-tools.ts';
import { loadRepositorySession } from './session-persistence.ts';
import { loadSnapshot } from './snapshot-persistence.ts';
import { createInvestigation } from '@codethread/trace-engine';

function restoreEnvironment(raw: string) {
  const url = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(url.protocol))
    throw new Error('A PostgreSQL restore URL is required');
  if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname.toLowerCase()))
    throw new Error('Restore target must be an isolated loopback database');
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!database) throw new Error('Restore target database name is missing');
  return {
    env: {
      ...process.env,
      PGHOST: url.hostname,
      PGPORT: url.port || '5432',
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
      PGDATABASE: database,
      PGSSLMODE: url.searchParams.get('sslmode') ?? 'disable',
    },
  };
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
        snapshotId: project.snapshot?.facts.snapshotId ?? null,
        factsHash: project.snapshot
          ? digest(stableJson(project.snapshot.facts))
          : null,
      })),
    });
  }
  return {
    snapshots: snapshots.length,
    verifiedFiles,
    verifiedSymbols,
    verifiedEvidence,
    verifiedGraphs,
    activeInvestigations: activeRows.length,
    snapshotDigest: digest(stableJson(snapshotSummaries)),
    queryOutputDigest: digest(stableJson(queryOutputs)),
    activeSessionDigest: digest(stableJson(activeSessions)),
  };
}

const archive = process.env.CODETHREAD_BACKUP_FILE,
  sourceUrl = process.env.CODETHREAD_BACKUP_DATABASE_URL,
  targetUrl = process.env.CODETHREAD_RESTORE_TEST_DATABASE_URL;
if (!archive || !sourceUrl || !targetUrl)
  throw new Error(
    'CODETHREAD_BACKUP_FILE, CODETHREAD_BACKUP_DATABASE_URL and CODETHREAD_RESTORE_TEST_DATABASE_URL are required',
  );
await access(archive);
const target = restoreEnvironment(targetUrl),
  sourceDb = connect(sourceUrl),
  db = connect(targetUrl);
try {
  const existing = await db`SELECT to_regnamespace('codethread') AS schema`;
  if (existing[0]?.schema)
    throw new Error('Restore target already contains a CodeThread schema');
  const sourceSummary = await verifyDatabase(sourceDb);
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
  const roles = await db`SELECT
    has_table_privilege('codethread_runtime','codethread.scan_job','SELECT') AS runtime_can_read,
    has_table_privilege('codethread_runtime','codethread.scan_job','DELETE') AS runtime_can_delete,
    has_schema_privilege('codethread_runtime','codethread','CREATE') AS runtime_can_create,
    has_function_privilege('codethread_runtime',
      'codethread.prune_inactive_data(timestamp with time zone,integer,integer,integer)',
      'EXECUTE') AS runtime_can_prune,
    has_function_privilege('codethread_retention',
      'codethread.prune_inactive_data(timestamp with time zone,integer,integer,integer)',
      'EXECUTE') AS retention_can_prune`;
  if (
    !roles[0]?.runtime_can_read ||
    roles[0].runtime_can_delete ||
    roles[0].runtime_can_create ||
    roles[0].runtime_can_prune ||
    !roles[0].retention_can_prune
  )
    throw new Error('Restored runtime and retention role grants are unsafe');
  const restoredSummary = await verifyDatabase(db);
  if (stableJson(sourceSummary) !== stableJson(restoredSummary))
    throw new Error(
      'Isolated restore differs from source snapshot/API/session evidence',
    );
  const verificationDigest = digest(
    stableJson({
      sourceSummary,
      restoredSummary,
      runtimeRoles: roles[0],
    }),
  );
  console.log(
    JSON.stringify({
      status: 'verified',
      ...restoredSummary,
      roles: roles[0],
      verificationDigest,
    }),
  );
} finally {
  await sourceDb.end({ timeout: 5 });
  await db.end({ timeout: 5 });
}
