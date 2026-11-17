import assert from 'node:assert/strict';
import { createServer, connect as connectSocket, type Socket } from 'node:net';
import postgres from 'postgres';

const databaseUrl = process.env.CODETHREAD_TEST_DATABASE_URL;
const scenario = process.argv[2];
const table = process.argv[3];
if (!databaseUrl || !table || !/^ct_driver_loss_[a-f0-9]{32}$/.test(table))
  throw new Error('Disposable driver-loss configuration is required');
const url = new URL(databaseUrl);
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
const qualified = `public."${table}"`;
const watchdog = setTimeout(() => {
  console.error('Driver-loss scenario did not settle');
  process.exit(2);
}, 12_000);
process.on('uncaughtException', (error) => {
  console.error(`Uncaught ${error.name}: ${error.message}`);
  process.exit(1);
});
process.on('unhandledRejection', (error) => {
  console.error(`Unhandled rejection: ${String(error)}`);
  process.exit(1);
});

const options = { max: 1, connect_timeout: 5, onnotice: () => {} };
const admin = postgres(databaseUrl, options);

async function waitForActive(pid: number) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const [row] =
      await admin`SELECT state,query FROM pg_stat_activity WHERE pid=${pid}`;
    if (row?.state === 'active' && String(row.query).includes('pg_sleep'))
      return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('The target query did not become active');
}

async function waitForGone(pid: number) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const rows = await admin`SELECT pid FROM pg_stat_activity WHERE pid=${pid}`;
    if (!rows.length) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('The disconnected backend did not exit');
}

async function reserved() {
  let signalClosed!: () => void;
  const closed = new Promise<void>((resolve) => (signalClosed = resolve));
  const sql = postgres(databaseUrl!, { ...options, onclose: signalClosed });
  try {
    const connection = await sql.reserve();
    const pid = Number(
      (await connection`SELECT pg_backend_pid() AS pid`)[0]?.pid,
    );
    assert.ok(Number.isInteger(pid) && pid > 0);
    await admin`SELECT pg_terminate_backend(${pid})`;
    await closed;
    let rejected = false;
    try {
      await connection`SELECT 1 AS stale`;
    } catch {
      rejected = true;
    }
    assert.ok(rejected, 'a closed reservation must reject');
    connection.release();
    const [healthy] = await sql`SELECT 1 AS value`;
    assert.equal(healthy?.value, 1, 'the pool must recover after release');
  } finally {
    await sql.end({ timeout: 2 });
  }
}

async function transaction() {
  const sql = postgres(databaseUrl!, options);
  try {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));
    let lateResolved = false;
    const operation = sql.begin(async (tx) => {
      try {
        const pid = Number((await tx`SELECT pg_backend_pid() AS pid`)[0]?.pid);
        assert.ok(Number.isInteger(pid) && pid > 0);
        await tx.unsafe(`INSERT INTO ${qualified} VALUES (1)`);
        const queued = sql`SELECT 1 AS value`.then((rows) => rows);
        await admin`SELECT pg_terminate_backend(${pid})`;
        await queued;
        try {
          await tx.unsafe(`INSERT INTO ${qualified} VALUES (2)`);
          lateResolved = true;
        } catch {
          // A stale transaction handle must reject after session loss.
        }
      } finally {
        finish();
      }
    });
    await assert.rejects(operation);
    await finished;
    const rows = await admin.unsafe(`SELECT id FROM ${qualified} ORDER BY id`);
    assert.equal(lateResolved, false, 'a stale transaction must not execute');
    assert.deepEqual(
      rows.map((row) => row.id),
      [],
      'no partial write may commit',
    );
  } finally {
    await sql.end({ timeout: 2 });
  }
}

async function interruptedQuery(useProxy: boolean) {
  const sockets = new Set<Socket>();
  const proxy = createServer((client) => {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const server = connectSocket(Number(url.port || '5432'), host);
    sockets.add(client);
    sockets.add(server);
    client.pipe(server).pipe(client);
    const close = () => {
      client.destroy();
      server.destroy();
      sockets.delete(client);
      sockets.delete(server);
    };
    client.on('error', close).on('close', close);
    server.on('error', close).on('close', close);
  });
  if (useProxy)
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const proxyAddress = proxy.address();
  const connectionUrl = new URL(databaseUrl!);
  if (useProxy && proxyAddress && typeof proxyAddress !== 'string') {
    connectionUrl.hostname = '127.0.0.1';
    connectionUrl.port = String(proxyAddress.port);
  }
  const sql = postgres(connectionUrl.toString(), options);
  try {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));
    let pid = 0;
    const operation = sql.begin(async (tx) => {
      try {
        pid = Number((await tx`SELECT pg_backend_pid() AS pid`)[0]?.pid);
        assert.ok(Number.isInteger(pid) && pid > 0);
        await tx.unsafe(`INSERT INTO ${qualified} VALUES (1)`);
        const running = tx`SELECT pg_sleep(1)`.then((rows) => rows);
        await waitForActive(pid);
        if (useProxy) for (const socket of sockets) socket.destroy();
        else await admin`SELECT pg_terminate_backend(${pid})`;
        await running;
      } finally {
        finish();
      }
    });
    await assert.rejects(operation);
    await finished;
    await waitForGone(pid);
    const rows = await admin.unsafe(`SELECT id FROM ${qualified}`);
    assert.deepEqual(
      rows.map((row) => row.id),
      [],
      'interrupted writes must roll back',
    );
    const [healthy] = await sql`SELECT 1 AS value`;
    assert.equal(healthy?.value, 1, 'the pool must recover after disconnect');
  } finally {
    for (const socket of sockets) socket.destroy();
    if (useProxy)
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await sql.end({ timeout: 2 });
  }
}

try {
  await admin.unsafe(`CREATE TABLE ${qualified} (id integer PRIMARY KEY)`);
  if (scenario === 'reserved') await reserved();
  else if (scenario === 'transaction') await transaction();
  else if (scenario === 'rollback') await interruptedQuery(false);
  else if (scenario === 'network') await interruptedQuery(true);
  else throw new Error('Unknown driver-loss scenario');
  await admin.unsafe(`DROP TABLE ${qualified}`);
  await admin.end({ timeout: 2 });
  clearTimeout(watchdog);
  console.log(`PASS ${scenario}`);
} catch (error) {
  console.error(error);
  await admin.end({ timeout: 2 }).catch(() => {});
  clearTimeout(watchdog);
  process.exitCode = 1;
}
