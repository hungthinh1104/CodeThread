import { connect, assertMigrations } from './database.ts';
import { makeApi } from './http.ts';
import { ScanService, type BackendConfig } from './service.ts';
import { PersistentViewerManager } from './viewer-adapter.ts';
import { acquireWorkerLease, type WorkerLease } from './worker-lease.ts';

export type RuntimeConfig = BackendConfig & {
  url: string;
  secret: string;
  port: number;
};

export async function startBackend(config: RuntimeConfig) {
  const db = connect(config.url);
  const viewers = new PersistentViewerManager(db);
  let lease: WorkerLease | undefined;
  let server: ReturnType<typeof makeApi> | undefined;
  try {
    await assertMigrations(db);
    lease = await acquireWorkerLease(config.url);
    const service = new ScanService(db, config, lease);
    await service.recover();
    server = makeApi(db, service, config.secret, config.port, viewers);
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(config.port, '127.0.0.1', resolve);
    });
    if (!lease.active) throw new Error('Database worker lock was lost');
    const worker = service.run(),
      activeServer = server,
      activeLease = lease;
    let shutdownPromise: Promise<void> | undefined;

    function shutdown(): Promise<void> {
      if (shutdownPromise) return shutdownPromise;
      service.stop();
      const serverClosed = new Promise<void>((resolve, reject) =>
        activeServer.close((error) => (error ? reject(error) : resolve())),
      );
      activeServer.closeIdleConnections();
      const grace = setTimeout(() => activeServer.closeAllConnections(), 3000);
      const cleanup = (async () => {
        try {
          try {
            await activeLease.cancelPending(db);
          } finally {
            await activeLease.close();
          }
          await Promise.all([worker, serverClosed, viewers.closeAll()]);
        } finally {
          clearTimeout(grace);
          activeServer.closeAllConnections();
          await db.end({ timeout: 1 });
        }
      })();
      let deadline: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_, reject) => {
        deadline = setTimeout(() => {
          activeServer.closeAllConnections();
          void activeLease.close();
          void db.end({ timeout: 0 });
          reject(new Error('Backend shutdown exceeded its deadline'));
        }, 10_000);
      });
      shutdownPromise = Promise.race([cleanup, timeout]).finally(() =>
        clearTimeout(deadline),
      );
      return shutdownPromise;
    }

    return { service, server: activeServer, lease: activeLease, shutdown };
  } catch (error) {
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    await lease?.close().catch(() => {});
    await viewers.closeAll().catch(() => {});
    await db.end({ timeout: 1 }).catch(() => {});
    throw error;
  }
}

export type BackendRuntime = Awaited<ReturnType<typeof startBackend>>;

export function installRuntimeSignals(runtime: BackendRuntime): void {
  let exitCode = 0;
  const stop = (code: number) => {
    exitCode = Math.max(exitCode, code);
    void runtime.shutdown().then(
      () => process.exit(exitCode),
      (error: unknown) => {
        console.error('Backend shutdown failed', error);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => stop(0));
  process.on('SIGTERM', () => stop(0));
  const lost = () => {
    console.error('Database worker lock was lost');
    stop(1);
  };
  runtime.lease.signal.addEventListener('abort', lost, { once: true });
  if (runtime.lease.signal.aborted) lost();
}
