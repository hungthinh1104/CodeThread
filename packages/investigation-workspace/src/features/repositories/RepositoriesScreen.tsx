'use client';

import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../investigation/scoped-api.ts';
import type { RepositoryItem } from '../investigation/types.ts';
import {
  listAdminRepositories,
  readHealth,
  readRepositoryScans,
  type HealthStatus,
  type ScanRecord,
} from '../shared/admin-api.ts';
import { AppHeader, AppStatusBar } from '../shared/AppChrome.tsx';
import { HealthSummary, useStandaloneTheme } from '../shared/StatusChrome.tsx';
import { RepositoryScansPanel } from './RepositoryScansPanel.tsx';

export function RepositoriesScreen() {
  const { theme, setTheme } = useStandaloneTheme();
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [repositories, setRepositories] = useState<RepositoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [scans, setScans] = useState<ScanRecord[]>([]);
  const [scansLoading, setScansLoading] = useState(false);
  const [scansError, setScansError] = useState<string | null>(null);

  const listGeneration = useRef(0);
  const scanListGeneration = useRef(0);

  async function refreshAll() {
    const generation = ++listGeneration.current;
    setLoading(true);
    setLoadError(null);
    setHealthError(null);
    const [healthResult, repoResult] = await Promise.allSettled([
      readHealth(),
      listAdminRepositories(),
    ]);
    if (generation !== listGeneration.current) return;
    if (healthResult.status === 'fulfilled') setHealth(healthResult.value);
    else setHealthError(errorMessage(healthResult.reason));
    if (repoResult.status === 'fulfilled') {
      setRepositories(repoResult.value.items);
      if (
        !selectedRepoId &&
        repoResult.value.items.length > 0 &&
        repoResult.value.items[0]
      ) {
        setSelectedRepoId(repoResult.value.items[0].id);
      }
    } else {
      setLoadError(errorMessage(repoResult.reason));
    }
    setLoading(false);
  }

  async function loadScans(repoId: string) {
    const generation = ++scanListGeneration.current;
    setScansLoading(true);
    setScansError(null);
    try {
      const result = await readRepositoryScans(repoId);
      if (generation !== scanListGeneration.current) return;
      setScans(result.items);
    } catch (error) {
      if (generation === scanListGeneration.current)
        setScansError(errorMessage(error));
    } finally {
      if (generation === scanListGeneration.current) setScansLoading(false);
    }
  }

  useEffect(() => {
    void refreshAll();
    return () => {
      ++listGeneration.current;
      ++scanListGeneration.current;
    };
  }, []);

  useEffect(() => {
    if (!selectedRepoId) {
      setScans([]);
      setScansError(null);
      return;
    }
    void loadScans(selectedRepoId);
  }, [selectedRepoId]);

  const selectedRepo = repositories.find((item) => item.id === selectedRepoId);

  return (
    <div className="page-shell admin-shell">
      <AppHeader
        screen="repositories"
        title="Repositories"
        activeScanId={selectedRepo?.activeScanId ?? null}
        context={selectedRepo ? <span>{selectedRepo.label}</span> : null}
        actions={
          <button
            className="btn-subtle"
            type="button"
            disabled={loading}
            onClick={() => void refreshAll()}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        }
      />

      <div className="admin-grid">
        <aside className="region explorer" aria-labelledby="intake-heading">
          <div className="region-title pane-header">
            <h2 id="intake-heading">Repositories</h2>
          </div>
          <div className="pane-body">
            <h3>Service status</h3>
            <HealthSummary health={health} error={healthError} />

            <section
              className="explorer-section"
              aria-labelledby="repo-list-heading"
            >
              <div className="section-heading-row">
                <h3 id="repo-list-heading">Indexed repositories</h3>
                <span>{repositories.length} total</span>
              </div>
              {loadError ? (
                <div className="notice error" role="alert">
                  <span>{loadError}</span>
                  <button type="button" onClick={() => void refreshAll()}>
                    Retry
                  </button>
                </div>
              ) : null}
              {repositories.length ? (
                <ul className="result-list">
                  {repositories.map((repo) => {
                    const isSelected = repo.id === selectedRepoId;
                    return (
                      <li key={repo.id}>
                        <button
                          className={`symbol-result${isSelected ? ' is-selected' : ''}`}
                          type="button"
                          aria-current={isSelected ? 'true' : undefined}
                          onClick={() => setSelectedRepoId(repo.id)}
                        >
                          <strong>{repo.label}</strong>
                          <span>
                            Gen {repo.generation} ·{' '}
                            {repo.activeScanId ? 'active scan' : 'no scan yet'}
                          </span>
                          <code>{repo.id}</code>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : !loading && !loadError ? (
                <p className="muted small">
                  No repositories indexed yet. Register and scan a local
                  repository via the loopback backend API before inspecting it
                  here.
                </p>
              ) : null}
            </section>
          </div>
        </aside>

        <RepositoryScansPanel
          selectedRepo={selectedRepo}
          loadingRepositories={loading}
          health={health}
          scans={scans}
          scansLoading={scansLoading}
          scansError={scansError}
          onReloadScans={(repoId) => void loadScans(repoId)}
        />
      </div>

      <AppStatusBar
        summary="Read-only repository and scan inventory"
        theme={theme}
        onThemeChange={setTheme}
      />
    </div>
  );
}
