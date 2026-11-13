import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
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

const archive = process.env.CODETHREAD_BACKUP_FILE,
  targetUrl = process.env.CODETHREAD_RESTORE_TEST_DATABASE_URL;
if (!archive || !targetUrl)
  throw new Error(
    'CODETHREAD_BACKUP_FILE and CODETHREAD_RESTORE_TEST_DATABASE_URL are required',
  );
await access(archive);
const target = restoreEnvironment(targetUrl),
  db = connect(targetUrl);
try {
  const existing = await db`SELECT to_regnamespace('codethread') AS schema`;
  if (existing[0]?.schema)
    throw new Error('Restore target already contains a CodeThread schema');
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
  const snapshots = await db`SELECT id FROM codethread.repository_snapshot
    WHERE state='published' ORDER BY id`;
  let verifiedFiles = 0,
    verifiedSymbols = 0,
    verifiedEvidence = 0,
    verifiedGraphs = 0;
  for (const row of snapshots) {
    const snapshot = await loadSnapshot(db, String(row.id));
    verifiedFiles += snapshot.facts.files.length;
    verifiedSymbols += snapshot.facts.symbols.length;
    const investigation = createInvestigation(snapshot.facts, snapshot.source, {
      resourceProfile: 'repository',
    });
    const symbol = snapshot.facts.symbols[0];
    if (symbol) {
      const graph = investigation.neighbors({
        snapshotId: snapshot.facts.snapshotId,
        symbolId: symbol.id,
      });
      if (graph.meta.snapshotId !== snapshot.facts.snapshotId)
        throw new Error('Restored graph query returned a different snapshot');
      verifiedGraphs++;
    }
    const evidenceId =
      symbol?.declarationEvidenceId ?? snapshot.facts.evidenceRefs[0]?.id;
    if (evidenceId) {
      const evidence = investigation.sourceEvidence({
        snapshotId: snapshot.facts.snapshotId,
        evidenceIds: [evidenceId],
      }).items[0];
      if (!evidence || evidence.status !== 'available')
        throw new Error('Restored source evidence is unavailable');
      verifiedEvidence++;
    }
  }
  const active = await db`SELECT active_job_id FROM codethread.repository
    WHERE active_job_id IS NOT NULL ORDER BY id`;
  for (const row of active)
    await loadRepositorySession(db, String(row.active_job_id));
  const checksum = createHash('sha256');
  checksum.update(
    JSON.stringify({
      snapshots: snapshots.length,
      verifiedFiles,
      verifiedSymbols,
      verifiedEvidence,
      verifiedGraphs,
      activeInvestigations: active.length,
    }),
  );
  console.log(
    JSON.stringify({
      status: 'verified',
      snapshots: snapshots.length,
      verifiedFiles,
      verifiedSymbols,
      verifiedEvidence,
      verifiedGraphs,
      activeInvestigations: active.length,
      verificationDigest: checksum.digest('hex'),
    }),
  );
} finally {
  await db.end({ timeout: 5 });
}
