import { createRepositoryViewer } from '../viewer.ts';
import type { ViewerHandle } from '../viewer.ts';
import type { Database } from './database.ts';
import {
  loadRepositorySession,
  RepositorySessionUnavailableError,
} from './session-persistence.ts';
import { ServiceError } from './service.ts';

type ActiveViewer = {
  handle: ViewerHandle;
  timer: ReturnType<typeof setTimeout>;
  expiresAt: number;
};

const MAX_VIEWERS = 4;
const VIEWER_TTL_MS = 30 * 60 * 1000;

export class PersistentViewerManager {
  private readonly active = new Map<string, Promise<ActiveViewer>>();
  private readonly db: Database;
  private closed = false;

  constructor(db: Database) {
    this.db = db;
  }

  async open(jobId: string): Promise<{ url: string; expiresAt: string }> {
    if (this.closed)
      throw new ServiceError(
        503,
        'VIEWER_UNAVAILABLE',
        'Persistent viewer manager is shutting down.',
      );
    const scanId = jobId.toLowerCase();
    const existing = this.active.get(scanId);
    let viewer: ActiveViewer;
    if (existing) {
      viewer = await existing;
      const [retained] = await this.db`SELECT id FROM codethread.scan_job
        WHERE id=${scanId} AND state='succeeded'`;
      if (!retained) {
        clearTimeout(viewer.timer);
        if (this.active.get(scanId) === existing) this.active.delete(scanId);
        await viewer.handle.close().catch(() => {});
        throw new ServiceError(404, 'NOT_FOUND', 'Scan not found');
      }
    } else {
      if (this.active.size >= MAX_VIEWERS)
        throw new ServiceError(
          429,
          'VIEWER_CAPACITY',
          'Too many scan viewers are active. Retry after a viewer expires.',
        );
      const opening: Promise<ActiveViewer> = this.startViewer(scanId, () => {
        if (this.active.get(scanId) === opening) this.active.delete(scanId);
      });
      this.active.set(scanId, opening);
      try {
        viewer = await opening;
      } catch (error) {
        if (this.active.get(scanId) === opening) this.active.delete(scanId);
        throw error;
      }
    }
    if (this.closed) {
      clearTimeout(viewer.timer);
      await viewer.handle.close().catch(() => {});
      throw new ServiceError(
        503,
        'VIEWER_UNAVAILABLE',
        'Persistent viewer manager is shutting down.',
      );
    }
    if (Date.now() >= viewer.expiresAt)
      throw new ServiceError(
        409,
        'VIEWER_NOT_READY',
        'The viewer is expiring. Retry shortly.',
      );
    return {
      url: viewer.handle.url,
      expiresAt: new Date(viewer.expiresAt).toISOString(),
    };
  }

  private async startViewer(
    jobId: string,
    remove: () => void,
  ): Promise<ActiveViewer> {
    let session;
    try {
      session = await loadRepositorySession(this.db, jobId);
    } catch (error) {
      if (error instanceof RepositorySessionUnavailableError)
        throw new ServiceError(
          error.reason === 'not_found' ? 404 : 409,
          error.reason === 'not_found' ? 'NOT_FOUND' : 'VIEWER_NOT_READY',
          error.message,
        );
      throw error;
    }
    if (this.closed)
      throw new ServiceError(
        503,
        'VIEWER_UNAVAILABLE',
        'Persistent viewer manager is shutting down.',
      );
    const handle = await createRepositoryViewer(session);
    if (this.closed) {
      await handle.close().catch(() => {});
      throw new ServiceError(
        503,
        'VIEWER_UNAVAILABLE',
        'Persistent viewer manager is shutting down.',
      );
    }
    const expiresAt = Date.now() + VIEWER_TTL_MS;
    const timer = setTimeout(() => {
      void handle
        .close()
        .catch(() => {})
        .finally(remove);
    }, VIEWER_TTL_MS);
    timer.unref();
    return { handle, expiresAt, timer };
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    const viewers = [...this.active.values()];
    this.active.clear();
    await Promise.all(
      viewers.map(async (opening) => {
        const viewer = await opening.catch(() => null);
        if (viewer) {
          clearTimeout(viewer.timer);
          await viewer.handle.close();
        }
      }),
    );
  }
}
