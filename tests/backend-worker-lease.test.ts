import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { connect } from '../scripts/backend/database.ts';
import {
  acquireWorkerLease,
  type WorkerLease,
} from '../scripts/backend/worker-lease.ts';

const databaseUrl = process.env.CODETHREAD_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('worker lease cancellation privileges', () => {
  it('cancels its own locked session without elevated PostgreSQL privileges', async () => {
    const admin = connect(databaseUrl!),
      role = `ct_cancel_${randomUUID().replaceAll('-', '')}`,
      password = randomUUID(),
      url = new URL(databaseUrl!);
    url.username = role;
    url.password = password;
    let control: ReturnType<typeof connect> | undefined;
    let lease: WorkerLease | undefined;
    try {
      await admin.unsafe(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
      control = connect(url.toString());
      lease = await acquireWorkerLease(url.toString());
      const pending = lease.db`SELECT pg_sleep(60)`.then(
        () => 'completed',
        () => 'rejected',
      );
      const deadline = Date.now() + 10_000;
      let active = false;
      while (Date.now() < deadline) {
        const rows = await admin`SELECT pid FROM pg_stat_activity
          WHERE datname=current_database() AND usename=${role}
            AND application_name='codethread-worker' AND wait_event='PgSleep'`;
        if (rows.length === 1) {
          active = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(active).toBe(true);
      await lease.cancelPending(control);
      await lease.close();
      expect(await pending).toBe('rejected');
    } finally {
      await lease?.close();
      await control?.end({ timeout: 5 });
      await admin.unsafe(`DROP ROLE IF EXISTS "${role}"`);
      await admin.end({ timeout: 5 });
    }
  }, 30_000);
});
