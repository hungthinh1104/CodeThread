'use client';

import { EvidenceInspector } from './EvidenceInspector.tsx';
import { ExplorerRegion } from './ExplorerRegion.tsx';
import { MainRegion } from './MainRegion.tsx';
import {
  useWorkbenchLayout,
  type ThemePreference,
} from './useWorkbenchLayout.ts';
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
  const layout = useWorkbenchLayout();

  const activeRepo = explorerModel.repositories.find(
    (item) => item.id === explorerModel.selectedRepositoryId,
  );
  const handleSelectEvidence = (
    id: string,
    trigger: HTMLButtonElement,
    relationId?: string,
  ) => {
    layout.expandInspector();
    mainModel.onSelectEvidence(id, trigger, relationId);
  };

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
      <div className="workspace-grid" style={layout.gridStyle}>
        <ExplorerRegion
          inert={inspector.inspectorModal}
          collapsed={!inspector.compactViewport && layout.explorerCollapsed}
          width={layout.explorerWidth}
          onToggleCollapse={layout.toggleExplorer}
          onResizePointerDown={(event) => layout.startResize('explorer', event)}
          onResizeKeyDown={(event) =>
            layout.handleResizeKeyDown('explorer', event)
          }
          onResetWidth={layout.resetExplorerWidth}
          model={explorerModel}
        />
        <MainRegion
          inert={inspector.inspectorModal}
          headingRef={inspector.workspaceHeadingRef}
          model={{ ...mainModel, onSelectEvidence: handleSelectEvidence }}
        />
        <EvidenceInspector
          item={inspectorModel.item}
          evidenceRole={inspectorModel.evidenceRole}
          loading={inspectorModel.loading}
          error={inspectorModel.error}
          onRetry={inspectorModel.onRetry}
          compact={inspector.compactViewport}
          open={inspector.inspectorOpen}
          collapsed={layout.inspectorCollapsed}
          dockPosition={layout.isMediumDock ? 'bottom' : 'right'}
          dockSize={
            layout.isMediumDock ? layout.inspectorHeight : layout.inspectorWidth
          }
          onToggleCollapse={layout.toggleInspector}
          onResizePointerDown={(event) =>
            layout.startResize(
              layout.isMediumDock ? 'inspector-y' : 'inspector-x',
              event,
            )
          }
          onResizeKeyDown={(event) =>
            layout.handleResizeKeyDown(
              layout.isMediumDock ? 'inspector-y' : 'inspector-x',
              event,
            )
          }
          onResetSize={layout.resetInspectorSize}
          onClose={inspector.closeInspector}
          closeButtonRef={inspector.inspectorCloseRef}
        />
      </div>
      <footer className="page-footer" inert={inspector.inspectorModal}>
        <div className="status-left">
          {!inspector.compactViewport ? (
            <div className="dock-controls" aria-label="Workbench layout">
              <button
                className="status-btn"
                type="button"
                aria-pressed={!layout.explorerCollapsed}
                onClick={layout.toggleExplorer}
              >
                {layout.explorerCollapsed ? 'Show explorer' : 'Hide explorer'}
              </button>
              <button
                className="status-btn"
                type="button"
                aria-pressed={!layout.inspectorCollapsed}
                onClick={layout.toggleInspector}
              >
                {layout.inspectorCollapsed ? 'Show evidence' : 'Hide evidence'}
              </button>
              {layout.isCustomized ? (
                <button
                  className="status-btn"
                  type="button"
                  onClick={layout.resetLayout}
                >
                  Reset layout
                </button>
              ) : null}
            </div>
          ) : null}
          <span className="status-summary">
            Local snapshot only · static evidence · validated API projections
          </span>
        </div>
        <div className="status-right">
          {workspace ? (
            <span role={sessionExpired ? 'status' : undefined}>
              {sessionExpired
                ? 'Viewer session expired — reselect a repository or retry.'
                : `Viewer expires ${formatExpiry(workspace.expiresAt)}`}
            </span>
          ) : null}
          <div className="theme-switcher" role="group" aria-label="Color theme">
            {(['system', 'light', 'dark'] as const).map(
              (option: ThemePreference) => (
                <button
                  key={option}
                  className={`theme-btn${layout.theme === option ? ' is-active' : ''}`}
                  type="button"
                  aria-pressed={layout.theme === option}
                  onClick={() => layout.setTheme(option)}
                >
                  {option === 'system'
                    ? 'Auto'
                    : option === 'light'
                      ? 'Light'
                      : 'Dark'}
                </button>
              ),
            )}
          </div>
        </div>
      </footer>
    </div>
  );
}
