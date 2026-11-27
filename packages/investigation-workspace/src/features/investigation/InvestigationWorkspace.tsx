'use client';

import { EvidenceInspector } from './EvidenceInspector.tsx';
import { ExplorerRegion } from './ExplorerRegion.tsx';
import { MainRegion } from './MainRegion.tsx';
import { useWorkspaceController } from './useWorkspaceController.ts';

function formatExpiry(expiresAt: string): string {
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return expiresAt;
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

export function InvestigationWorkspace() {
  const {
    history,
    inspector,
    workspace,
    sessionExpired,
    explorerModel,
    mainModel,
    inspectorModel,
  } = useWorkspaceController();

  const activeRepo = explorerModel.repositories.find(
    (item) => item.id === explorerModel.selectedRepositoryId,
  );

  return (
    <div className="page-shell">
      <header className="page-header" inert={inspector.inspectorModal}>
        <div className="header-brand">
          <span className="brand-kicker">CODETHREAD</span>
          <span className="brand-sep" aria-hidden="true">
            /
          </span>
          <h1>Investigation Workspace</h1>
          {workspace && activeRepo ? (
            <span className="header-context">
              <span>{activeRepo.label}</span>
              <span aria-hidden="true">·</span>
              <code>{workspace.revision}</code>
            </span>
          ) : (
            <p className="header-subtitle">
              Trace source-backed relationships in a pinned snapshot.
            </p>
          )}
        </div>
        <div className="header-actions">
          <nav className="history-controls" aria-label="Investigation history">
            <button
              type="button"
              onClick={() => history.move(-1)}
              disabled={!history.canBack}
              title="Back to previous investigation step"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => history.move(1)}
              disabled={!history.canForward}
              title="Forward to next investigation step"
            >
              Forward
            </button>
            {history.total > 1 ? (
              <span
                className="history-position"
                aria-live="polite"
                aria-label={`History step ${history.step} of ${history.total}`}
              >
                {history.step}/{history.total}
              </span>
            ) : null}
          </nav>
          <button
            id="inspector-toggle"
            ref={inspector.inspectorTriggerRef}
            type="button"
            hidden={!inspector.compactViewport}
            aria-expanded={inspector.inspectorModal}
            aria-controls="evidence-inspector"
            aria-haspopup="dialog"
            onClick={(event) => inspector.openInspector(event.currentTarget)}
          >
            Evidence
          </button>
        </div>
      </header>
      <div className="workspace-grid">
        <ExplorerRegion
          inert={inspector.inspectorModal}
          model={explorerModel}
        />
        <MainRegion
          inert={inspector.inspectorModal}
          headingRef={inspector.workspaceHeadingRef}
          model={mainModel}
        />
        <EvidenceInspector
          item={inspectorModel.item}
          evidenceRole={inspectorModel.evidenceRole}
          loading={inspectorModel.loading}
          error={inspectorModel.error}
          onRetry={inspectorModel.onRetry}
          compact={inspector.compactViewport}
          open={inspector.inspectorOpen}
          onClose={inspector.closeInspector}
          closeButtonRef={inspector.inspectorCloseRef}
        />
      </div>
      <footer className="page-footer" inert={inspector.inspectorModal}>
        <span>
          Local snapshot only · no source execution · static evidence ·
          validated API projections
        </span>
        {workspace ? (
          <span role={sessionExpired ? 'status' : undefined}>
            {sessionExpired
              ? 'Viewer session expired — reselect a repository or retry.'
              : `Viewer expires ${formatExpiry(workspace.expiresAt)}`}
          </span>
        ) : null}
      </footer>
    </div>
  );
}
