'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { readRememberedWorkspaceScan } from '../investigation/api.ts';
import type { ThemePreference } from '../investigation/useWorkbenchLayout.ts';
import { ThemeSwitcher } from './StatusChrome.tsx';

export type WorkspaceScreen = 'investigate' | 'repositories' | 'scan';

type AppHeaderProps = {
  screen: WorkspaceScreen;
  title: string;
  activeScanId?: string | null;
  context?: ReactNode;
  actions?: ReactNode;
  inert?: boolean;
};

export function AppHeader({
  screen,
  title,
  activeScanId,
  context,
  actions,
  inert,
}: AppHeaderProps) {
  const [rememberedScanId, setRememberedScanId] = useState<string | null>(null);

  useEffect(() => {
    setRememberedScanId(readRememberedWorkspaceScan());
  }, [activeScanId, screen]);

  const scanLinkId = activeScanId ?? rememberedScanId;

  return (
    <header className="page-header" inert={inert}>
      <div className="header-left">
        <div className="header-brand">
          <Link className="brand-mark" href="/">
            CodeThread
          </Link>
          <h1 className="sr-only">{title}</h1>
        </div>
        <nav className="screen-nav" aria-label="Primary navigation">
          <Link
            id="nav-investigate"
            className={`screen-nav-link${screen === 'investigate' ? ' is-active' : ''}`}
            href="/"
            aria-current={screen === 'investigate' ? 'page' : undefined}
          >
            Investigate
          </Link>
          <Link
            id="nav-repositories"
            className={`screen-nav-link${screen === 'repositories' ? ' is-active' : ''}`}
            href="/repositories"
            aria-current={screen === 'repositories' ? 'page' : undefined}
          >
            Repositories
          </Link>
          {scanLinkId ? (
            <Link
              id="nav-scan"
              className={`screen-nav-link${screen === 'scan' ? ' is-active' : ''}`}
              href={`/scans/${scanLinkId}`}
              aria-current={screen === 'scan' ? 'page' : undefined}
            >
              Scan
            </Link>
          ) : null}
        </nav>
        {context ? <div className="header-context">{context}</div> : null}
      </div>
      {actions ? <div className="header-actions">{actions}</div> : null}
    </header>
  );
}

type AppStatusBarProps = {
  summary: string;
  leftExtra?: ReactNode;
  rightExtra?: ReactNode;
  theme: ThemePreference;
  onThemeChange: (next: ThemePreference) => void;
  inert?: boolean;
};

export function AppStatusBar({
  summary,
  leftExtra,
  rightExtra,
  theme,
  onThemeChange,
  inert,
}: AppStatusBarProps) {
  return (
    <footer className="page-footer" inert={inert}>
      <div className="status-left">
        <span className="status-summary">{summary}</span>
        {leftExtra}
      </div>
      <div className="status-right">
        {rightExtra}
        <ThemeSwitcher theme={theme} onChange={onThemeChange} />
      </div>
    </footer>
  );
}
