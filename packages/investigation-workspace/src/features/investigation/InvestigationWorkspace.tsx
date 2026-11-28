'use client';

import { AppHeader, AppStatusBar } from '../shared/AppChrome.tsx';
import { EvidenceInspector } from './EvidenceInspector.tsx';
import { ExplorerRegion } from './ExplorerRegion.tsx';
import { MainRegion } from './MainRegion.tsx';
import { useWorkbenchLayout } from './useWorkbenchLayout.ts';
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
    verifiedFromPath?: boolean,
  ) => {
    layout.expandInspector();
    mainModel.onSelectEvidence(id, trigger, relationId, verifiedFromPath);
  };

  return (
    <div className="page-shell">
      <AppHeader
        screen="investigate"
        title="Investigation Workspace"
        activeScanId={workspace?.scanId ?? null}
        inert={inspector.inspectorModal}
        context={
          workspace && activeRepo ? (
            <>
              <span className="header-context-repo">{activeRepo.label}</span>
              <span aria-hidden="true">·</span>
              <code>{workspace.revision}</code>
            </>
          ) : null
        }
        actions={
          <>
            <nav
              className="history-controls"
              aria-label="Investigation history"
            >
              <button
                type="button"
                onClick={() => history.move(-1)}
                disabled={!history.canBack}
                title="Back to previous step"
              >
                Back
              </button>
              <button
                type="button"
                onClick={() => history.move(1)}
                disabled={!history.canForward}
                title="Forward to next step"
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
          </>
        }
      />
      <div className="workspace-grid">
        <ExplorerRegion
          inert={inspector.inspectorModal}
          compact={inspector.compactViewport}
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
      <AppStatusBar
        summary="Pinned snapshot · static evidence"
        inert={inspector.inspectorModal}
        leftExtra={
          !inspector.compactViewport && layout.isCustomized ? (
            <button
              className="status-btn"
              type="button"
              onClick={layout.resetLayout}
            >
              Reset layout
            </button>
          ) : null
        }
        rightExtra={
          workspace ? (
            <span
              className={sessionExpired ? 'status-expired' : 'status-expiry'}
              role={sessionExpired ? 'status' : undefined}
            >
              {sessionExpired
                ? 'Session expired — reselect a repository.'
                : `Expires ${formatExpiry(workspace.expiresAt)}`}
            </span>
          ) : null
        }
        theme={layout.theme}
        onThemeChange={layout.setTheme}
      />
    </div>
  );
}
