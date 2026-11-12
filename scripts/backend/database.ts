import postgres from 'postgres';
import { createHash } from 'node:crypto';

export type Database = ReturnType<typeof postgres>;
export function connect(url: string): Database {
  return postgres(url, { max: 5, prepare: true, idle_timeout: 20, connect_timeout: 10 });
}
export async function acquireServiceLock(db: Database) {
  const connection = await db.reserve();
  try {
    const rows = await connection`SELECT pg_try_advisory_lock(1919606126, 2) AS acquired`;
    if (!rows[0]?.acquired) throw new Error('Another CodeThread backend holds the database worker lock');
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
  const rows = await db`SELECT to_regclass('codethread.scan_job') AS jobs,
    to_regclass('codethread.repository_snapshot') AS snapshots,
    to_regclass('codethread.source_object') AS sources`;
  if (!rows[0]?.jobs || !rows[0]?.snapshots || !rows[0]?.sources)
    throw new Error('Missing reviewed CodeThread migrations; apply db/migrations before starting');
}
export function requestHash(input: object): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}
