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
  private epoch = 0;
  private closed = false;

  constructor(db: Database) {
    this.db = db;
  }

  private assertOpen(expectedEpoch: number): void {
    if (this.closed || this.epoch !== expectedEpoch) {
      throw new ServiceError(
        503,
        'VIEWER_UNAVAILABLE',
        'Persistent viewer manager is closing active sessions.',
      );
    }
  }

  async open(jobId: string): Promise<{ url: string; expiresAt: string }> {
    const startEpoch = this.epoch;
    this.assertOpen(startEpoch);
    const scanId = jobId.toLowerCase();
    const existing = this.active.get(scanId);
    let viewer: ActiveViewer;
    if (existing) {
      viewer = await existing;
      this.assertOpen(startEpoch);
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
      const opening: Promise<ActiveViewer> = this.startViewer(
        scanId,
        startEpoch,
        () => {
          if (this.active.get(scanId) === opening) this.active.delete(scanId);
        },
      );
      this.active.set(scanId, opening);
      try {
        viewer = await opening;
      } catch (error) {
        if (this.active.get(scanId) === opening) this.active.delete(scanId);
        throw error;
      }
    }
    if (this.closed || this.epoch !== startEpoch) {
      clearTimeout(viewer.timer);
      await viewer.handle.close().catch(() => {});
      this.assertOpen(startEpoch);
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
    startEpoch: number,
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
    this.assertOpen(startEpoch);
    const handle = await createRepositoryViewer(session);
    if (this.closed || this.epoch !== startEpoch) {
      await handle.close().catch(() => {});
      this.assertOpen(startEpoch);
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

  async closeAll(options?: { shutdown?: boolean }): Promise<void> {
    this.epoch++;
    if (options?.shutdown) this.closed = true;
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
