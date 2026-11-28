'use client';

import { useEffect, useState } from 'react';
import type { ThemePreference } from '../investigation/useWorkbenchLayout.ts';
import type { HealthStatus, ScanState } from './admin-api.ts';

const STORAGE_KEY = 'codethread-workspace-layout-v1';

export function useStandaloneTheme() {
  const [theme, setTheme] = useState<ThemePreference>('system');
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { theme?: unknown };
        if (
          parsed.theme === 'system' ||
          parsed.theme === 'light' ||
          parsed.theme === 'dark'
        )
          setTheme(parsed.theme);
      }
    } catch {
      // Ignore storage errors.
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = theme;
    if (!hydrated) return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const existing = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...existing, theme }));
    } catch {
      // Ignore storage errors.
    }
  }, [theme, hydrated]);

  return { theme, setTheme };
}

export function ThemeSwitcher({
  theme,
  onChange,
}: {
  theme: ThemePreference;
  onChange: (next: ThemePreference) => void;
}) {
  return (
    <div className="theme-switcher" role="group" aria-label="Color theme">
      {(['system', 'light', 'dark'] as const).map((option) => (
        <button
          key={option}
          className={`theme-btn${theme === option ? ' is-active' : ''}`}
          type="button"
          aria-pressed={theme === option}
          onClick={() => onChange(option)}
        >
          {option === 'system' ? 'Auto' : option === 'light' ? 'Light' : 'Dark'}
        </button>
      ))}
    </div>
  );
}

export function ScanStateBadge({ state }: { state: ScanState }) {
  const tone =
    state === 'succeeded'
      ? 'state-ready'
      : state === 'failed'
        ? 'state-error'
        : state === 'cancelled'
          ? 'state-muted'
          : 'state-active';
  return <span className={`state-badge ${tone}`}>{state}</span>;
}

export function HealthSummary({
  health,
  error,
}: {
  health: HealthStatus | null;
  error: string | null;
}) {
  if (error) {
    return (
      <div className="notice error" role="alert">
        <span>{error}</span>
      </div>
    );
  }
  if (!health) {
    return <p className="muted small">Checking local backend readiness…</p>;
  }
  return (
    <ul className="coverage-checks" aria-label="Backend readiness">
      <li className="check-complete">
        <span className="check-label">API:</span>
        <span className="check-state">{health.api}</span>
      </li>
      <li
        className={
          health.database === 'ready' ? 'check-complete' : 'check-incomplete'
        }
      >
        <span className="check-label">Database:</span>
        <span className="check-state">{health.database}</span>
      </li>
      <li
        className={
          health.worker === 'ready' ? 'check-complete' : 'check-incomplete'
        }
      >
        <span className="check-label">Worker:</span>
        <span className="check-state">{health.worker}</span>
      </li>
      <li className={health.ready ? 'check-complete' : 'check-incomplete'}>
        <span className="check-label">Overall:</span>
        <span className="check-state">
          {health.ready ? 'ready' : 'degraded'}
        </span>
      </li>
    </ul>
  );
}
