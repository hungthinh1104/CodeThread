import Link from 'next/link';
import type { FormEvent } from 'react';
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
  health: HealthStatus | null;
  revision: string;
  onRevisionChange: (value: string) => void;
  submittingScan: boolean;
  onTriggerScan: (event: FormEvent) => void;
  scanSubmitResult: { id: string; state: string; reused: boolean } | null;
  scanSubmitError: string | null;
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
        <div>
          <p className="step-label">02 / Repository & Scan Queue</p>
          <h2 id="repo-detail-heading">
            {selectedRepo ? selectedRepo.label : 'Select a repository'}
          </h2>
          {selectedRepo ? (
            <p className="selected-symbol">
              <span>Generation {selectedRepo.generation}</span>
              <code>{selectedRepo.id}</code>
            </p>
          ) : (
            <p className="muted">
              Choose a registered repository on the left to queue scans or
              inspect scan history.
            </p>
          )}
        </div>
        {selectedRepo?.activeScanId ? (
          <div className="row-actions">
            <Link
              className="btn-link btn-subtle"
              href={`/scans/${selectedRepo.activeScanId}`}
            >
              Inspect active scan
            </Link>
            <Link
              className="btn-link btn-primary"
              href={`/?scanId=${selectedRepo.activeScanId}`}
            >
              Open in Investigation
            </Link>
          </div>
        ) : null}
      </div>

      <div className="pane-body">
        {selectedRepo ? (
          <>
            <section
              className="admin-panel"
              aria-labelledby="trigger-scan-heading"
            >
              <h3 id="trigger-scan-heading">Queue a new pinned scan</h3>
              {props.health && props.health.worker !== 'ready' ? (
                <p className="notice warning" role="status">
                  Background worker is currently unavailable. Queued scans will
                  wait until worker readiness is restored.
                </p>
              ) : null}
              <form className="inline-scan-form" onSubmit={props.onTriggerScan}>
                <label className="sr-only" htmlFor="scan-revision-input">
                  Revision selector
                </label>
                <input
                  id="scan-revision-input"
                  value={props.revision}
                  onChange={(event) =>
                    props.onRevisionChange(event.currentTarget.value)
                  }
                  placeholder="HEAD, branch, tag, or commit OID"
                  maxLength={1024}
                  disabled={props.submittingScan}
                />
                <button
                  className="btn-primary"
                  type="submit"
                  disabled={props.submittingScan}
                >
                  {props.submittingScan ? 'Queueing…' : 'Run scan'}
                </button>
              </form>
              {props.scanSubmitResult ? (
                <div className="notice" role="status">
                  <span>
                    {props.scanSubmitResult.reused
                      ? `Existing scan reused (${props.scanSubmitResult.state}).`
                      : `Scan queued (${props.scanSubmitResult.state}).`}
                  </span>
                  <Link
                    className="btn-link btn-primary"
                    href={`/scans/${props.scanSubmitResult.id}`}
                  >
                    Open scan {props.scanSubmitResult.id.slice(0, 8)} →
                  </Link>
                </div>
              ) : null}
              {props.scanSubmitError ? (
                <div className="notice error" role="alert">
                  <span>{props.scanSubmitError}</span>
                </div>
              ) : null}
            </section>

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
                  No scans recorded for this repository yet. Queue one above to
                  produce a pinned snapshot.
                </p>
              ) : null}
            </section>
          </>
        ) : (
          <div className="empty-workbench">
            <p className="empty-state-lead">
              Manage local Git repositories and trigger pinned scans.
            </p>
            <ol className="empty-steps">
              <li>
                <strong>Register a repository</strong> inside the backend
                allowed root.
              </li>
              <li>
                <strong>Queue a scan</strong> against a revision or commit OID.
              </li>
              <li>
                <strong>Open Investigation</strong> once the snapshot succeeds.
              </li>
            </ol>
          </div>
        )}
      </div>
    </main>
  );
}
