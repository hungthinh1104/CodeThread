import { useEffect, useRef } from 'react';
import type { UseScanLifecycleState } from '../hooks/useScanLifecycle.ts';
import type { RepositoryItem } from '../types.ts';

type Props = {
  selectedRepository: RepositoryItem | undefined;
  scanLifecycle: UseScanLifecycleState;
  refreshingSystem: boolean;
  onRefreshSystem: () => void;
};

function TrackedScanPanel(props: { scanLifecycle: UseScanLifecycleState }) {
  const { scanLifecycle } = props;
  const scan = scanLifecycle.trackedScan;
  if (!scan) return null;
  const inProgress = scan.state === 'queued' || scan.state === 'running';

  return (
    <div id="tracked-scan-panel" className="scan-status-card" role="status">
      <div className="section-heading-row">
        <strong>
          Scan {scan.id.slice(0, 8)}… — {scan.state}
        </strong>
        <span>
          gen {scan.generation} · attempt {scan.attempt}
        </span>
      </div>
      <p className="muted small">
        Revision <code>{scan.revision}</code>
        {scanLifecycle.reusedNotice ? ' · reused existing scan' : ''}
        {scan.activationResult ? ` · ${scan.activationResult}` : ''}
      </p>
      {scan.commitId ? (
        <code className="scan-oid">commit {scan.commitId}</code>
      ) : null}
      {scan.treeId ? (
        <code className="scan-oid">tree {scan.treeId}</code>
      ) : null}
      {scan.errorCode || scan.errorMessage ? (
        <p className="notice error">
          {scan.errorCode ? `${scan.errorCode}: ` : ''}
          {scan.errorMessage ?? 'Scan failed.'}
        </p>
      ) : null}
      {inProgress ? (
        <div className="row-actions">
          <button
            id="cancel-scan-button"
            type="button"
            onClick={() => void scanLifecycle.cancelActiveScan()}
            disabled={scanLifecycle.scanCancelling}
          >
            {scanLifecycle.scanCancelling ? 'Cancelling…' : 'Cancel scan'}
          </button>
        </div>
      ) : null}
      {scanLifecycle.scanProjects?.length ? (
        <details className="diagnostics">
          <summary>
            Scan project states ({scanLifecycle.scanProjects.length})
          </summary>
          <ul>
            {scanLifecycle.scanProjects.map((proj) => (
              <li key={proj.project_id}>
                <strong>{proj.project_label}</strong> — {proj.status}
                {proj.diagnostics.map((diag, idx) => (
                  <span key={`${diag.code}-${idx}`}>
                    <code>{diag.code}</code> {diag.message}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

export function RepositoryScanManager(props: Props) {
  const { scanLifecycle, selectedRepository } = props;
  const locatorInputRef = useRef<HTMLInputElement>(null);
  const activeScanRunning =
    scanLifecycle.trackedScan?.state === 'queued' ||
    scanLifecycle.trackedScan?.state === 'running';

  useEffect(() => {
    const domValue = locatorInputRef.current?.value;
    if (domValue && !scanLifecycle.registerLocator)
      scanLifecycle.setRegisterLocator(domValue);
  }, []);

  return (
    <div className="scan-manager">
      {selectedRepository ? (
        <div className="scan-trigger-box">
          <label className="field-label" htmlFor="scan-revision-input">
            Scan Git revision
          </label>
          <div className="scan-trigger-row">
            <input
              id="scan-revision-input"
              value={scanLifecycle.scanRevision}
              onChange={(event) =>
                scanLifecycle.setScanRevision(event.currentTarget.value)
              }
              placeholder="HEAD, branch, tag, or commit OID"
              maxLength={1024}
              autoComplete="off"
              disabled={scanLifecycle.scanSubmitting || activeScanRunning}
            />
            <button
              id="start-scan-button"
              type="button"
              onClick={() => void scanLifecycle.submitScan()}
              disabled={scanLifecycle.scanSubmitting || activeScanRunning}
            >
              {scanLifecycle.scanSubmitting
                ? 'Queueing…'
                : activeScanRunning
                  ? 'Scanning…'
                  : 'Scan revision'}
            </button>
          </div>
          <div className="row-actions">
            {selectedRepository.activeScanId ? (
              <button
                id="inspect-scan-button"
                type="button"
                onClick={() =>
                  void scanLifecycle.inspectActiveScan(
                    selectedRepository.activeScanId!,
                  )
                }
              >
                Inspect active scan
              </button>
            ) : null}
            <button
              id="refresh-system-status"
              type="button"
              onClick={props.onRefreshSystem}
              disabled={props.refreshingSystem}
            >
              {props.refreshingSystem ? 'Refreshing…' : 'Refresh status'}
            </button>
          </div>
        </div>
      ) : null}

      {scanLifecycle.scanError ? (
        <p className="notice error" role="alert">
          {scanLifecycle.scanError}
        </p>
      ) : null}

      <TrackedScanPanel scanLifecycle={scanLifecycle} />

      <details className="diagnostics repo-register-disclosure">
        <summary>Register local repository</summary>
        <div className="repo-register-body">
          <label className="field-label" htmlFor="register-repo-locator">
            Path beneath allowed root
          </label>
          <input
            id="register-repo-locator"
            ref={locatorInputRef}
            value={scanLifecycle.registerLocator}
            onChange={(event) =>
              scanLifecycle.setRegisterLocator(event.currentTarget.value)
            }
            placeholder="Absolute path within CODETHREAD_ALLOWED_REPO_ROOT"
            maxLength={4096}
            autoComplete="off"
            disabled={scanLifecycle.registering}
          />
          <div className="row-actions">
            <button
              id="register-repo-submit"
              type="button"
              onClick={() => void scanLifecycle.submitRegisterRepository()}
              disabled={
                scanLifecycle.registering ||
                !scanLifecycle.registerLocator.trim()
              }
            >
              {scanLifecycle.registering
                ? 'Registering…'
                : 'Register repository'}
            </button>
            {!selectedRepository ? (
              <button
                id="refresh-system-status"
                type="button"
                onClick={props.onRefreshSystem}
                disabled={props.refreshingSystem}
              >
                {props.refreshingSystem ? 'Refreshing…' : 'Refresh status'}
              </button>
            ) : null}
          </div>
          {scanLifecycle.registerError ? (
            <p className="notice error" role="alert">
              {scanLifecycle.registerError}
            </p>
          ) : null}
        </div>
      </details>
    </div>
  );
}
