'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { ApiFailure, rememberWorkspaceScan } from '../investigation/api.ts';
import { errorMessage } from '../investigation/scoped-api.ts';
import {
  cancelScanJob,
  readScanDetail,
  readScanFiles,
  readScanProjects,
  type ScanFilesPage,
  type ScanProjectRecord,
  type ScanRecord,
} from '../shared/admin-api.ts';
import { AppHeader, AppStatusBar } from '../shared/AppChrome.tsx';
import { ScanStateBadge, useStandaloneTheme } from '../shared/StatusChrome.tsx';
import { ScanArtifactsPanel } from './ScanArtifactsPanel.tsx';

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

export function ScanDetailScreen({ scanId }: { scanId: string }) {
  const { theme, setTheme } = useStandaloneTheme();
  const [scan, setScan] = useState<ScanRecord | null>(null);
  const [scanLoading, setScanLoading] = useState(true);
  const [scanError, setScanError] = useState<string | null>(null);

  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<'projects' | 'files'>('projects');
  const [projects, setProjects] = useState<ScanProjectRecord[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);

  const [files, setFiles] = useState<ScanFilesPage | null>(null);
  const [filesOffset, setFilesOffset] = useState(0);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);

  const scanGen = useRef(0);
  const artifactsGen = useRef(0);
  const filesGen = useRef(0);

  async function fetchScan(silent = false): Promise<ScanRecord | null> {
    const gen = ++scanGen.current;
    if (!silent) {
      setScanLoading(true);
      setScanError(null);
    }
    try {
      const { scan: next } = await readScanDetail(scanId);
      if (gen !== scanGen.current) return null;
      rememberWorkspaceScan(next.id);
      setScan(next);
      setScanError(null);
      return next;
    } catch (error) {
      if (gen === scanGen.current) setScanError(errorMessage(error));
      return null;
    } finally {
      if (gen === scanGen.current && !silent) setScanLoading(false);
    }
  }

  async function fetchProjects() {
    const gen = ++artifactsGen.current;
    setProjectsLoading(true);
    setProjectsError(null);
    try {
      const { items } = await readScanProjects(scanId);
      if (gen === artifactsGen.current) setProjects(items);
    } catch (error) {
      if (gen === artifactsGen.current) setProjectsError(errorMessage(error));
    } finally {
      if (gen === artifactsGen.current) setProjectsLoading(false);
    }
  }

  async function fetchFiles(offset: number) {
    const gen = ++filesGen.current;
    setFilesLoading(true);
    setFilesError(null);
    try {
      const page = await readScanFiles(scanId, offset);
      if (gen === filesGen.current) {
        setFiles(page);
        setFilesOffset(offset);
      }
    } catch (error) {
      if (gen === filesGen.current) setFilesError(errorMessage(error));
    } finally {
      if (gen === filesGen.current) setFilesLoading(false);
    }
  }

  useEffect(() => {
    setScan(null);
    setProjects([]);
    setFiles(null);
    setFilesOffset(0);
    setCancelError(null);
    void fetchScan(false);
  }, [scanId]);

  const isActiveState = scan?.state === 'queued' || scan?.state === 'running';

  useEffect(() => {
    if (!isActiveState) return;
    let cancelled = false;
    let delayMs = 1500;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      if (cancelled || document.visibilityState === 'hidden') return;
      timer = setTimeout(() => {
        void fetchScan(true).then((updated) => {
          if (cancelled) return;
          if (
            updated &&
            (updated.state === 'queued' || updated.state === 'running')
          ) {
            delayMs = Math.min(3000, delayMs + 500);
            schedule();
          }
        });
      }, delayMs);
    };

    const onVisibility = () => {
      if (timer) clearTimeout(timer);
      if (document.visibilityState === 'visible') {
        delayMs = 1500;
        void fetchScan(true).then((updated) => {
          if (
            !cancelled &&
            updated &&
            (updated.state === 'queued' || updated.state === 'running')
          )
            schedule();
        });
      }
    };

    schedule();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [isActiveState, scanId]);

  useEffect(() => {
    if (!scan) return;
    if (
      scan.state === 'succeeded' ||
      scan.state === 'failed' ||
      scan.state === 'cancelled'
    ) {
      void fetchProjects();
      void fetchFiles(0);
    }
  }, [scan?.id, scan?.state]);

  async function handleCancel() {
    if (!scan || !isActiveState) return;
    setCancelling(true);
    setCancelError(null);
    try {
      await cancelScanJob(scan.id);
      await fetchScan(false);
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 409) {
        await fetchScan(false);
      }
      setCancelError(errorMessage(error));
    } finally {
      setCancelling(false);
    }
  }

  return (
    <div className="page-shell admin-shell">
      <AppHeader
        screen="scan"
        title="Scan Detail"
        activeScanId={scanId}
        context={
          scan ? (
            <>
              <code>{scan.revision_selector}</code>
              {scan.git_commit_oid ? (
                <>
                  <span aria-hidden="true">·</span>
                  <code>{scan.git_commit_oid.slice(0, 10)}</code>
                </>
              ) : null}
            </>
          ) : (
            <code>{scanId.slice(0, 8)}</code>
          )
        }
        actions={
          <>
            <button
              className="btn-subtle"
              type="button"
              disabled={scanLoading}
              onClick={() => void fetchScan(false)}
            >
              Refresh
            </button>
            {scan?.state === 'succeeded' ? (
              <Link
                className="btn-link btn-primary"
                href={`/?scanId=${scan.id}`}
              >
                Open in Investigate
              </Link>
            ) : null}
          </>
        }
      />

      <div className="admin-grid">
        <aside
          className="region explorer"
          aria-labelledby="scan-lifecycle-heading"
        >
          <div className="region-title pane-header">
            <h2 id="scan-lifecycle-heading">Scan metadata</h2>
          </div>
          <div className="pane-body">
            {scanLoading && !scan ? (
              <p role="status">Loading scan status…</p>
            ) : null}
            {scanError ? (
              <div className="notice error" role="alert">
                <span>{scanError}</span>
                <button type="button" onClick={() => void fetchScan(false)}>
                  Retry status check
                </button>
              </div>
            ) : null}
            {scan ? (
              <>
                <div className="scan-status-banner">
                  <ScanStateBadge state={scan.state} />
                  {scan.activation_result ? (
                    <span className="muted small">
                      Activation: <strong>{scan.activation_result}</strong>
                    </span>
                  ) : null}
                </div>
                {scan.activation_result === 'stale' ? (
                  <p className="notice warning" role="status">
                    This scan succeeded but is stale — a newer generation is
                    active on this repository.
                  </p>
                ) : null}
                {isActiveState ? (
                  <div className="scan-actions">
                    <button
                      className="btn-subtle"
                      type="button"
                      disabled={cancelling}
                      onClick={() => void handleCancel()}
                    >
                      {cancelling ? 'Cancelling…' : 'Cancel scan'}
                    </button>
                    <span className="muted small" role="status">
                      Polling status automatically while active…
                    </span>
                  </div>
                ) : null}
                {cancelError ? (
                  <div className="notice error" role="alert">
                    <span>{cancelError}</span>
                  </div>
                ) : null}
                {scan.error_code || scan.error_message ? (
                  <div className="notice error" role="alert">
                    <span>
                      <strong>{scan.error_code ?? 'SCAN_FAILED'}:</strong>{' '}
                      {scan.error_message ?? 'Scan did not complete.'}
                    </span>
                  </div>
                ) : null}
                <dl className="evidence-meta">
                  <div>
                    <dt>Scan ID</dt>
                    <dd>
                      <code>{scan.id}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Repo ID</dt>
                    <dd>
                      <code>{scan.repository_id}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Revision</dt>
                    <dd>
                      <code>{scan.revision_selector}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Commit</dt>
                    <dd>
                      <code>{scan.git_commit_oid ?? 'not pinned yet'}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Tree</dt>
                    <dd>
                      <code>{scan.git_tree_oid ?? '—'}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Generation</dt>
                    <dd>
                      {scan.generation} (attempt {scan.attempt})
                    </dd>
                  </div>
                  <div>
                    <dt>Created</dt>
                    <dd>{formatDateTime(scan.created_at)}</dd>
                  </div>
                  <div>
                    <dt>Updated</dt>
                    <dd>{formatDateTime(scan.updated_at)}</dd>
                  </div>
                </dl>
              </>
            ) : null}
          </div>
        </aside>

        <ScanArtifactsPanel
          scan={scan}
          isActiveState={isActiveState}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          projects={projects}
          projectsLoading={projectsLoading}
          projectsError={projectsError}
          onRetryProjects={() => void fetchProjects()}
          files={files}
          filesOffset={filesOffset}
          filesLoading={filesLoading}
          filesError={filesError}
          onFilesPage={(offset) => void fetchFiles(offset)}
        />
      </div>

      <AppStatusBar
        summary={
          isActiveState
            ? 'Active scan · polling status'
            : 'Scan record · immutable snapshot'
        }
        theme={theme}
        onThemeChange={setTheme}
      />
    </div>
  );
}
