import {
  connect,
  acquireServiceLock,
  assertMigrations,
} from '../scripts/backend/database.ts';
import { ScanService } from '../scripts/backend/service.ts';

const url = process.env.CODETHREAD_DATABASE_URL;
const root = process.env.CODETHREAD_ALLOWED_REPO_ROOT;
const analyzerBuildHash = process.env.CODETHREAD_ANALYZER_BUILD_HASH;
if (!url || !root || !analyzerBuildHash)
  throw new Error('Worker process test configuration is incomplete');

const db = connect(url);
const service = new ScanService(db, {
  root,
  analyzerBuildHash,
  onPhaseStart: (phase) => process.send?.(`phase-started:${phase}`),
});
let unlock: (() => Promise<void>) | undefined;
let worker: Promise<void> | undefined;
let stopping = false;

async function stop() {
  if (stopping) return;
  stopping = true;
  service.stop();
  await worker;
  await unlock?.();
  await db.end({ timeout: 5 });
  process.exit(0);
}

try {
  await assertMigrations(db);
  unlock = await acquireServiceLock(db);
  await service.recover();
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
