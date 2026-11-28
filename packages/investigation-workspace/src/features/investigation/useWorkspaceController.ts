import { useRef } from 'react';
import {
  loadScopedDeclaration,
  restoreNavigationEntry,
} from './navigation-restore.ts';
import { projectScope } from './scoped-api.ts';
import type {
  CodeSymbol,
  FilePage,
  FollowContextProjection,
  Scope,
  SearchItem,
} from './types.ts';
import { useExplorerData } from './useExplorerData.ts';
import { useAiNotes } from './useAiNotes.ts';
import { useInspectorFocus } from './useInspectorFocus.ts';
import { useProjectionState } from './useProjectionState.ts';
import {
  useWorkspaceHistory,
  type NavigationEntry,
} from './useWorkspaceHistory.ts';
import { useWorkspaceSession } from './useWorkspaceSession.ts';

export function useWorkspaceController() {
  const scopeRef = useRef<Scope | null>(null);
  const contextGeneration = useRef(0);
  const navigationRestoreGeneration = useRef(0);
  const selectionGeneration = useRef(0);

  const inspector = useInspectorFocus();
  const history = useWorkspaceHistory(restoreNavigation);
  const explorerRef = useRef<ReturnType<typeof useExplorerData> | null>(null);
  const projRef = useRef<ReturnType<typeof useProjectionState> | null>(null);

  function resetNavigation(entry: NavigationEntry | null) {
    ++navigationRestoreGeneration.current;
    history.reset(entry);
  }

  function pushNavigation(entry: NavigationEntry) {
    ++navigationRestoreGeneration.current;
    history.push(entry);
  }

  const ws = useWorkspaceSession({
    scopeRef,
    contextGenerationRef: contextGeneration,
    navigationRestoreGenerationRef: navigationRestoreGeneration,
    selectionGenerationRef: selectionGeneration,
    getFilterDefaults: () => ({
      relationKinds: projRef.current?.relationKinds ?? ['calls'],
      direction: projRef.current?.direction ?? 'both',
    }),
    onResetProject: (clearCatalog) => {
      projRef.current?.clearSelection();
      explorerRef.current?.resetForProject(clearCatalog);
    },
    onResetWorkspace: () => {
      explorerRef.current?.resetForWorkspace();
    },
    onUnmountInvalidate: () => {
      explorerRef.current?.invalidateAll();
      projRef.current?.invalidateProjectionReads();
    },
    onResetHistory: resetNavigation,
    onPushHistory: pushNavigation,
  });

  const explorer = useExplorerData({
    workspace: ws.workspace,
    projects: ws.projects,
    session: ws.session,
    selectedProjectId: ws.selectedProjectId,
    scopeRef,
    contextGenerationRef: contextGeneration,
  });
  explorerRef.current = explorer;

  const proj = useProjectionState({
    scopeRef,
    selectionGenerationRef: selectionGeneration,
    projects: ws.projects,
    resetInspector: inspector.resetInspector,
  });
  projRef.current = proj;

  const aiNotes = useAiNotes({
    scope: scopeRef.current,
    root: proj.selected,
    relationKinds: proj.relationKinds,
    direction: proj.direction,
  });

  function openScopedDeclaration(
    scope: Scope,
    symbolId: string,
    generation: number,
    reportError: (message: string | null) => void,
  ): Promise<boolean> {
    const contextAtStart = contextGeneration.current;
    return loadScopedDeclaration({
      scope,
      symbolId,
      currentScope: scopeRef.current,
      currentSession: ws.session,
      relationKinds: proj.relationKinds,
      direction: proj.direction,
      isCurrent: () =>
        generation === selectionGeneration.current &&
        contextAtStart === contextGeneration.current,
      reportError,
      onCommit: ({
        scope: nextScope,
        changesProject,
        destination,
        root,
        projection,
        declaration,
      }) => {
        if (changesProject) {
          ws.resetProject(nextScope.projectId);
          scopeRef.current = nextScope;
          ws.setSession(destination);
        } else {
          proj.clearSelection();
        }
        proj.setSelected(root);
        proj.setGraph(projection);
        proj.setEvidence(declaration);
        proj.requestedEvidenceId.current = root.declarationEvidenceId;
        pushNavigation({
          ...nextScope,
          root,
          relationKinds: proj.relationKinds,
          direction: proj.direction,
          selectedRelationId: null,
          selectedEvidenceId: root.declarationEvidenceId,
          view: 'source',
        });
      },
    });
  }

  function selectInActiveScope(
    symbol: CodeSymbol,
    scope: Scope,
    generation: number,
    alwaysFocus: boolean,
  ) {
    ws.reportWorkspaceError(null);
    ws.setWorkspaceNotice(null);
    proj.setSelected(symbol);
    proj.clearContextSearch();
    proj.setActiveView('source');
    pushNavigation({
      ...scope,
      root: symbol,
      relationKinds: proj.relationKinds,
      direction: proj.direction,
      selectedRelationId: null,
      selectedEvidenceId: symbol.declarationEvidenceId,
      view: 'source',
    });
    void proj.loadGraph(symbol, scope, proj.relationKinds, proj.direction);
    void proj.loadEvidence(symbol.declarationEvidenceId, scope);
    inspector.focusSelectedDeclaration(
      () => generation === selectionGeneration.current,
      alwaysFocus,
    );
  }

  async function chooseSymbol(item: SearchItem) {
    const generation = ++selectionGeneration.current;
    const active = scopeRef.current;
    const scope =
      active?.projectId === item.projectId
        ? active
        : projectScope(item.projectId, ws.workspace, ws.projects);
    if (
      !scope ||
      scope.projectId !== item.projectId ||
      scope.snapshotId !== item.snapshotId ||
      item.symbol.snapshotId !== item.snapshotId
    ) {
      ws.reportWorkspaceError(
        'The selected symbol does not match the active snapshot identity.',
      );
      return;
    }
    if (scope !== active) {
      if (
        await openScopedDeclaration(
          scope,
          item.symbol.id,
          generation,
          ws.reportWorkspaceError,
        )
      )
        inspector.focusSelectedDeclaration(
          () => generation === selectionGeneration.current,
        );
      return;
    }
    selectInActiveScope(item.symbol, scope, generation, false);
  }

  async function chooseFile(file: FilePage['items'][number]) {
    const generation = ++selectionGeneration.current;
    ws.setWorkspaceNotice(null);
    if (file.status !== 'analyzed') {
      ws.reportWorkspaceError(
        file.analysisReason
          ? `${file.status}: ${file.analysisReason}`
          : `This file is ${file.status}; no source excerpt is available.`,
      );
      return;
    }
    const isReady = (id: string) =>
      ws.projects?.items.some(
        (item) => item.id === id && item.status === 'ready' && item.snapshotId,
      ) ?? false;
    const activeProjectId = scopeRef.current?.projectId;
    const contextId =
      activeProjectId &&
      file.projectIds.includes(activeProjectId) &&
      isReady(activeProjectId)
        ? activeProjectId
        : file.projectIds.find(isReady);
    if (!contextId) {
      ws.reportWorkspaceError(
        'No ready project context contains this analyzed file.',
      );
      return;
    }
    if (contextId !== scopeRef.current?.projectId) {
      const scope = await ws.selectProject(contextId);
      if (!scope || generation !== selectionGeneration.current) return;
      const context = ws.projects?.items.find((item) => item.id === contextId);
      if (
        scope.projectId !== contextId ||
        scope.snapshotId !== context?.snapshotId
      )
        return;
    }
    explorer.filterByFilePath(file.path);
    ws.reportWorkspaceError(null);
    ws.setWorkspaceNotice(
      'Full-file source is not available; matching declarations are shown from verified snapshot evidence.',
    );
  }

  function followSymbol(symbol: CodeSymbol) {
    const generation = ++selectionGeneration.current;
    const scope = scopeRef.current;
    if (!scope || symbol.snapshotId !== scope.snapshotId) {
      ws.reportWorkspaceError(
        'The target is not part of the active immutable snapshot.',
      );
      return;
    }
    selectInActiveScope(symbol, scope, generation, true);
  }

  async function chooseEvidence(
    id: string,
    trigger: HTMLButtonElement,
    relationId: string | null = null,
    verifiedFromPath = false,
  ) {
    const scope = scopeRef.current;
    if (
      !scope ||
      (!verifiedFromPath &&
        !proj.graph?.graph.evidenceRefs.some((item) => item.id === id) &&
        !proj.graph?.unknowns.items.some((item) => item.evidenceId === id) &&
        proj.selected?.declarationEvidenceId !== id)
    ) {
      ws.reportWorkspaceError(
        'Evidence selection is not present in the current validated projection.',
      );
      return;
    }
    ++selectionGeneration.current;
    inspector.revealInspector(trigger);
    pushNavigation({
      ...scope,
      root: proj.selected,
      relationKinds: proj.relationKinds,
      direction: proj.direction,
      selectedRelationId: relationId,
      selectedEvidenceId: id,
      view: proj.activeView,
    });
    await proj.loadEvidence(id, scope, relationId);
  }

  async function chooseContextCandidate(
    candidate: FollowContextProjection['candidates'][number],
  ) {
    const generation = ++selectionGeneration.current;
    const scope = projectScope(candidate.projectId, ws.workspace, ws.projects);
    if (!scope || scope.snapshotId !== candidate.snapshotId) {
      proj.setContextSearchMessage(
        'The destination context is no longer ready or its snapshot identity changed.',
      );
      return;
    }
    await openScopedDeclaration(
      scope,
      candidate.symbolId,
      generation,
      proj.setContextSearchMessage,
    );
  }

  function changeFilters(
    kinds: ('calls' | 'references')[],
    newDirection = proj.direction,
  ) {
    if (!kinds.length) return;
    ++selectionGeneration.current;
    proj.setRelationKinds(kinds);
    proj.setDirection(newDirection);
    const scope = scopeRef.current;
    const root = proj.selected;
    if (!scope || !root) return;
    const keepDeclaration =
      proj.requestedEvidenceId.current === root.declarationEvidenceId;
    const targetView = proj.activeView === 'paths' ? 'paths' : 'trace';
    proj.setActiveView(targetView);
    pushNavigation({
      ...scope,
      root,
      relationKinds: kinds,
      direction: newDirection,
      selectedRelationId: null,
      selectedEvidenceId: keepDeclaration ? root.declarationEvidenceId : null,
      view: targetView,
    });
    void proj.loadGraph(root, scope, kinds, newDirection, {
      preserveDeclarationEvidence: true,
    });
  }

  async function restoreNavigation(entry: NavigationEntry, accept: () => void) {
    const selection = ++selectionGeneration.current;
    const generation = ++navigationRestoreGeneration.current;
    await restoreNavigationEntry({
      entry,
      workspace: ws.workspace,
      projects: ws.projects,
      currentScope: scopeRef.current,
      currentSession: ws.session,
      isCurrent: () =>
        generation === navigationRestoreGeneration.current &&
        selection === selectionGeneration.current,
      invalidateProjectionReads: proj.invalidateProjectionReads,
      reportError: ws.reportWorkspaceError,
      onCommit: ({ scope, changesProject, destination, root, projection }) => {
        if (changesProject) {
          ws.resetProject(scope.projectId);
          scopeRef.current = scope;
          ws.setSession(destination);
        } else {
          proj.clearSelection();
        }
        proj.setRelationKinds(entry.relationKinds);
        proj.setDirection(entry.direction);
        proj.setSelected(root);
        proj.setActiveView(entry.view);
        proj.setGraph(projection);
        accept();
      },
      onLoadEvidence: (id, scope, relationId) => {
        void proj.loadEvidence(id, scope, relationId);
      },
    });
  }

  return {
    history,
    inspector,
    workspace: ws.workspace,
    sessionExpired: ws.sessionExpired,
    explorerModel: {
      repositories: ws.repositories,
      selectedRepositoryId: ws.selectedRepositoryId,
      selectedSymbolId: proj.selected?.id ?? null,
      workspace: ws.workspace,
      projects: ws.projects,
      selectedProjectId: ws.selectedProjectId,
      searchMode: explorer.searchMode,
      searchQuery: explorer.searchQuery,
      searchEnabled: Boolean(ws.workspace && ws.session),
      search: explorer.search,
      searchLoading: explorer.searchLoading,
      searchError: explorer.searchError,
      files: explorer.files,
      filesLoading: explorer.filesLoading,
      filesError: explorer.filesError?.message ?? null,
      notice: ws.workspaceNotice,
      error: ws.workspaceError,
      errorRetryable: ws.workspaceRetryable,
      onRepositoryChange: (id: string) => void ws.chooseRepository(id),
      onProjectChange: (id: string) => {
        ++selectionGeneration.current;
        void ws.selectProject(id);
      },
      onSearchQueryChange: explorer.updateSearchQuery,
      onSearchModeChange: explorer.updateSearchMode,
      onRetrySearch: explorer.retrySearch,
      onSearchPage: explorer.chooseSearchPage,
      onChooseSymbol: (item: SearchItem) => void chooseSymbol(item),
      onRetryFiles: explorer.retryFiles,
      onFilesPage: (offset: number) => void explorer.chooseFilesPage(offset),
      onChooseFile: (file: FilePage['items'][number]) => void chooseFile(file),
      onRetryWorkspace: () => void ws.retryWorkspace(),
    },
    mainModel: {
      scope: scopeRef.current,
      selected: proj.selected,
      evidence: proj.evidence,
      evidenceLoading: proj.evidenceLoading,
      evidenceError: proj.evidenceError,
      graph: proj.graph,
      graphLoading: proj.graphLoading,
      graphError: proj.graphError,
      session: ws.session,
      activeView: proj.activeView,
      relationKinds: proj.relationKinds,
      direction: proj.direction,
      selectedRelationId: proj.selectedRelationId,
      contextCandidates: proj.contextCandidates,
      contextSearchLoading: proj.contextSearchLoading,
      contextSearchMessage: proj.contextSearchMessage,
      onViewChange: proj.chooseView,
      onRelationKindsChange: (value: ('calls' | 'references')[]) =>
        changeFilters(value),
      onDirectionChange: (value: 'outgoing' | 'incoming' | 'both') =>
        changeFilters(proj.relationKinds, value),
      onSelectEvidence: (
        id: string,
        trigger: HTMLButtonElement,
        relationId?: string,
        verifiedFromPath?: boolean,
      ) =>
        void chooseEvidence(
          id,
          trigger,
          relationId ?? null,
          Boolean(verifiedFromPath),
        ),
      onFollowSymbol: followSymbol,
      onRetryGraph: proj.retryGraph,
      onRetryEvidence: proj.readDeclarationEvidence,
      onFindContexts: () => void proj.findMatchingContexts(),
      onChooseContext: (
        candidate: FollowContextProjection['candidates'][number],
      ) => void chooseContextCandidate(candidate),
      ai: {
        ...aiNotes,
        onExplainPath: (target: CodeSymbol, depth: number) => {
          proj.chooseView('notes');
          aiNotes.onExplainPath(target, depth);
        },
      },
    },
    inspectorModel: {
      item: proj.evidence,
      evidenceRole: proj.evidenceRole,
      loading: proj.evidenceLoading,
      error: proj.evidenceError,
      onRetry: proj.retryEvidence,
    },
  };
}
