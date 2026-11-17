import {
  acquireServiceLock,
  assertMigrations,
  connect,
} from '../scripts/backend/database.ts';
import { makeApi } from '../scripts/backend/http.ts';
import { ScanService } from '../scripts/backend/service.ts';

const url = process.env.CODETHREAD_DATABASE_URL,
  root = process.env.CODETHREAD_ALLOWED_REPO_ROOT,
  analyzerBuildHash = process.env.CODETHREAD_ANALYZER_BUILD_HASH,
  token = process.env.CODETHREAD_API_TOKEN,
  port = Number(process.env.CODETHREAD_TEST_API_PORT);
if (!url || !root || !analyzerBuildHash || !token || !Number.isInteger(port))
  throw new Error('HTTP worker process test configuration is incomplete');

const db = connect(url),
  service = new ScanService(db, { root, analyzerBuildHash });
let unlock: (() => Promise<void>) | undefined,
  worker: Promise<void> | undefined,
  server: ReturnType<typeof makeApi> | undefined,
  stopping = false;

async function stop() {
  if (stopping) return;
  stopping = true;
  service.stop();
  await worker;
  if (server)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  await unlock?.();
  await db.end({ timeout: 5 });
  process.exit(0);
}

try {
  await assertMigrations(db);
  unlock = await acquireServiceLock(db);
  await service.recover();
  server = makeApi(db, service, token, port);
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(port, '127.0.0.1', resolve);
  });
  worker = service.run();
  process.send?.('ready');
  process.on('message', (message) => {
    if (message === 'crash') {
      if (process.send) process.send('crash-received', () => process.exit(86));
      else process.exit(86);
    }
    if (message === 'stop') void stop();
  });
} catch (error) {
  await db.end({ timeout: 5 });
  throw error;
}
