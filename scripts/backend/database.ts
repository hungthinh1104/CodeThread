import postgres from 'postgres';
import { createHash } from 'node:crypto';
import { readMigrations } from './migration-set.ts';

export type Database = ReturnType<typeof postgres>;
export function connect(url: string): Database {
  return postgres(url, {
    max: 5,
    prepare: true,
    idle_timeout: 20,
    connect_timeout: 10,
    connection: {
      application_name: 'codethread-backend',
      statement_timeout: 60_000,
      lock_timeout: 5_000,
      idle_in_transaction_session_timeout: 30_000,
    },
  });
}
export async function acquireServiceLock(db: Database) {
  const connection = await db.reserve();
  try {
    const rows =
      await connection`SELECT pg_try_advisory_lock(1919606126, 2) AS acquired`;
    if (!rows[0]?.acquired)
      throw new Error(
        'Another CodeThread backend holds the database worker lock',
      );
    return async () => {
      await connection`SELECT pg_advisory_unlock(1919606126, 2)`;
      connection.release();
    };
  } catch (error) {
    connection.release();
    throw error;
  }
}
export async function assertMigrations(db: Database) {
  const rows = await db`SELECT version,name,checksum
    FROM codethread.schema_migration ORDER BY version`;
  const expected = await readMigrations();
  if (rows.length !== expected.length)
    throw new Error('CodeThread database migrations are missing or unexpected');
  for (let i = 0; i < expected.length; i++) {
    const migration = expected[i]!,
      applied = rows[i]!;
    if (
      Number(applied.version) !== migration.version ||
      applied.name !== migration.name ||
      applied.checksum !== migration.checksum
    )
      throw new Error(
        `CodeThread migration ${migration.version} checksum mismatch`,
      );
  }
}
export function requestHash(input: object): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}
