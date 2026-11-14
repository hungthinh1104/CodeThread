import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';

const databaseUrl = process.env.CODETHREAD_TEST_DATABASE_URL;
const execFileAsync = promisify(execFile);
const worker = fileURLToPath(
  new URL('./backend-driver-loss-process.ts', import.meta.url),
);

describe.skipIf(!databaseUrl)('PostgreSQL driver connection loss', () => {
  it.each(['reserved', 'transaction', 'rollback', 'network'])(
    'settles %s without stale writes or an uncaught exception',
    async (scenario) => {
      const url = new URL(databaseUrl!);
      expect(['localhost', '127.0.0.1', '[::1]']).toContain(url.hostname);
      const table = `ct_driver_loss_${randomUUID().replaceAll('-', '')}`;
      const cleanup = postgres(databaseUrl!, { max: 1, connect_timeout: 5 });
      try {
        const result = await execFileAsync(
          process.execPath,
          [worker, scenario, table],
          {
            cwd: process.cwd(),
            env: { ...process.env, CODETHREAD_TEST_DATABASE_URL: databaseUrl },
            timeout: 15_000,
            windowsHide: true,
          },
        );
        expect(result.stdout).toContain(`PASS ${scenario}`);
      } finally {
        await cleanup.unsafe(`DROP TABLE IF EXISTS public."${table}"`);
        await cleanup.end({ timeout: 5 });
      }
    },
    20_000,
  );
});
