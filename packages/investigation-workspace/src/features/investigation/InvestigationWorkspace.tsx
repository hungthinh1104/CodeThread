'use client';

import { useMemo, useRef, type ReactNode, type RefObject } from 'react';
import { EvidenceInspector } from './components/EvidenceInspector.tsx';
import { ExplorerRegion } from './components/ExplorerRegion.tsx';
import { GeneratedNotes } from './components/GeneratedNotes.tsx';
import { MainRegion } from './components/MainRegion.tsx';
import { useAiNotes } from './hooks/useAiNotes.ts';
import { useFileInventory } from './hooks/useFileInventory.ts';
import { useInspectorDrawer } from './hooks/useInspectorDrawer.ts';
import { useInvestigationActions } from './hooks/useInvestigationActions.ts';
import { useProjectionState } from './hooks/useProjectionState.ts';
import { useSymbolPaths } from './hooks/useSymbolPaths.ts';
import { useSymbolSearch } from './hooks/useSymbolSearch.ts';
import { useWorkspaceHistory } from './hooks/useWorkspaceHistory.ts';
import {
  useWorkspaceSession,
  type WorkspaceSessionRefs,
} from './hooks/useWorkspaceSession.ts';
import type { AiStatusResponse, NavigationEntry, Scope } from './types.ts';

const DEFAULT_AI_STATUS: AiStatusResponse = { enabled: false };

function useSessionRefs(): WorkspaceSessionRefs & {
  restoreHandlerRef: RefObject<
    (entry: NavigationEntry, accept: () => void) => Promise<void>
  >;
} {
  const scopeRef = useRef<Scope | null>(null);
  const workspaceGeneration = useRef(0);
  const contextGeneration = useRef(0);
  const selectionGeneration = useRef(0);
  const navigationRestoreGeneration = useRef(0);
  const restoreHandlerRef = useRef<
    (entry: NavigationEntry, accept: () => void) => Promise<void>
  >(async () => {});
  return {
    scopeRef,
    workspaceGeneration,
    contextGeneration,
    selectionGeneration,
    navigationRestoreGeneration,
    restoreHandlerRef,
  };
}

function WorkspaceChrome(props: {
  inspectorModal: boolean;
  canBack: boolean;
  canForward: boolean;
  onMoveHistory: (step: -1 | 1) => void;
  compactViewport: boolean;
  inspectorTriggerRef: RefObject<HTMLButtonElement | null>;
  onOpenInspector: (trigger: HTMLButtonElement) => void;
  expiresAt: string | null;
  children: ReactNode;
}) {
  return (
    <div className="page-shell">
      <header className="page-header" inert={props.inspectorModal}>
        <div>
          <p className="eyebrow">CODETHREAD / LOCAL ANALYSIS</p>
          <h1>Investigation Workspace</h1>
          <p>Trace source-backed relationships in a pinned snapshot.</p>
        </div>
        <nav className="history-controls" aria-label="Investigation history">
          <button
            type="button"
            onClick={() => props.onMoveHistory(-1)}
            disabled={!props.canBack}
          >
            Back
          </button>
          <button
            type="button"
            onClick={() => props.onMoveHistory(1)}
            disabled={!props.canForward}
          >
            Forward
          </button>
        </nav>
        <button
          id="inspector-toggle"
          ref={props.inspectorTriggerRef}
          type="button"
          hidden={!props.compactViewport}
          aria-expanded={props.inspectorModal}
          aria-controls="evidence-inspector"
          aria-haspopup="dialog"
          onClick={(event) => props.onOpenInspector(event.currentTarget)}
        >
          Evidence
        </button>
      </header>
      <p className="scope-note" inert={props.inspectorModal}>
        Local snapshot only · no source execution · unsupported relationships
        and incomplete coverage stay visible.
      </p>
      <div className="workspace-grid">{props.children}</div>
      <footer className="page-footer" inert={props.inspectorModal}>
        <span>Static source evidence · validated API projections</span>
        {props.expiresAt ? (
          <span>
            Viewer expires {new Date(props.expiresAt).toLocaleTimeString()}
          </span>
        ) : null}
      </footer>
    </div>
  );
}

function useInvestigationController(aiStatus: AiStatusResponse) {
  const refs = useSessionRefs();
  const drawer = useInspectorDrawer(refs.selectionGeneration);
  const history = useWorkspaceHistory((entry, accept) =>
    refs.restoreHandlerRef.current(entry, accept),
  );
  const projection = useProjectionState(
    refs.scopeRef,
    refs.selectionGeneration,
    () => drawer.setInspectorOpen(false),
  );
  const resetCallbacksRef = useRef<{
    project: (clearCatalog: boolean) => void;
    workspace: () => void;
  }>({ project: () => {}, workspace: () => {} });

  const sessionState = useWorkspaceSession({
    refs,
    relationKinds: projection.relationKinds,
    direction: projection.direction,
    clearSelection: projection.clearSelection,
    onProjectReset: (clearCatalog) =>
      resetCallbacksRef.current.project(clearCatalog),
    onWorkspaceReset: () => resetCallbacksRef.current.workspace(),
    resetHistory: history.reset,
    pushHistory: history.push,
  });
  const fileInventory = useFileInventory(sessionState.workspace);
  const searchState = useSymbolSearch({
    workspace: sessionState.workspace,
    projects: sessionState.projects,
    session: sessionState.session,
    selectedProjectId: sessionState.selectedProjectId,
    scopeRef: refs.scopeRef,
    contextGenerationRef: refs.contextGeneration,
  });
  resetCallbacksRef.current = {
    project: searchState.resetSearchForProject,
    workspace: () => {
      searchState.resetSearchForWorkspace();
      fileInventory.resetFiles();
    },
  };

  const activeScope: Scope | null =
    sessionState.workspace &&
    sessionState.selectedProjectId &&
    sessionState.session
      ? {
          scanId: sessionState.workspace.scanId,
          projectId: sessionState.selectedProjectId,
          snapshotId: sessionState.session.snapshotId,
        }
      : null;

  const knownProjectSymbols = useMemo(() => {
    const fromSearch = searchState.search.items
      .filter((item) => item.projectId === activeScope?.projectId)
      .map((item) => item.symbol);
    return [...(projection.graph?.graph.symbols ?? []), ...fromSearch];
  }, [
    activeScope?.projectId,
    projection.graph?.graph.symbols,
    searchState.search.items,
  ]);

  const symbolPaths = useSymbolPaths({
    scope: activeScope,
    root: projection.selected,
    relationKinds: projection.relationKinds,
    knownSymbols: knownProjectSymbols,
  });
  const aiNotes = useAiNotes({
    aiStatus,
    scope: activeScope,
    selected: projection.selected,
    relationKinds: projection.relationKinds,
    direction: projection.direction,
  });
  const actions = useInvestigationActions({
    refs,
    workspace: sessionState.workspace,
    projects: sessionState.projects,
    session: sessionState.session,
    setSession: sessionState.setSession,
    resetProject: sessionState.resetProject,
    selectProject: sessionState.selectProject,
    reportWorkspaceError: sessionState.reportWorkspaceError,
    setWorkspaceNotice: sessionState.setWorkspaceNotice,
    selected: projection.selected,
    setSelected: projection.setSelected,
    graph: projection.graph,
    setGraph: projection.setGraph,
    evidence: projection.evidence,
    setEvidence: projection.setEvidence,
    relationKinds: projection.relationKinds,
    setRelationKinds: projection.setRelationKinds,
    direction: projection.direction,
    setDirection: projection.setDirection,
    selectedRelationId: projection.selectedRelationId,
    activeView: projection.activeView,
    setActiveView: projection.setActiveView,
    requestedEvidenceId: projection.requestedEvidenceId,
    invalidateProjectionReads: projection.invalidateProjectionReads,
    resetContextFollow: projection.resetContextFollow,
    clearSelection: projection.clearSelection,
    loadGraph: projection.loadGraph,
    loadEvidence: projection.loadEvidence,
    setContextSearchMessage: projection.setContextSearchMessage,
    pathsResult: symbolPaths.pathsResult,
    setSearchMode: searchState.setSearchMode,
    setSearchOffset: searchState.setSearchOffset,
    setSearchQuery: searchState.setSearchQuery,
    compactViewport: drawer.compactViewport,
    openInspector: drawer.openInspector,
    focusSelectedDeclaration: drawer.focusSelectedDeclaration,
    pushHistory: history.push,
  });
  refs.restoreHandlerRef.current = actions.restoreNavigation;

  return {
    refs,
    drawer,
    history,
    projection,
    sessionState,
    fileInventory,
    searchState,
    symbolPaths,
    aiNotes,
    actions,
  };
}

function renderOptionalNotes(
  aiStatus: AiStatusResponse,
  c: ReturnType<typeof useInvestigationController>,
): ReactNode {
  if (!aiStatus.enabled) return null;
  return (
    <GeneratedNotes
      aiStatus={aiStatus}
      task={c.aiNotes.task}
      onTaskChange={c.aiNotes.setTask}
      canDraft={c.aiNotes.canDraft}
      loading={c.aiNotes.loading}
      notes={c.aiNotes.notes}
      error={c.aiNotes.error}
      onDraft={() => void c.aiNotes.draft()}
      graph={c.projection.graph}
      onSelectEvidence={(id, trigger, relationId) =>
        void c.actions.chooseEvidence(id, trigger, relationId ?? null)
      }
      onFollowSymbol={(symbol) => void c.actions.followSymbol(symbol)}
    />
  );
}

export function InvestigationWorkspace(
  props: { initialAiStatus?: AiStatusResponse } = {},
) {
  const aiStatus = props.initialAiStatus ?? DEFAULT_AI_STATUS;
  const c = useInvestigationController(aiStatus);
  const inspectorModal = c.drawer.compactViewport && c.drawer.inspectorOpen;

  return (
    <WorkspaceChrome
      inspectorModal={inspectorModal}
      canBack={c.history.canBack}
      canForward={c.history.canForward}
      onMoveHistory={c.history.move}
      compactViewport={c.drawer.compactViewport}
      inspectorTriggerRef={c.drawer.inspectorTriggerRef}
      onOpenInspector={c.drawer.openInspector}
      expiresAt={c.sessionState.workspace?.expiresAt ?? null}
    >
      <ExplorerRegion
        inert={inspectorModal}
        repositories={c.sessionState.repositories}
        selectedRepositoryId={c.sessionState.selectedRepositoryId}
        onRepositoryChange={(id) => void c.sessionState.chooseRepository(id)}
        workspace={c.sessionState.workspace}
        projects={c.sessionState.projects}
        selectedProjectId={c.sessionState.selectedProjectId}
        onProjectChange={(id) => {
          ++c.refs.selectionGeneration.current;
          void c.sessionState.selectProject(id);
        }}
        searchQuery={c.searchState.searchQuery}
        onSearchQueryChange={(value) => {
          c.searchState.setSearchQuery(value);
          c.searchState.setSearchOffset(0);
          c.searchState.clearSearchResults();
        }}
        searchMode={c.searchState.searchMode}
        searchEnabled={Boolean(
          c.sessionState.workspace && c.sessionState.session,
        )}
        onSearchModeChange={(value) => {
          c.searchState.setSearchMode(value);
          c.searchState.setSearchOffset(0);
          c.searchState.clearSearchResults();
        }}
        searchItems={c.searchState.search.items}
        searchOffset={c.searchState.search.offset}
        searchTotal={c.searchState.search.total}
        searchNextOffset={c.searchState.search.nextOffset}
        searchLoading={c.searchState.searchLoading}
        searchError={c.searchState.searchError}
        onRetrySearch={c.searchState.retrySearch}
        onSearchPage={(offset) => void c.searchState.chooseSearchPage(offset)}
        onChooseSymbol={(item) => void c.actions.chooseSymbol(item)}
        files={c.fileInventory.files}
        filesLoading={c.fileInventory.filesLoading}
        filesError={c.fileInventory.filesError?.message ?? null}
        onRetryFiles={c.fileInventory.retryFiles}
        onFilesPage={(offset) => void c.fileInventory.chooseFilesPage(offset)}
        onChooseFile={(file) => void c.actions.chooseFile(file)}
        notice={c.sessionState.workspaceNotice}
        error={c.sessionState.workspaceError}
        errorRetryable={c.sessionState.workspaceRetryable}
        onRetryWorkspace={() => void c.sessionState.retryWorkspace()}
      />
      <MainRegion
        inert={inspectorModal}
        headingRef={c.drawer.workspaceHeadingRef}
        selected={c.projection.selected}
        evidence={c.projection.evidence}
        evidenceLoading={c.projection.evidenceLoading}
        graph={c.projection.graph}
        graphLoading={c.projection.graphLoading}
        graphError={c.projection.graphError}
        evidenceError={c.projection.evidenceError}
        onRetryGraph={() => {
          const scope = c.refs.scopeRef.current;
          if (scope && c.projection.selected)
            void c.projection.loadGraph(
              c.projection.selected,
              scope,
              c.projection.relationKinds,
              c.projection.direction,
            );
        }}
        onRetryEvidence={c.actions.readDeclarationEvidence}
        session={c.sessionState.session}
        activeView={c.projection.activeView}
        onViewChange={c.actions.chooseView}
        relationKinds={c.projection.relationKinds}
        onRelationKindsChange={(value) => void c.actions.changeFilters(value)}
        direction={c.projection.direction}
        onDirectionChange={(value) =>
          void c.actions.changeFilters(c.projection.relationKinds, value)
        }
        selectedRelationId={c.projection.selectedRelationId}
        onSelectEvidence={(id, trigger, relationId) =>
          void c.actions.chooseEvidence(id, trigger, relationId ?? null)
        }
        onFollowSymbol={(symbol) => void c.actions.followSymbol(symbol)}
        contextCandidates={c.projection.contextCandidates}
        contextSearchLoading={c.projection.contextSearchLoading}
        contextSearchMessage={c.projection.contextSearchMessage}
        onFindContexts={() =>
          void c.projection.findMatchingContexts(c.sessionState.projects)
        }
        onChooseContext={(candidate) =>
          void c.actions.chooseContextCandidate(candidate)
        }
        symbolPaths={c.symbolPaths}
      />
      <EvidenceInspector
        item={c.projection.evidence}
        loading={c.projection.evidenceLoading}
        error={c.projection.evidenceError}
        onRetry={() => {
          const scope = c.refs.scopeRef.current;
          const id = c.projection.requestedEvidenceId.current;
          if (scope && id)
            void c.projection.loadEvidence(
              id,
              scope,
              c.projection.selectedRelationId,
            );
        }}
        compact={c.drawer.compactViewport}
        open={c.drawer.inspectorOpen}
        onClose={c.drawer.closeInspector}
        closeButtonRef={c.drawer.inspectorCloseRef}
        generatedNotes={renderOptionalNotes(aiStatus, c)}
      />
    </WorkspaceChrome>
  );
}
