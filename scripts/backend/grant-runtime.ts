import { readFile } from 'node:fs/promises';
import postgres from 'postgres';

const url = process.env.CODETHREAD_MIGRATION_DATABASE_URL;
if (!url)
  throw new Error(
    'CODETHREAD_MIGRATION_DATABASE_URL required to apply reviewed role grants',
  );
const db = postgres(url, { max: 1, prepare: false, connect_timeout: 10 });
try {
  const sql = await readFile(
    new URL('../../db/roles.sql', import.meta.url),
    'utf8',
  );
  await db.unsafe(sql);
  console.log('Applied CodeThread NOLOGIN runtime and retention role grants');
} finally {
  await db.end({ timeout: 5 });
}
