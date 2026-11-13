import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  connect,
  assertMigrations,
  type Database,
} from '../scripts/backend/database.ts';
import { applyMigrations } from '../scripts/backend/migrations.ts';
import { readMigrations } from '../scripts/backend/migration-set.ts';

const databaseUrl = process.env.CODETHREAD_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('PostgreSQL migration integrity', () => {
  it('rolls back a failed v5 upgrade, resumes, and rejects checksum drift', async () => {
    const admin = connect(databaseUrl!),
      databaseName = 'ct_migration_' + randomUUID().replaceAll('-', ''),
      targetUrl = new URL(databaseUrl!);
    targetUrl.pathname = `/${databaseName}`;
    let db: ReturnType<typeof connect> | undefined;
    try {
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
      db = connect(targetUrl.toString());
      await db.unsafe('CREATE SCHEMA codethread');
      await db.unsafe(`CREATE TABLE codethread.schema_migration (
        version integer PRIMARY KEY CHECK(version > 0),
        name text NOT NULL UNIQUE,
        checksum char(64) NOT NULL CHECK(checksum ~ '^[0-9a-f]{64}$'),
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
      const migrations = await readMigrations();
      expect(migrations.map((migration) => migration.version)).toEqual([
        1, 2, 3, 4, 5,
      ]);
      for (const migration of migrations.slice(0, 4))
        await db.begin(async (transaction) => {
          const tx = transaction as unknown as Database;
          await tx.unsafe(migration.sql);
          await tx`INSERT INTO codethread.schema_migration(version,name,checksum)
            VALUES(${migration.version},${migration.name},${migration.checksum})`;
        });

      await db.unsafe(`CREATE FUNCTION codethread.test_fail_v5_record()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.version=5 THEN
            RAISE EXCEPTION 'injected version 5 migration failure';
          END IF;
          RETURN NEW;
        END $$`);
      await db.unsafe(`CREATE TRIGGER test_fail_v5_record
        BEFORE INSERT ON codethread.schema_migration
        FOR EACH ROW EXECUTE FUNCTION codethread.test_fail_v5_record()`);
      await expect(applyMigrations(db)).rejects.toThrow(
        'injected version 5 migration failure',
      );
      const rolledBack = await db`SELECT
        (SELECT array_agg(version ORDER BY version)
          FROM codethread.schema_migration) AS versions,
        (SELECT count(*)::integer FROM information_schema.columns
          WHERE table_schema='codethread' AND table_name='code_symbol'
            AND column_name='symbol_json') AS symbol_payload_columns,
        (SELECT count(*)::integer FROM pg_trigger t
          JOIN pg_class c ON c.oid=t.tgrelid
          JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='codethread' AND c.relname='code_symbol'
            AND t.tgname='immutable_symbol' AND NOT t.tgisinternal) AS symbol_guards`;
      expect(rolledBack[0]).toMatchObject({
        versions: [1, 2, 3, 4],
        symbol_payload_columns: 0,
        symbol_guards: 1,
      });

      await db.unsafe(`DROP TRIGGER test_fail_v5_record
        ON codethread.schema_migration`);
      await db.unsafe(`DROP FUNCTION codethread.test_fail_v5_record()`);
      await expect(applyMigrations(db)).resolves.toEqual([1, 2, 3, 4, 5]);
      await expect(assertMigrations(db)).resolves.toBeUndefined();
      await db`UPDATE codethread.schema_migration
        SET checksum=${'0'.repeat(64)} WHERE version=3`;
      await expect(assertMigrations(db)).rejects.toThrow(
        'CodeThread migration 3 checksum mismatch',
      );
      await expect(applyMigrations(db)).rejects.toThrow(
        'Applied migration 3 does not match this build',
      );
    } finally {
      await db?.end({ timeout: 5 });
      await admin
        .unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
        .catch(() => {});
      await admin.end({ timeout: 5 });
    }
  }, 60_000);
});
