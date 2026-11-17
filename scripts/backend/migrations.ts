import type { Database } from './database.ts';
import { readMigrations } from './migration-set.ts';

const LEGACY_TABLES = [
  'repository',
  'scan_job',
  'source_object',
  'scan_input_file',
  'repository_snapshot',
  'scan_project',
  'snapshot_file',
  'source_evidence',
  'code_symbol',
  'diagnostic',
  'code_relation',
  'relation_evidence',
  'snapshot_capability',
] as const;

async function adoptLegacySchema(db: Database, firstChecksum: string) {
  const tables = await db`
    SELECT count(*)::integer AS count FROM unnest(${db.array([...LEGACY_TABLES])}::text[]) AS name
    WHERE to_regclass('codethread.' || name) IS NOT NULL`;
  const count = Number(tables[0]?.count ?? 0);
  if (count === 0) return false;
  if (count !== LEGACY_TABLES.length)
    throw new Error(
      'Unversioned CodeThread schema is incomplete; manual review required',
    );
  const guards = await db`
    SELECT count(*)::integer AS count FROM pg_trigger t
    JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='codethread' AND NOT t.tgisinternal AND t.tgname IN
      ('immutable_snapshot','immutable_snapshot_file','immutable_evidence',
       'immutable_symbol','immutable_diagnostic','immutable_relation',
       'immutable_relation_evidence','immutable_capability',
       'immutable_source_object','validate_snapshot_publication')`;
  if (Number(guards[0]?.count ?? 0) !== 10)
    throw new Error(
      'Unversioned CodeThread schema lacks expected integrity guards',
    );
  await db`INSERT INTO codethread.schema_migration(version,name,checksum)
    VALUES(1,'001_core.sql',${firstChecksum})`;
  return true;
}

export async function applyMigrations(db: Database): Promise<number[]> {
  const migrations = await readMigrations();
  await db`CREATE SCHEMA IF NOT EXISTS codethread`;
  await db`CREATE TABLE IF NOT EXISTS codethread.schema_migration (
    version integer PRIMARY KEY CHECK(version > 0),
    name text NOT NULL UNIQUE,
    checksum char(64) NOT NULL CHECK(checksum ~ '^[0-9a-f]{64}$'),
    applied_at timestamptz NOT NULL DEFAULT now()
  )`;
  return db.begin(async (transaction) => {
    const tx = transaction as unknown as Database;
    await tx`SELECT pg_advisory_xact_lock(1919606126, 3)`;
    let rows =
      await tx`SELECT version,name,checksum FROM codethread.schema_migration ORDER BY version`;
    if (!rows.length && (await adoptLegacySchema(tx, migrations[0]!.checksum)))
      rows =
        await tx`SELECT version,name,checksum FROM codethread.schema_migration ORDER BY version`;
    const applied = new Map<number, { name: string; checksum: string }>();
    for (const row of rows) {
      const migration = migrations[Number(row.version) - 1];
      if (
        !migration ||
        migration.version !== Number(row.version) ||
        migration.name !== row.name ||
        migration.checksum !== row.checksum
      )
        throw new Error(
          `Applied migration ${row.version} does not match this build`,
        );
      applied.set(Number(row.version), {
        name: String(row.name),
        checksum: String(row.checksum),
      });
    }
    for (const migration of migrations) {
      const existing = applied.get(migration.version);
      if (existing) continue;
      if (applied.size !== migration.version - 1)
        throw new Error(
          `Migration ${migration.name} cannot skip an unapplied version`,
        );
      await tx.unsafe(migration.sql);
      await tx`INSERT INTO codethread.schema_migration(version,name,checksum)
        VALUES(${migration.version},${migration.name},${migration.checksum})`;
      applied.set(migration.version, {
        name: migration.name,
        checksum: migration.checksum,
      });
    }
    return [...applied.keys()].sort((a, b) => a - b);
  });
}
