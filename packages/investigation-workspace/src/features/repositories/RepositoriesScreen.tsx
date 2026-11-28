'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { errorMessage } from '../investigation/scoped-api.ts';
import type { RepositoryItem } from '../investigation/types.ts';
import {
  listAdminRepositories,
  readHealth,
  readRepositoryScans,
  registerAdminRepository,
  triggerRepositoryScan,
  type HealthStatus,
  type ScanRecord,
} from '../shared/admin-api.ts';
import {
  HealthSummary,
  ThemeSwitcher,
  useStandaloneTheme,
} from '../shared/StatusChrome.tsx';
import { RepositoryScansPanel } from './RepositoryScansPanel.tsx';

export function RepositoriesScreen() {
  const { theme, setTheme } = useStandaloneTheme();
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [repositories, setRepositories] = useState<RepositoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [locator, setLocator] = useState('');
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [registerNotice, setRegisterNotice] = useState<string | null>(null);

  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [scans, setScans] = useState<ScanRecord[]>([]);
  const [scansLoading, setScansLoading] = useState(false);
  const [scansError, setScansError] = useState<string | null>(null);

  const [revision, setRevision] = useState('HEAD');
  const [idempotencyKey, setIdempotencyKey] = useState<string>(() =>
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `scan-${Date.now()}`,
  );
  const [submittingScan, setSubmittingScan] = useState(false);
  const [scanSubmitError, setScanSubmitError] = useState<string | null>(null);
  const [scanSubmitResult, setScanSubmitResult] = useState<{
    id: string;
    state: string;
    reused: boolean;
  } | null>(null);

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
  }, []);

  useEffect(() => {
    if (!selectedRepoId) {
      setScans([]);
      setScansError(null);
      return;
    }
    setScanSubmitError(null);
    setScanSubmitResult(null);
    setIdempotencyKey(crypto.randomUUID());
    void loadScans(selectedRepoId);
  }, [selectedRepoId]);

  async function handleRegister(event: FormEvent) {
    event.preventDefault();
    const trimmed = locator.trim();
    if (!trimmed) {
      setRegisterError(
        'Enter a local repository path inside the allowed root.',
      );
      return;
    }
    setRegistering(true);
    setRegisterError(null);
    setRegisterNotice(null);
    try {
      const { repository } = await registerAdminRepository(trimmed);
      setLocator('');
      setRegisterNotice(`Registered repository "${repository.label}".`);
      await refreshAll();
      setSelectedRepoId(repository.id);
    } catch (error) {
      setRegisterError(errorMessage(error));
    } finally {
      setRegistering(false);
    }
  }

  async function handleTriggerScan(event: FormEvent) {
    event.preventDefault();
    if (!selectedRepoId) return;
    const trimmed = revision.trim();
    if (!trimmed) {
      setScanSubmitError('Enter a Git revision, branch, tag, or commit OID.');
      return;
    }
    setSubmittingScan(true);
    setScanSubmitError(null);
    setScanSubmitResult(null);
    try {
      const { scan } = await triggerRepositoryScan(
        selectedRepoId,
        trimmed,
        idempotencyKey,
      );
      setScanSubmitResult({
        id: scan.id,
        state: scan.state,
        reused: scan.reused,
      });
      setIdempotencyKey(crypto.randomUUID());
      void loadScans(selectedRepoId);
      void refreshAll();
    } catch (error) {
      setScanSubmitError(errorMessage(error));
    } finally {
      setSubmittingScan(false);
    }
  }

  const selectedRepo = repositories.find((item) => item.id === selectedRepoId);

  return (
    <div className="page-shell">
      <header className="page-header">
        <div className="header-brand">
          <span className="brand-kicker">CODETHREAD</span>
          <span className="brand-sep" aria-hidden="true">
            /
          </span>
          <h1>Repositories & Scans</h1>
          <nav className="screen-nav" aria-label="Workspace screens">
            <Link className="screen-nav-link" href="/">
              Investigation
            </Link>
            <Link
              className="screen-nav-link is-active"
              href="/repositories"
              aria-current="page"
            >
              Repositories
            </Link>
          </nav>
        </div>
        <div className="header-actions">
          <button
            className="btn-subtle"
            type="button"
            disabled={loading}
            onClick={() => void refreshAll()}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>

      <div className="admin-grid">
        <aside className="region explorer" aria-labelledby="intake-heading">
          <div className="region-title pane-header">
            <p className="step-label">01 / System & Intake</p>
            <h2 id="intake-heading">Local backend</h2>
          </div>
          <div className="pane-body">
            <h3>Service readiness</h3>
            <HealthSummary health={health} error={healthError} />

            <section
              className="explorer-section"
              aria-labelledby="register-repo-heading"
            >
              <h3 id="register-repo-heading">Register local repository</h3>
              <p className="muted small">
                Path must exist inside the backend&apos;s configured allowed
                root. Raw OS paths are never stored in browser history.
              </p>
              <form
                className="stack-form"
                onSubmit={(event) => void handleRegister(event)}
              >
                <label className="field-label" htmlFor="repo-locator-input">
                  Repository path
                </label>
                <input
                  id="repo-locator-input"
                  value={locator}
                  onChange={(event) => setLocator(event.currentTarget.value)}
                  placeholder="/path/to/local/git-repo"
                  maxLength={4096}
                  autoComplete="off"
                  disabled={registering}
                />
                <button
                  className="btn-primary"
                  type="submit"
                  disabled={registering}
                >
                  {registering ? 'Registering…' : 'Register repository'}
                </button>
              </form>
              {registerNotice ? (
                <p className="notice" role="status">
                  {registerNotice}
                </p>
              ) : null}
              {registerError ? (
                <div className="notice error" role="alert">
                  <span>{registerError}</span>
                </div>
              ) : null}
            </section>

            <section
              className="explorer-section"
              aria-labelledby="repo-list-heading"
            >
              <div className="section-heading-row">
                <h3 id="repo-list-heading">Registered repositories</h3>
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
                  No repositories registered yet. Register one above to run your
                  first pinned scan.
                </p>
              ) : null}
            </section>
          </div>
        </aside>

        <RepositoryScansPanel
          selectedRepo={selectedRepo}
          health={health}
          revision={revision}
          onRevisionChange={(value) => {
            setRevision(value);
            setIdempotencyKey(crypto.randomUUID());
          }}
          submittingScan={submittingScan}
          onTriggerScan={(event) => void handleTriggerScan(event)}
          scanSubmitResult={scanSubmitResult}
          scanSubmitError={scanSubmitError}
          scans={scans}
          scansLoading={scansLoading}
          scansError={scansError}
          onReloadScans={(repoId) => void loadScans(repoId)}
        />
      </div>

      <footer className="page-footer">
        <div className="status-left">
          <span className="status-summary">
            Loopback local control plane · bearer token remains server-side
          </span>
        </div>
        <div className="status-right">
          <ThemeSwitcher theme={theme} onChange={setTheme} />
        </div>
      </footer>
    </div>
  );
}
