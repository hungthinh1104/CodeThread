import { randomBytes, randomUUID } from 'node:crypto';
import {
  createConnection,
  createServer as createPortProbe,
  type Socket,
} from 'node:net';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { connect } from '../scripts/backend/database.ts';
import { applyMigrations } from '../scripts/backend/migrations.ts';
import { makeApi } from '../scripts/backend/http.ts';
import { ScanService } from '../scripts/backend/service.ts';

const databaseUrl = process.env.CODETHREAD_TEST_DATABASE_URL;
const MAX_OUTSTANDING_SCANS = 32;
type ApiBody = {
  id?: string;
  state?: string;
  reused?: boolean;
  desired_generation?: string | number;
  error?: { code?: string };
};

async function reservePort() {
  const probe = createPortProbe();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  if (!address || typeof address === 'string')
    throw new Error('Could not reserve an API port');
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

describe.skipIf(!databaseUrl)('PostgreSQL backend scan queue bounds', () => {
  it('bounds concurrent submissions across repositories and reopens capacity after cancellation', async () => {
    const admin = connect(databaseUrl!),
      databaseName = 'ct_queue_' + randomUUID().replaceAll('-', ''),
      targetUrl = new URL(databaseUrl!),
      root = await mkdtemp(join(tmpdir(), 'ct-backend-queue-'));
    targetUrl.pathname = '/' + databaseName;
    let db: ReturnType<typeof connect> | undefined,
      service: ScanService | undefined,
      server: ReturnType<typeof makeApi> | undefined;
    try {
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
      await mkdir(join(root, 'first'));
      await mkdir(join(root, 'second'));
      db = connect(targetUrl.toString());
      await applyMigrations(db);
      service = new ScanService(db, {
        root,
        analyzerBuildHash: 'a'.repeat(64),
      });
      const port = await reservePort(),
        token = randomBytes(32).toString('hex');
      server = makeApi(db, service, token, port);
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(port, '127.0.0.1', resolve);
      });

      const sockets: Socket[] = [],
        opening = Array.from(
          { length: 80 },
          () =>
            new Promise<void>((resolve) => {
              const socket = createConnection(port, '127.0.0.1');
              sockets.push(socket);
              socket.once('connect', resolve);
              socket.once('error', resolve);
            }),
        );
      await Promise.all(opening);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const activeConnections = await new Promise<number>((resolve, reject) =>
        server!.getConnections((error, count) =>
          error ? reject(error) : resolve(count),
        ),
      );
      for (const socket of sockets) socket.destroy();
      const drainDeadline = Date.now() + 2_000;
      let remainingConnections = activeConnections;
      while (remainingConnections && Date.now() < drainDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        remainingConnections = await new Promise<number>((resolve, reject) =>
          server!.getConnections((error, count) =>
            error ? reject(error) : resolve(count),
          ),
        );
      }
      expect(remainingConnections).toBe(0);
      expect(activeConnections).toBeGreaterThan(0);
      expect(activeConnections).toBeLessThanOrEqual(64);

      const slowHeaderResponse = await new Promise<string>(
        (resolve, reject) => {
          const socket = createConnection(port, '127.0.0.1');
          let received = '';
          const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error('Slow request headers were not timed out'));
          }, 15_000);
          socket.once('connect', () =>
            socket.write('GET /v1/health HTTP/1.1\r\nHost: 127.0.0.1:'),
          );
          socket.on('data', (chunk) => {
            received += chunk.toString();
          });
          socket.once('close', () => {
            clearTimeout(timer);
            resolve(received);
          });
          socket.once('error', (error) => {
            clearTimeout(timer);
            if (received) resolve(received);
            else reject(error);
          });
        },
      );
      expect(slowHeaderResponse.startsWith('HTTP/1.1 408')).toBe(true);

      const base = `http://127.0.0.1:${port}/v1`,
        headers = {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        post = async (path: string, body: unknown) => {
          const response = await fetch(base + path, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
          });
          return {
            status: response.status,
            body: (await response.json()) as ApiBody,
          };
        },
        get = async (path: string) => {
          const response = await fetch(base + path, { headers });
          return {
            status: response.status,
            body: (await response.json()) as ApiBody,
          };
        };

      const repositories = await Promise.all(
        ['first', 'second'].map(async (name) => {
          const response = await post('/repositories', {
            locator: join(root, name),
          });
          expect(response.status).toBe(200);
          return response.body.id as string;
        }),
      );
      const accepted: { id: string; repositoryId: string; key: string }[] = [];
      for (let index = 0; index < MAX_OUTSTANDING_SCANS - 1; index++) {
        const repositoryId = repositories[index % repositories.length]!,
          key = `fill-${index}`,
          response = await post(`/repositories/${repositoryId}/scans`, {
            revision: 'HEAD',
            idempotencyKey: key,
          });
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ state: 'queued', reused: false });
        accepted.push({ id: response.body.id!, repositoryId, key });
      }

      const generationTotal = async () => {
        const rows = await Promise.all(
          repositories.map((id) => get(`/repositories/${id}`)),
        );
        return rows.reduce(
          (sum, row) => sum + BigInt(String(row.body.desired_generation)),
          0n,
        );
      };
      const beforeConcurrentSubmit = await generationTotal();
      const concurrent = await Promise.all(
        Array.from({ length: 16 }, (_, index) => {
          const repositoryId = repositories[index % repositories.length]!;
          return post(`/repositories/${repositoryId}/scans`, {
            revision: 'HEAD',
            idempotencyKey: `concurrent-${index}`,
          }).then((response) => ({
            ...response,
            repositoryId,
            key: `concurrent-${index}`,
          }));
        }),
      );
      const admitted = concurrent.filter((result) => result.status === 200),
        rejected = concurrent.filter((result) => result.status === 429);
      expect(admitted).toHaveLength(1);
      expect(rejected).toHaveLength(15);
      expect(
        rejected.every(
          (result) => result.body.error?.code === 'SCAN_QUEUE_FULL',
        ),
      ).toBe(true);
      accepted.push({
        id: admitted[0]!.body.id!,
        repositoryId: admitted[0]!.repositoryId,
        key: admitted[0]!.key,
      });
      expect(await generationTotal()).toBe(beforeConcurrentSubmit + 1n);

      const reused = await post(
        `/repositories/${accepted[0]!.repositoryId}/scans`,
        { revision: 'HEAD', idempotencyKey: accepted[0]!.key },
      );
      expect(reused.status).toBe(200);
      expect(reused.body).toMatchObject({
        id: accepted[0]!.id,
        reused: true,
        state: 'queued',
      });
      expect(await generationTotal()).toBe(beforeConcurrentSubmit + 1n);

      const cancelled = await post(`/scans/${accepted[0]!.id}/cancel`, {});
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.state).toBe('cancelled');
      const resumed = await post(`/repositories/${repositories[1]}/scans`, {
        revision: 'HEAD',
        idempotencyKey: 'after-cancellation',
      });
      expect(resumed.status).toBe(200);
      expect(resumed.body.state).toBe('queued');
      expect(await generationTotal()).toBe(beforeConcurrentSubmit + 2n);

      const states = await Promise.all(
        [...accepted.slice(1).map((job) => job.id), resumed.body.id].map(
          async (id) => (await get(`/scans/${id}`)).body.state,
        ),
      );
      expect(states.filter((state) => state === 'queued')).toHaveLength(
        MAX_OUTSTANDING_SCANS,
      );
    } finally {
      service?.stop();
      if (server)
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      await db?.end({ timeout: 5 });
      await admin
        .unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
        .catch(() => {});
      await admin.end({ timeout: 5 });
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
