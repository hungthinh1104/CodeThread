import postgres from 'postgres';
import { createHash } from 'node:crypto';
import { readMigrations } from './migration-set.ts';

export type Database = ReturnType<typeof postgres>;
const connectionLimits = {
  statement_timeout: 60_000,
  lock_timeout: 5_000,
  idle_in_transaction_session_timeout: 30_000,
};

export function connect(url: string): Database {
  return postgres(url, {
    max: 5,
    prepare: true,
    infer: true,
    idle_timeout: 20,
    connect_timeout: 10,
    connection: {
      application_name: 'codethread-backend',
      ...connectionLimits,
    },
  });
}

export function connectWorker(url: string, onclose: () => void): Database {
  return postgres(url, {
    max: 1,
    max_pipeline: 1,
    prepare: true,
    infer: true,
    idle_timeout: null,
    max_lifetime: null,
    connect_timeout: 10,
    onclose,
    connection: {
      application_name: 'codethread-worker',
      ...connectionLimits,
    },
  });
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
