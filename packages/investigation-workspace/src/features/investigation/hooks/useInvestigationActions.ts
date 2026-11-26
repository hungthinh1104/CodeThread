import {
  errorMessage,
  evidenceId,
  projectScope,
  readEvidence,
  readGraph,
  readSession,
} from '../queries.ts';
import type {
  CodeSymbol,
  FilePage,
  FollowContextProjection,
  InvestigationView,
  NavigationEntry,
  ProjectContexts,
  RelationKindFilter,
  Scope,
  SearchItem,
} from '../types.ts';
import {
  createRestoreHandler,
  isAllowedEvidence,
  type InvestigationActionsInput,
} from './historyRestore.ts';

export type { InvestigationActionsInput };

function resolveReadyFileContext(
  file: FilePage['items'][number],
  projects: ProjectContexts | null,
  activeProjectId: string | undefined,
): string | undefined {
  const isReady = (id: string) =>
    projects?.items.some(
      (item) => item.id === id && item.status === 'ready' && item.snapshotId,
    ) ?? false;
  return activeProjectId &&
    file.projectIds.includes(activeProjectId) &&
    isReady(activeProjectId)
    ? activeProjectId
    : file.projectIds.find(isReady);
}

function createSelectionActions(
  input: InvestigationActionsInput,
  pushNavigation: (entry: NavigationEntry) => void,
) {
  const { refs } = input;

  async function openScopedDeclaration(
    scope: Scope,
    symbolId: string,
    generation: number,
    reportError: (message: string | null) => void,
  ): Promise<boolean> {
    const contextAtStart = refs.contextGeneration.current;
    const isCurrent = () =>
      generation === refs.selectionGeneration.current &&
      contextAtStart === refs.contextGeneration.current;
    const current = refs.scopeRef.current;
    const changesProject =
      scope.scanId !== current?.scanId ||
      scope.projectId !== current.projectId ||
      scope.snapshotId !== current.snapshotId;
    reportError(null);
    try {
      const destination = changesProject
        ? await readSession(scope)
        : input.session;
      if (!destination || !isCurrent()) return false;
      const projection = await readGraph(
        symbolId,
        scope,
        input.relationKinds,
        input.direction,
      );
      if (!isCurrent()) return false;
      const root = projection.graph.symbols.find(
        (symbol) =>
          symbol.id === symbolId && symbol.snapshotId === scope.snapshotId,
      );
      if (!root || projection.graph.rootSymbolId !== symbolId) {
        reportError(
          'The destination query did not return the verified declaration.',
        );
        return false;
      }
      const declaration = await readEvidence(root.declarationEvidenceId, scope);
      if (!isCurrent()) return false;
      if (changesProject) {
        input.resetProject(scope.projectId);
        refs.scopeRef.current = scope;
        input.setSession(destination);
      } else {
        input.clearSelection();
      }
      input.setSelected(root);
      input.setGraph(projection);
      input.setEvidence(declaration);
      input.requestedEvidenceId.current = root.declarationEvidenceId;
      pushNavigation({
        ...scope,
        root,
        relationKinds: input.relationKinds,
        direction: input.direction,
        selectedRelationId: null,
        selectedEvidenceId: root.declarationEvidenceId,
        view: 'source',
      });
      return true;
    } catch (error) {
      if (isCurrent()) reportError(errorMessage(error));
      return false;
    }
  }

  async function chooseSymbol(item: SearchItem) {
    const generation = ++refs.selectionGeneration.current;
    const active = refs.scopeRef.current;
    const scope =
      active?.projectId === item.projectId
        ? active
        : projectScope(item.projectId, input.workspace, input.projects);
    if (
      !scope ||
      scope.projectId !== item.projectId ||
      scope.snapshotId !== item.snapshotId ||
      item.symbol.snapshotId !== item.snapshotId
    ) {
      input.reportWorkspaceError(
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
          input.reportWorkspaceError,
        )
      )
        input.focusSelectedDeclaration(generation);
      return;
    }
    input.setSelected(item.symbol);
    input.resetContextFollow();
    input.setActiveView('source');
    pushNavigation({
      ...scope,
      root: item.symbol,
      relationKinds: input.relationKinds,
      direction: input.direction,
      selectedRelationId: null,
      selectedEvidenceId: item.symbol.declarationEvidenceId,
      view: 'source',
    });
    input.reportWorkspaceError(null);
    input.setWorkspaceNotice(null);
    void input.loadGraph(
      item.symbol,
      scope,
      input.relationKinds,
      input.direction,
    );
    void input.loadEvidence(item.symbol.declarationEvidenceId, scope);
    input.focusSelectedDeclaration(generation);
  }

  return { openScopedDeclaration, chooseSymbol };
}

function createSecondaryActions(
  input: InvestigationActionsInput,
  pushNavigation: (entry: NavigationEntry) => void,
  openScopedDeclaration: (
    scope: Scope,
    symbolId: string,
    generation: number,
    reportError: (message: string | null) => void,
  ) => Promise<boolean>,
) {
  const { refs } = input;

  async function chooseFile(file: FilePage['items'][number]) {
    const generation = ++refs.selectionGeneration.current;
    input.setWorkspaceNotice(null);
    if (file.status !== 'analyzed') {
      input.reportWorkspaceError(
        file.analysisReason
          ? `${file.status}: ${file.analysisReason}`
          : `This file is ${file.status}; no source excerpt is available.`,
      );
      return;
    }
    const contextId = resolveReadyFileContext(
      file,
      input.projects,
      refs.scopeRef.current?.projectId,
    );
    if (!contextId) {
      input.reportWorkspaceError(
        'No ready project context contains this analyzed file.',
      );
      return;
    }
    if (contextId !== refs.scopeRef.current?.projectId) {
      const scope = await input.selectProject(contextId);
      if (!scope || generation !== refs.selectionGeneration.current) return;
      const context = input.projects?.items.find(
        (item) => item.id === contextId,
      );
      if (
        scope.projectId !== contextId ||
        scope.snapshotId !== context?.snapshotId
      )
        return;
    }
    input.setSearchMode('project');
    input.setSearchOffset(0);
    input.setSearchQuery(
      file.path.length > 256 ? file.path.slice(-256) : file.path,
    );
    input.reportWorkspaceError(null);
    input.setWorkspaceNotice(
      'Full-file source is not available; matching declarations are shown from verified snapshot evidence.',
    );
  }

  async function followSymbol(symbol: CodeSymbol) {
    ++refs.selectionGeneration.current;
    const scope = refs.scopeRef.current;
    if (!scope || symbol.snapshotId !== scope.snapshotId) {
      input.reportWorkspaceError(
        'The target is not part of the active immutable snapshot.',
      );
      return;
    }
    input.reportWorkspaceError(null);
    input.setWorkspaceNotice(null);
    input.setSelected(symbol);
    input.resetContextFollow();
    input.setActiveView('source');
    pushNavigation({
      ...scope,
      root: symbol,
      relationKinds: input.relationKinds,
      direction: input.direction,
      selectedRelationId: null,
      selectedEvidenceId: symbol.declarationEvidenceId,
      view: 'source',
    });
    void input.loadGraph(symbol, scope, input.relationKinds, input.direction);
    void input.loadEvidence(symbol.declarationEvidenceId, scope);
  }

  async function chooseContextCandidate(
    candidate: FollowContextProjection['candidates'][number],
  ) {
    const generation = ++refs.selectionGeneration.current;
    const scope = projectScope(
      candidate.projectId,
      input.workspace,
      input.projects,
    );
    if (!scope || scope.snapshotId !== candidate.snapshotId) {
      input.setContextSearchMessage(
        'The destination context is no longer ready or its snapshot identity changed.',
      );
      return;
    }
    await openScopedDeclaration(
      scope,
      candidate.symbolId,
      generation,
      input.setContextSearchMessage,
    );
  }

  return { chooseFile, followSymbol, chooseContextCandidate };
}

function createTraceAndHistoryActions(
  input: InvestigationActionsInput,
  pushNavigation: (entry: NavigationEntry) => void,
) {
  const { refs } = input;

  function currentNavigationEntry(): NavigationEntry | null {
    const scope = refs.scopeRef.current;
    if (!scope) return null;
    return {
      scanId: scope.scanId,
      projectId: scope.projectId,
      snapshotId: scope.snapshotId,
      root: input.selected,
      relationKinds: input.relationKinds,
      direction: input.direction,
      selectedRelationId: input.selectedRelationId,
      selectedEvidenceId: input.evidence ? evidenceId(input.evidence) : null,
      view: input.activeView,
    };
  }

  async function chooseEvidence(
    id: string,
    trigger: HTMLButtonElement,
    relationId: string | null = null,
  ) {
    const scope = refs.scopeRef.current;
    if (
      !scope ||
      !isAllowedEvidence(id, input.selected, input.graph, input.pathsResult)
    ) {
      input.reportWorkspaceError(
        'Evidence selection is not present in the current validated projection.',
      );
      return;
    }
    ++refs.selectionGeneration.current;
    if (input.compactViewport) input.openInspector(trigger);
    const entry = currentNavigationEntry();
    if (entry) {
      pushNavigation({
        ...entry,
        selectedRelationId: relationId,
        selectedEvidenceId: id,
      });
    }
    await input.loadEvidence(id, scope, relationId);
  }

  async function changeFilters(
    kinds: RelationKindFilter[],
    newDirection = input.direction,
  ) {
    if (!kinds.length) return;
    ++refs.selectionGeneration.current;
    input.setRelationKinds(kinds);
    input.setDirection(newDirection);
    const scope = refs.scopeRef.current;
    const root = input.selected;
    if (!scope || !root) return;
    input.setActiveView('trace');
    pushNavigation({
      ...scope,
      root,
      relationKinds: kinds,
      direction: newDirection,
      selectedRelationId: null,
      selectedEvidenceId: null,
      view: 'trace',
    });
    void input.loadGraph(root, scope, kinds, newDirection);
  }

  function readDeclarationEvidence() {
    const scope = refs.scopeRef.current;
    if (scope && input.selected?.snapshotId === scope.snapshotId)
      void input.loadEvidence(input.selected.declarationEvidenceId, scope);
  }

  function chooseView(view: InvestigationView) {
    input.setActiveView(view);
    if (
      view === 'source' &&
      input.requestedEvidenceId.current !==
        input.selected?.declarationEvidenceId
    )
      readDeclarationEvidence();
  }

  return { chooseEvidence, changeFilters, readDeclarationEvidence, chooseView };
}

export function useInvestigationActions(input: InvestigationActionsInput) {
  function pushNavigation(entry: NavigationEntry) {
    ++input.refs.navigationRestoreGeneration.current;
    input.pushHistory(entry);
  }

  const selection = createSelectionActions(input, pushNavigation);
  const secondary = createSecondaryActions(
    input,
    pushNavigation,
    selection.openScopedDeclaration,
  );
  const traceAndHistory = createTraceAndHistoryActions(input, pushNavigation);
  const restoreNavigation = createRestoreHandler(input);

  return {
    chooseSymbol: selection.chooseSymbol,
    ...secondary,
    ...traceAndHistory,
    restoreNavigation,
  };
}
