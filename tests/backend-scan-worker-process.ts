import { connect, assertMigrations } from '../scripts/backend/database.ts';
import {
  acquireWorkerLease,
  type WorkerLease,
} from '../scripts/backend/worker-lease.ts';
import { ScanService } from '../scripts/backend/service.ts';

const url = process.env.CODETHREAD_DATABASE_URL;
const root = process.env.CODETHREAD_ALLOWED_REPO_ROOT;
const analyzerBuildHash = process.env.CODETHREAD_ANALYZER_BUILD_HASH;
if (!url || !root || !analyzerBuildHash)
  throw new Error('Worker process test configuration is incomplete');

const db = connect(url);
let lease: WorkerLease | undefined;
let service: ScanService | undefined;
let worker: Promise<void> | undefined;
let stopping = false;

async function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  service?.stop();
  await lease?.close();
  await worker;
  await db.end({ timeout: 5 });
  process.exit(exitCode);
}

try {
  await assertMigrations(db);
  lease = await acquireWorkerLease(url);
  service = new ScanService(
    db,
    {
      root,
      analyzerBuildHash,
      onPhaseStart: (phase) => process.send?.(`phase-started:${phase}`),
    },
    lease,
  );
  lease.signal.addEventListener('abort', () => void stop(1), { once: true });
  if (lease.signal.aborted) throw new Error('Database worker lock was lost');
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
  await lease?.close().catch(() => {});
  await db.end({ timeout: 5 });
  throw error;
}
