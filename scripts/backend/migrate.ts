import postgres from 'postgres';
import { applyMigrations } from './migrations.ts';

const url = process.env.CODETHREAD_MIGRATION_DATABASE_URL;
if (!url)
  throw new Error(
    'CODETHREAD_MIGRATION_DATABASE_URL required; use a dedicated migration role',
  );
const db = postgres(url, { max: 1, prepare: false, connect_timeout: 10 });
try {
  const versions = await applyMigrations(db);
  console.log(`CodeThread database schema is at migration ${versions.at(-1)}`);
} finally {
  await db.end({ timeout: 5 });
}
