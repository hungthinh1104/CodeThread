'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../investigation/scoped-api.ts';
import {
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

const BASE_POLL_DELAY_MS = 1500;
const MAX_POLL_DELAY_MS = 10_000;
const MAX_CONSECUTIVE_POLL_FAILURES = 8;

type FetchScanOutcome =
  { kind: 'ok'; scan: ScanRecord } | { kind: 'error' } | { kind: 'stale' };

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

function isScanActive(record: ScanRecord | null): boolean {
  return record?.state === 'queued' || record?.state === 'running';
}

export function ScanDetailScreen({ scanId }: { scanId: string }) {
  const { theme, setTheme } = useStandaloneTheme();
  const [scan, setScan] = useState<ScanRecord | null>(null);
  const [scanLoading, setScanLoading] = useState(true);
  const [scanError, setScanError] = useState<string | null>(null);
  const [pollPaused, setPollPaused] = useState(false);
  const [pollEpoch, setPollEpoch] = useState(0);

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
  const scanInFlight = useRef(false);

  async function fetchScan(silent = false): Promise<FetchScanOutcome> {
    if (silent && scanInFlight.current) return { kind: 'stale' };
    const gen = ++scanGen.current;
    scanInFlight.current = true;
    if (!silent) {
      setScanLoading(true);
      setScanError(null);
      setPollPaused(false);
    }
    try {
      const { scan: next } = await readScanDetail(scanId);
      if (gen !== scanGen.current) return { kind: 'stale' };
      setScan(next);
      setScanError(null);
      setPollPaused(false);
      return { kind: 'ok', scan: next };
    } catch (error) {
      if (gen === scanGen.current) setScanError(errorMessage(error));
      return gen === scanGen.current ? { kind: 'error' } : { kind: 'stale' };
    } finally {
      if (gen === scanGen.current) {
        scanInFlight.current = false;
        if (!silent) setScanLoading(false);
      }
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

  function handleManualRefresh() {
    setPollPaused(false);
    setPollEpoch((value) => value + 1);
    void fetchScan(false);
  }

  useEffect(() => {
    setScan(null);
    setProjects([]);
    setFiles(null);
    setFilesOffset(0);
    setPollPaused(false);
    void fetchScan(false);
    return () => {
      ++scanGen.current;
      ++artifactsGen.current;
      ++filesGen.current;
      scanInFlight.current = false;
    };
  }, [scanId]);

  const isActiveState = isScanActive(scan);

  useEffect(() => {
    if (!isActiveState) return;
    let cancelled = false;
    let delayMs = BASE_POLL_DELAY_MS;
    let consecutiveFailures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const clearTimer = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    const scheduleNext = () => {
      clearTimer();
      if (cancelled || document.visibilityState === 'hidden') return;
      timer = setTimeout(() => {
        timer = undefined;
        void runPoll();
      }, delayMs);
    };

    const runPoll = async () => {
      if (cancelled) return;
      const outcome = await fetchScan(true);
      if (cancelled) return;
      if (outcome.kind === 'ok') {
        consecutiveFailures = 0;
        if (isScanActive(outcome.scan)) {
          delayMs = Math.min(3000, delayMs + 500);
          scheduleNext();
        }
        return;
      }
      if (outcome.kind === 'error') {
        consecutiveFailures += 1;
        if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
          setPollPaused(true);
          return;
        }
        delayMs = Math.min(
          MAX_POLL_DELAY_MS,
          Math.round(BASE_POLL_DELAY_MS * 1.6 ** consecutiveFailures),
        );
        scheduleNext();
        return;
      }
      // Stale/skipped because a manual refresh is in flight: re-arm without backoff penalty.
      scheduleNext();
    };

    const onVisibility = () => {
      clearTimer();
      if (document.visibilityState === 'visible' && !cancelled) {
        delayMs = BASE_POLL_DELAY_MS;
        consecutiveFailures = 0;
        setPollPaused(false);
        void runPoll();
      }
    };

    scheduleNext();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      clearTimer();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [isActiveState, scanId, pollEpoch]);

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
              onClick={handleManualRefresh}
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
                <button type="button" onClick={handleManualRefresh}>
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
                    <span className="muted small" role="status">
                      {pollPaused
                        ? 'Automatic polling paused after repeated errors. Select Retry status check to resume.'
                        : 'Polling status automatically while active…'}
                    </span>
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
            ? pollPaused
              ? 'Active scan · polling paused'
              : 'Active scan · polling status'
            : 'Scan record · immutable snapshot'
        }
        theme={theme}
        onThemeChange={setTheme}
      />
    </div>
  );
}
