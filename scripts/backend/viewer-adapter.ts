import { createRepositoryViewer } from '../viewer.ts';
import type { ViewerHandle } from '../viewer.ts';
import type { Database } from './database.ts';
import { loadRepositorySession } from './session-persistence.ts';
import { ServiceError } from './service.ts';

type ActiveViewer = {
  handle: ViewerHandle;
  timer: ReturnType<typeof setTimeout>;
  expiresAt: number;
};

const MAX_VIEWERS = 4;
const VIEWER_TTL_MS = 30 * 60 * 1000;

export class PersistentViewerManager {
  private readonly active = new Set<ActiveViewer>();
  private opening = 0;
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async open(jobId: string): Promise<{ url: string; expiresAt: string }> {
    if (this.active.size + this.opening >= MAX_VIEWERS)
      throw new ServiceError(
        429,
        'VIEWER_CAPACITY',
        'Close an existing local viewer before opening another.',
      );
    this.opening++;
    try {
      const session = await loadRepositorySession(this.db, jobId),
        handle = await createRepositoryViewer(session),
        expiresAt = Date.now() + VIEWER_TTL_MS;
      const active: ActiveViewer = {
        handle,
        expiresAt,
        timer: setTimeout(() => {
          void handle
            .close()
            .catch(() => {})
            .finally(() => this.active.delete(active));
        }, VIEWER_TTL_MS),
      };
      active.timer.unref();
      this.active.add(active);
      return { url: handle.url, expiresAt: new Date(expiresAt).toISOString() };
    } finally {
      this.opening--;
    }
  }

  async closeAll(): Promise<void> {
    const viewers = [...this.active];
    this.active.clear();
    await Promise.all(
      viewers.map(async ({ handle, timer }) => {
        clearTimeout(timer);
        await handle.close();
      }),
    );
  }
}
