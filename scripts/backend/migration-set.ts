import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export interface Migration {
  version: number;
  name: string;
  checksum: string;
  sql: string;
}

export async function readMigrations(): Promise<Migration[]> {
  const directoryUrl = new URL('../../db/migrations/', import.meta.url);
  const names = (await readdir(fileURLToPath(directoryUrl)))
    .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  const migrations: Migration[] = [];
  for (const name of names) {
    const version = Number(name.slice(0, 3));
    if (version !== migrations.length + 1)
      throw new Error(`Migration sequence has a gap before ${name}`);
    const sql = await readFile(new URL(name, directoryUrl), 'utf8');
    migrations.push({
      version,
      name,
      checksum: createHash('sha256').update(sql).digest('hex'),
      sql,
    });
  }
  if (!migrations.length)
    throw new Error('No CodeThread database migrations found');
  return migrations;
}
