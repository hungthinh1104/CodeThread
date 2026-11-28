import Link from 'next/link';
import type { RepositoryItem } from '../investigation/types.ts';
import type { HealthStatus, ScanRecord } from '../shared/admin-api.ts';
import { ScanStateBadge } from '../shared/StatusChrome.tsx';

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

type Props = {
  selectedRepo: RepositoryItem | undefined;
  loadingRepositories?: boolean;
  health: HealthStatus | null;
  scans: ScanRecord[];
  scansLoading: boolean;
  scansError: string | null;
  onReloadScans: (repoId: string) => void;
};

export function RepositoryScansPanel(props: Props) {
  const { selectedRepo } = props;
  return (
    <main className="region main-region" aria-labelledby="repo-detail-heading">
      <div className="main-heading pane-header">
        <div className="main-heading-meta">
          <h2 id="repo-detail-heading">
            {selectedRepo ? selectedRepo.label : 'Select a repository'}
          </h2>
          {selectedRepo ? (
            <p className="selected-symbol">
              <span className="symbol-kind-tag">
                Gen {selectedRepo.generation}
              </span>
              <code>{selectedRepo.id}</code>
            </p>
          ) : (
            <p className="muted">
              Select an indexed repository to inspect its scan history and open
              a published snapshot.
            </p>
          )}
        </div>
        {selectedRepo?.activeScanId ? (
          <div className="row-actions">
            <Link
              className="btn-link btn-subtle"
              href={`/scans/${selectedRepo.activeScanId}`}
            >
              View active scan
            </Link>
            <Link
              className="btn-link btn-primary"
              href={`/?scanId=${selectedRepo.activeScanId}`}
            >
              Open in Investigate
            </Link>
          </div>
        ) : null}
      </div>

      <div className="pane-body">
        <div className="main-content">
          {selectedRepo ? (
            <>
              {props.health && props.health.worker !== 'ready' ? (
                <p className="notice warning" role="status">
                  Background worker is unavailable. Existing published snapshots
                  remain readable, while queued scans wait until worker
                  readiness recovers.
                </p>
              ) : null}

              <section
                className="admin-panel"
                aria-labelledby="scan-history-heading"
              >
                <div className="section-heading-row">
                  <h3 id="scan-history-heading">Recent scans (up to 25)</h3>
                  <button
                    className="btn-ghost"
                    type="button"
                    disabled={props.scansLoading}
                    onClick={() => props.onReloadScans(selectedRepo.id)}
                  >
                    {props.scansLoading ? 'Loading…' : 'Reload scans'}
                  </button>
                </div>
                {props.scansError ? (
                  <div className="notice error" role="alert">
                    <span>{props.scansError}</span>
                    <button
                      type="button"
                      onClick={() => props.onReloadScans(selectedRepo.id)}
                    >
                      Retry scans
                    </button>
                  </div>
                ) : null}
                {props.scans.length ? (
                  <ol className="relationship-list">
                    {props.scans.map((scan) => (
                      <li
                        key={scan.id}
                        className={`relation-row scan-row-${scan.state}`}
                      >
                        <div className="relation-body">
                          <div className="relation-head">
                            <ScanStateBadge state={scan.state} />
                            {scan.activation_result ? (
                              <span className="relation-resolution">
                                {scan.activation_result}
                              </span>
                            ) : null}
                            <code className="relation-location">
                              Gen {scan.generation} · attempt {scan.attempt}
                            </code>
                            <span className="muted small">
                              {formatTimestamp(scan.created_at)}
                            </span>
                          </div>
                          <span className="relation-flow">
                            {scan.revision_selector}
                            {scan.git_commit_oid
                              ? ` · ${scan.git_commit_oid.slice(0, 12)}`
                              : ''}
                          </span>
                          {scan.error_message ? (
                            <span className="small notice-inline-error">
                              {scan.error_code}: {scan.error_message}
                            </span>
                          ) : null}
                        </div>
                        <div className="row-actions">
                          <Link
                            className="btn-link btn-ghost"
                            href={`/scans/${scan.id}`}
                          >
                            View details
                          </Link>
                          {scan.state === 'succeeded' ? (
                            <Link
                              className="btn-link btn-primary"
                              href={`/?scanId=${scan.id}`}
                            >
                              Investigate
                            </Link>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ol>
                ) : !props.scansLoading && !props.scansError ? (
                  <p className="empty-state">
                    No scans recorded for this repository yet. Submit a scan via
                    the local backend API to produce a pinned snapshot.
                  </p>
                ) : null}
              </section>
            </>
          ) : props.loadingRepositories ? (
            <p className="empty-state" role="status">
              Loading indexed repositories…
            </p>
          ) : (
            <div className="empty-workbench">
              <p className="empty-state-lead">No repository selected</p>
              <p className="empty-state-body">
                Select an indexed repository from the sidebar to inspect its
                scan history and open published snapshots.
              </p>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
