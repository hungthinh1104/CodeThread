import { serviceConfig } from './config.ts';
import { connect, acquireServiceLock, assertMigrations } from './database.ts';
import { ScanService } from './service.ts';
import { makeApi } from './http.ts';
import { PersistentViewerManager } from './viewer-adapter.ts';

const config = serviceConfig();
const db = connect(config.url);
const viewers = new PersistentViewerManager(db);
let unlock: (() => Promise<void>) | undefined;
try {
  await assertMigrations(db);
  unlock = await acquireServiceLock(db);
  const service = new ScanService(db, config);
  await service.recover();
  const server = makeApi(db, service, config.secret, config.port, viewers);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '127.0.0.1', resolve);
  });
  console.log(
    'CodeThread persistent API listening on 127.0.0.1:' + config.port,
  );
  const runPromise = service.run();
  const shutdown = async () => {
    service.stop();
    await runPromise;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await viewers.closeAll();
    await unlock?.();
    await db.end({ timeout: 5 });
  };
  process.once('SIGINT', () => {
    void shutdown().then(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    void shutdown().then(() => process.exit(0));
  });
} catch (e) {
  console.error(e);
  await viewers.closeAll();
  await unlock?.();
  await db.end({ timeout: 5 });
  process.exitCode = 1;
}
