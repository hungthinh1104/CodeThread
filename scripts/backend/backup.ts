import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, link, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { localPostgresConnection } from './local-postgres-url.ts';
import { runPgDump } from './postgres-tools.ts';

async function checksum(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

const url = process.env.CODETHREAD_BACKUP_DATABASE_URL,
  output = process.env.CODETHREAD_BACKUP_FILE;
if (!url || !output)
  throw new Error(
    'CODETHREAD_BACKUP_DATABASE_URL and CODETHREAD_BACKUP_FILE are required',
  );
const connection = localPostgresConnection(url, 'Backup source'),
  target = resolve(output),
  temporary = `${target}.tmp-${randomUUID()}`;
try {
  await access(target);
  throw new Error('Backup target already exists; choose a new file path');
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
    throw error;
}
try {
  await mkdir(dirname(target), { recursive: true });
  await runPgDump(
    process.env.CODETHREAD_PG_DUMP_BIN ?? 'pg_dump',
    [
      '--format=custom',
      '--no-owner',
      '--no-privileges',
      '--schema=codethread',
      `--file=${temporary}`,
    ],
    connection.env,
  );
  const bytes = (await stat(temporary)).size;
  await link(temporary, target);
  await rm(temporary);
  console.log(
    JSON.stringify({
      format: 'postgres-custom',
      schema: 'codethread',
      file: target,
      bytes,
      sha256: await checksum(target),
      createdAt: new Date().toISOString(),
    }),
  );
} catch (error) {
  await rm(temporary, { force: true });
  const detail = error instanceof Error ? error.message : 'pg_dump failed';
  throw new Error(`CodeThread backup failed: ${detail}`, { cause: error });
}
