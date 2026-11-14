import { describe, expect, it } from 'vitest';
import { DatabaseTelemetry } from '../scripts/backend/benchmark-telemetry.ts';
import { connect } from '../scripts/backend/database.ts';

const databaseUrl = process.env.CODETHREAD_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('PostgreSQL benchmark telemetry', () => {
  it('observes connection pool contention and query round trips separately', async () => {
    const url = new URL(databaseUrl!),
      telemetry = new DatabaseTelemetry(
        decodeURIComponent(url.pathname.slice(1)),
      ),
      db = connect(databaseUrl!);
    try {
      await Promise.all(
        Array.from({ length: 6 }, () =>
          db.begin(async (tx) => {
            await tx`SELECT pg_sleep(0.3)`;
          }),
        ),
      );
      const result = telemetry.result();
      expect(result.transactionLeaseWaitMs?.count).toBeGreaterThanOrEqual(6);
      expect(result.transactionLeaseWaitMs?.p99).toBeGreaterThan(100);
      expect(result.queryRoundTripMs?.count).toBeGreaterThanOrEqual(6);
      expect(result.queryRoundTripMs?.p95).toBeGreaterThan(200);
    } finally {
      telemetry.close();
      await db.end({ timeout: 5 });
    }
  }, 30_000);
});
