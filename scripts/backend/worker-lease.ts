import { connectWorker, type Database } from './database.ts';

export interface WorkerLease {
  readonly db: Database;
  readonly signal: AbortSignal;
  readonly active: boolean;
  cancelPending(control: Database): Promise<void>;
  close(): Promise<void>;
}

export async function acquireWorkerLease(url: string): Promise<WorkerLease> {
  const lost = new AbortController();
  let closing = false,
    acquired = false,
    closingPromise: Promise<void> | undefined;
  const db = connectWorker(url, () => {
    if (closing) return;
    closing = true;
    acquired = false;
    closingPromise = db.end({ timeout: 0 });
    void closingPromise.catch(() => {});
    lost.abort();
  });

  const close = () => {
    if (!closingPromise) {
      closing = true;
      acquired = false;
      closingPromise = db.end({ timeout: 0 });
    }
    return closingPromise;
  };
  try {
    const rows =
      await db`SELECT pg_try_advisory_lock(1919606126, 2) AS acquired,
      pg_backend_pid() AS pid`;
    if (!rows[0]?.acquired)
      throw new Error(
        'Another CodeThread backend holds the database worker lock',
      );
    const pid = Number(rows[0]?.pid);
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Error('Database worker session identity is unavailable');
    if (lost.signal.aborted) throw new Error('Database worker lock was lost');
    acquired = true;
    return {
      db,
      signal: lost.signal,
      get active() {
        return acquired && !closing && !lost.signal.aborted;
      },
      async cancelPending(control) {
        if (!acquired || closing || lost.signal.aborted) return;
        // Constrain the target to the backend holding this database's worker lock.
        const matches =
          await control`SELECT pg_cancel_backend(l.pid) AS cancelled
          FROM pg_locks l WHERE l.pid=${pid} AND l.locktype='advisory'
            AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
            AND l.classid=1919606126::oid AND l.objid=2::oid
            AND l.objsubid=2 AND l.granted`;
        if (!matches[0]?.cancelled)
          throw new Error('Could not cancel the database worker session');
      },
      close,
    };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
