import { readFile } from 'node:fs/promises';
import postgres from 'postgres';

const url = process.env.CODETHREAD_MIGRATION_DATABASE_URL;
if (!url)
  throw new Error(
    'CODETHREAD_MIGRATION_DATABASE_URL required; use a dedicated migration role',
  );
const db = postgres(url, { max: 1, prepare: false, connect_timeout: 10 });
try {
  const installed =
    await db`SELECT to_regclass('codethread.repository') AS installed`;
  if (installed[0]?.installed)
    throw new Error(
      'Migration 001 already installed; migrations are forward-only',
    );
  const sql = await readFile(
    new URL('../../db/migrations/001_core.sql', import.meta.url),
    'utf8',
  );
  await db.unsafe(sql);
  console.log('Applied DB-02 schema migration 001');
} finally {
  await db.end({ timeout: 5 });
}
