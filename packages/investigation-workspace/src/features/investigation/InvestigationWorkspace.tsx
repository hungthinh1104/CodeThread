'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiFailure,
  openScan,
  readRepositories,
  readViewer,
  readWorkspaceMetadata,
  rememberWorkspaceScan,
} from './api.ts';
import { EvidenceInspector } from './EvidenceInspector.tsx';
import { ExplorerRegion, type SearchItem } from './ExplorerRegion.tsx';
import { MainRegion } from './MainRegion.tsx';
import type {
  CatalogPage,
  CodeSymbol,
  EvidenceProjection,
  FilePage,
  FollowContextProjection,
  GraphProjection,
  ProjectContexts,
  RepositoryItem,
  SessionProjection,
  SymbolPage,
  WorkspaceMetadata,
} from './types.ts';
import {
  useWorkspaceHistory,
  type NavigationEntry,
} from './useWorkspaceHistory.ts';

type Scope = { scanId: string; projectId: string; snapshotId: string };
type SearchState = {
  items: SearchItem[];
  offset: number;
  total: number;
  nextOffset: number | null;
};
type ApiResponse<T> = T | { projectId: string; result: T };

function scopedSnapshotId(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  if ('snapshotId' in value && typeof value.snapshotId === 'string')
    return value.snapshotId;
  if (
    'meta' in value &&
    typeof value.meta === 'object' &&
    value.meta !== null
  ) {
    const meta = value.meta;
    return 'snapshotId' in meta && typeof meta.snapshotId === 'string'
      ? meta.snapshotId
      : null;
  }
  if (
    'graph' in value &&
    typeof value.graph === 'object' &&
    value.graph !== null
  )
    return scopedSnapshotId(value.graph);
  return null;
}

function unwrapScoped<T>(value: ApiResponse<T>, scope: Scope): T {
  let result: T;
  if (typeof value === 'object' && value !== null && 'result' in value) {
    if (value.projectId !== scope.projectId)
      throw new ApiFailure(502, {
        error: {
          code: 'WORKSPACE_CONTEXT_MISMATCH',
          message: 'The local snapshot response belongs to another project.',
        },
      });
    result = value.result as T;
  } else if (
    typeof value === 'object' &&
    value !== null &&
    'projectId' in value &&
    value.projectId === scope.projectId
  ) {
    result = value as T;
  } else {
    throw new ApiFailure(502, {
      error: {
        code: 'WORKSPACE_SCOPE_MISSING',
        message: 'The local snapshot response omitted project identity.',
      },
    });
  }
  if (scopedSnapshotId(result) !== scope.snapshotId)
    throw new ApiFailure(502, {
      error: {
        code: 'WORKSPACE_SNAPSHOT_MISMATCH',
        message:
          'The local snapshot response did not match the active snapshot.',
      },
    });
  return result;
}

async function readSession(scope: Scope): Promise<SessionProjection> {
  return unwrapScoped(
    await readViewer<ApiResponse<SessionProjection>>(scope.scanId, 'session', {
      projectId: scope.projectId,
      request: {},
    }),
    scope,
  );
}

async function readGraph(
  symbolId: string,
  scope: Scope,
  kinds: NavigationEntry['relationKinds'],
  direction: NavigationEntry['direction'],
): Promise<GraphProjection> {
  return unwrapScoped(
    await readViewer<ApiResponse<GraphProjection>>(scope.scanId, 'neighbors', {
      projectId: scope.projectId,
      request: {
        snapshotId: scope.snapshotId,
        symbolId,
        direction,
        relationKinds: kinds,
        depth: 2,
        nodeLimit: 50,
      },
    }),
    scope,
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiFailure) return `${error.code}: ${error.message}`;
  return 'The local Investigation Workspace request failed.';
}

function evidenceId(item: EvidenceProjection['items'][number]): string {
  return item.status === 'available' ? item.evidence.id : item.evidenceId;
}

function emptySearchState(): SearchState {
  return { items: [], offset: 0, total: 0, nextOffset: null };
}

export function InvestigationWorkspace() {
  const [repositories, setRepositories] = useState<RepositoryItem[]>([]);
  const [selectedRepositoryId, setSelectedRepositoryId] = useState('');
  const [workspace, setWorkspace] = useState<WorkspaceMetadata | null>(null);
  const [projects, setProjects] = useState<ProjectContexts | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [session, setSession] = useState<SessionProjection | null>(null);
  const [searchMode, setSearchMode] = useState<'project' | 'repository'>(
    'project',
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOffset, setSearchOffset] = useState(0);
  const [search, setSearch] = useState<SearchState>(emptySearchState);
  const [searchLoading, setSearchLoading] = useState(false);
  const [files, setFiles] = useState<FilePage | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [selected, setSelected] = useState<CodeSymbol | null>(null);
  const [graph, setGraph] = useState<GraphProjection | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [evidence, setEvidence] = useState<
    EvidenceProjection['items'][number] | null
  >(null);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [relationKinds, setRelationKinds] = useState<
    ('calls' | 'references')[]
  >(['calls']);
  const [direction, setDirection] = useState<'outgoing' | 'incoming' | 'both'>(
    'both',
  );
  const [selectedRelationId, setSelectedRelationId] = useState<string | null>(
    null,
  );
  const [contextCandidates, setContextCandidates] = useState<
    FollowContextProjection['candidates']
  >([]);
  const [contextSearchLoading, setContextSearchLoading] = useState(false);
  const [contextSearchMessage, setContextSearchMessage] = useState<
    string | null
  >(null);
  const [activeView, setActiveView] = useState<'source' | 'trace'>('source');
  const [compactViewport, setCompactViewport] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [workspaceRetryable, setWorkspaceRetryable] = useState(false);
  const [initializationRetryVersion, setInitializationRetryVersion] =
    useState(0);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchRetryVersion, setSearchRetryVersion] = useState(0);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const scopeRef = useRef<Scope | null>(null);
  const workspaceGeneration = useRef(0);
  const contextGeneration = useRef(0);
  const searchGeneration = useRef(0);
  const fileGeneration = useRef(0);
  const graphGeneration = useRef(0);
  const evidenceGeneration = useRef(0);
  const contextSearchGeneration = useRef(0);
  const navigationRestoreGeneration = useRef(0);
  const selectionGeneration = useRef(0);
  const requestedEvidenceId = useRef<string | null>(null);
  const workspaceHeadingRef = useRef<HTMLHeadingElement>(null);
  const inspectorTriggerRef = useRef<HTMLButtonElement>(null);
  const inspectorOpenerRef = useRef<HTMLButtonElement>(null);
  const inspectorCloseRef = useRef<HTMLButtonElement>(null);
  const history = useWorkspaceHistory(restoreNavigation);

  function openInspector(trigger: HTMLButtonElement) {
    inspectorOpenerRef.current = trigger;
    setInspectorOpen(true);
  }

  const closeInspector = useCallback(() => {
    setInspectorOpen(false);
    window.requestAnimationFrame(() => {
      const opener = inspectorOpenerRef.current;
      const target =
        opener && !opener.isConnected && opener.id
          ? document.getElementById(opener.id)
          : opener;
      if (target?.isConnected && !target.closest('[hidden]')) target.focus();
      else if (opener?.id === 'inspect-declaration-evidence')
        workspaceHeadingRef.current?.focus();
      else inspectorTriggerRef.current?.focus();
    });
  }, []);

  function reportWorkspaceError(message: string | null, retryable = false) {
    setWorkspaceError(message);
    setWorkspaceRetryable(message !== null && retryable);
  }

  useEffect(() => {
    const media = window.matchMedia('(max-width: 900px)');
    const update = () => {
      setCompactViewport(media.matches);
      if (!media.matches) setInspectorOpen(false);
    };
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  function currentNavigationEntry(): NavigationEntry | null {
    const scope = scopeRef.current;
    if (!scope) return null;
    return {
      scanId: scope.scanId,
      projectId: scope.projectId,
      snapshotId: scope.snapshotId,
      root: selected,
      relationKinds,
      direction,
      selectedRelationId,
      selectedEvidenceId: evidence ? evidenceId(evidence) : null,
      view: activeView,
    };
  }

  function resetNavigation(entry: NavigationEntry | null) {
    ++navigationRestoreGeneration.current;
    history.reset(entry);
  }

  function pushNavigation(entry: NavigationEntry) {
    ++navigationRestoreGeneration.current;
    history.push(entry);
  }

  function invalidateProjectionReads() {
    ++graphGeneration.current;
    ++evidenceGeneration.current;
    ++contextSearchGeneration.current;
    setGraphLoading(false);
    setEvidenceLoading(false);
    setContextSearchLoading(false);
  }

  function clearSelection() {
    invalidateProjectionReads();
    requestedEvidenceId.current = null;
    setSelected(null);
    setGraph(null);
    setGraphError(null);
    setEvidence(null);
    setEvidenceError(null);
    setSelectedRelationId(null);
    setContextCandidates([]);
    setContextSearchMessage(null);
    setInspectorOpen(false);
    setActiveView('source');
  }

  function clearSearchResults() {
    ++searchGeneration.current;
    setSearch(emptySearchState());
    setSearchError(null);
    setSearchLoading(false);
  }

  function resetProject(projectId: string) {
    const generation = ++contextGeneration.current;
    scopeRef.current = null;
    setSelectedProjectId(projectId);
    setSession(null);
    clearSelection();
    clearSearchResults();
    if (searchMode === 'project') setSearchOffset(0);
    reportWorkspaceError(null);
    return generation;
  }

  function resetWorkspace() {
    const generation = ++workspaceGeneration.current;
    ++selectionGeneration.current;
    ++fileGeneration.current;
    resetProject('');
    setWorkspace(null);
    setProjects(null);
    setSearchQuery('');
    setSearchOffset(0);
    setFiles(null);
    setFilesLoading(false);
    setFilesError(null);
    resetNavigation(null);
    return generation;
  }

  async function loadProjectContexts(
    metadata: WorkspaceMetadata,
    generation: number,
  ) {
    try {
      const result = await readViewer<ProjectContexts>(
        metadata.scanId,
        'projects',
        {},
      );
      if (generation !== workspaceGeneration.current) return;
      if (
        result.repositoryId !== metadata.repositoryId ||
        result.commitId !== metadata.commitId
      )
        throw new ApiFailure(502, {
          error: {
            code: 'WORKSPACE_SCAN_MISMATCH',
            message:
              'The project contexts do not belong to the opened repository revision.',
          },
        });
      rememberWorkspaceScan(metadata.scanId);
      setWorkspace(metadata);
      setProjects(result);
      const ready = result.items.filter(
        (item) => item.status === 'ready' && item.snapshotId !== null,
      );
      const initial =
        ready.find((item) => item.id === result.initialProjectId) ?? ready[0];
      if (!initial) {
        reportWorkspaceError(
          'This scan has no ready project context. Failed and unsupported contexts remain listed with their diagnostics.',
        );
        return;
      }
      await selectProject(initial.id, metadata, result, 'replace');
    } catch (error) {
      if (generation === workspaceGeneration.current)
        reportWorkspaceError(errorMessage(error), true);
    }
  }

  async function selectProject(
    projectId: string,
    metadata = workspace,
    contexts = projects,
    historyMode: 'push' | 'replace' | 'none' = 'push',
  ): Promise<Scope | null> {
    if (!metadata || !contexts) return null;
    const project = contexts.items.find((item) => item.id === projectId);
    if (!project || project.status !== 'ready' || !project.snapshotId) {
      reportWorkspaceError(
        'Only a ready project context with a published snapshot can be selected.',
      );
      return null;
    }
    if (historyMode !== 'none') ++navigationRestoreGeneration.current;
    const generation = resetProject(projectId);
    const scope = {
      scanId: metadata.scanId,
      projectId,
      snapshotId: project.snapshotId,
    };
    try {
      const projection = await readSession(scope);
      if (generation !== contextGeneration.current) return null;
      scopeRef.current = scope;
      setSession(projection);
      const entry: NavigationEntry = {
        ...scope,
        root: null,
        relationKinds,
        direction,
        selectedRelationId: null,
        selectedEvidenceId: null,
        view: 'source',
      };
      if (historyMode === 'replace') resetNavigation(entry);
      else if (historyMode === 'push') pushNavigation(entry);
      return scope;
    } catch (error) {
      if (generation === contextGeneration.current)
        reportWorkspaceError(errorMessage(error), true);
      return null;
    }
  }

  async function loadGraph(
    root: CodeSymbol | string,
    scope: Scope,
    kinds: ('calls' | 'references')[],
    requestedDirection: 'outgoing' | 'incoming' | 'both',
  ): Promise<GraphProjection | null> {
    const generation = ++graphGeneration.current;
    const rootSymbolId = typeof root === 'string' ? root : root.id;
    ++evidenceGeneration.current;
    requestedEvidenceId.current = null;
    setGraphLoading(true);
    setGraphError(null);
    setGraph(null);
    setSelectedRelationId(null);
    setEvidence(null);
    setEvidenceLoading(false);
    setEvidenceError(null);
    try {
      const projection = await readGraph(
        rootSymbolId,
        scope,
        kinds,
        requestedDirection,
      );
      if (
        generation !== graphGeneration.current ||
        scopeRef.current?.projectId !== scope.projectId ||
        scopeRef.current?.snapshotId !== scope.snapshotId
      )
        return null;
      setGraph(projection);
      return projection;
    } catch (error) {
      if (generation === graphGeneration.current)
        setGraphError(errorMessage(error));
      return null;
    } finally {
      if (generation === graphGeneration.current) setGraphLoading(false);
    }
  }

  async function loadEvidence(
    id: string,
    scope: Scope,
    relationId: string | null = null,
  ) {
    const generation = ++evidenceGeneration.current;
    requestedEvidenceId.current = id;
    setEvidenceLoading(true);
    setEvidenceError(null);
    setSelectedRelationId(relationId);
    setEvidence(null);
    try {
      const response = await readViewer<ApiResponse<EvidenceProjection>>(
        scope.scanId,
        'evidence',
        {
          projectId: scope.projectId,
          request: { snapshotId: scope.snapshotId, evidenceIds: [id] },
        },
      );
      const projection = unwrapScoped(response, scope);
      if (
        generation !== evidenceGeneration.current ||
        scopeRef.current?.projectId !== scope.projectId ||
        scopeRef.current?.snapshotId !== scope.snapshotId
      )
        return;
      const item = projection.items.find(
        (candidate) => evidenceId(candidate) === id,
      );
      if (!item) {
        setEvidenceError(
          'The validated evidence response omitted the requested identity.',
        );
        return;
      }
      setEvidence(item);
    } catch (error) {
      if (generation === evidenceGeneration.current)
        setEvidenceError(errorMessage(error));
    } finally {
      if (generation === evidenceGeneration.current) setEvidenceLoading(false);
    }
  }

  async function chooseSymbol(item: SearchItem) {
    const generation = ++selectionGeneration.current;
    let scope = scopeRef.current;
    if (scope?.projectId !== item.projectId) {
      scope = await selectProject(item.projectId, workspace, projects, 'none');
      if (!scope || generation !== selectionGeneration.current) return;
    }
    if (
      !scope ||
      scope.projectId !== item.projectId ||
      scope.snapshotId !== item.snapshotId ||
      item.symbol.snapshotId !== item.snapshotId
    ) {
      reportWorkspaceError(
        'The selected symbol does not match the active snapshot identity.',
      );
      return;
    }
    setSelected(item.symbol);
    setContextCandidates([]);
    setContextSearchMessage(null);
    setContextSearchLoading(false);
    ++contextSearchGeneration.current;
    setActiveView('source');
    const entry: NavigationEntry = {
      ...scope,
      root: item.symbol,
      relationKinds,
      direction,
      selectedRelationId: null,
      selectedEvidenceId: item.symbol.declarationEvidenceId,
      view: 'source',
    };
    pushNavigation(entry);
    void loadGraph(item.symbol, scope, relationKinds, direction);
    void loadEvidence(item.symbol.declarationEvidenceId, scope);
    if (window.matchMedia('(max-width: 760px)').matches) {
      window.requestAnimationFrame(() => {
        if (generation !== selectionGeneration.current) return;
        const heading = workspaceHeadingRef.current;
        heading?.focus({ preventScroll: true });
        heading?.closest('main')?.scrollIntoView({ block: 'start' });
      });
    }
  }

  async function chooseFile(file: FilePage['items'][number]) {
    const generation = ++selectionGeneration.current;
    if (file.status !== 'analyzed') {
      reportWorkspaceError(
        file.analysisReason
          ? `${file.status}: ${file.analysisReason}`
          : `This file is ${file.status}; no source excerpt is available.`,
      );
      return;
    }
    const contextId = file.projectIds.find((id) =>
      projects?.items.some(
        (item) => item.id === id && item.status === 'ready' && item.snapshotId,
      ),
    );
    if (!contextId) {
      reportWorkspaceError(
        'No ready project context contains this analyzed file.',
      );
      return;
    }
    if (contextId !== scopeRef.current?.projectId) {
      const scope = await selectProject(contextId);
      if (!scope || generation !== selectionGeneration.current) return;
      const context = projects?.items.find((item) => item.id === contextId);
      if (
        !scope ||
        scope.projectId !== contextId ||
        scope.snapshotId !== context?.snapshotId
      )
        return;
    }
    setSearchMode('project');
    setSearchOffset(0);
    setSearchQuery(file.path);
    reportWorkspaceError(
      'Full-file source is not available; matching declarations are shown from verified snapshot evidence.',
    );
  }

  async function followSymbol(symbol: CodeSymbol) {
    ++selectionGeneration.current;
    const scope = scopeRef.current;
    if (!scope || symbol.snapshotId !== scope.snapshotId) {
      reportWorkspaceError(
        'The target is not part of the active immutable snapshot.',
      );
      return;
    }
    setSelected(symbol);
    setContextCandidates([]);
    setContextSearchMessage(null);
    setContextSearchLoading(false);
    ++contextSearchGeneration.current;
    setActiveView('source');
    pushNavigation({
      ...scope,
      root: symbol,
      relationKinds,
      direction,
      selectedRelationId: null,
      selectedEvidenceId: symbol.declarationEvidenceId,
      view: 'source',
    });
    void loadGraph(symbol, scope, relationKinds, direction);
    void loadEvidence(symbol.declarationEvidenceId, scope);
  }

  async function chooseEvidence(
    id: string,
    trigger: HTMLButtonElement,
    relationId: string | null = null,
  ) {
    const scope = scopeRef.current;
    if (
      !scope ||
      (!graph?.graph.evidenceRefs.some((item) => item.id === id) &&
        selected?.declarationEvidenceId !== id)
    ) {
      reportWorkspaceError(
        'Evidence selection is not present in the current validated projection.',
      );
      return;
    }
    ++selectionGeneration.current;
    if (compactViewport) openInspector(trigger);
    const entry = currentNavigationEntry();
    if (entry) {
      pushNavigation({
        ...entry,
        selectedRelationId: relationId,
        selectedEvidenceId: id,
      });
    }
    await loadEvidence(id, scope, relationId);
  }

  async function findMatchingContexts() {
    const scope = scopeRef.current;
    if (!scope || !selected) return;
    const symbolId = selected.id;
    const selection = selectionGeneration.current;
    const generation = ++contextSearchGeneration.current;
    setContextSearchLoading(true);
    setContextSearchMessage(null);
    setContextCandidates([]);
    try {
      const response = await readViewer<ApiResponse<FollowContextProjection>>(
        scope.scanId,
        'follow-context',
        {
          projectId: scope.projectId,
          request: { snapshotId: scope.snapshotId, symbolId },
        },
      );
      const result = unwrapScoped(response, scope);
      if (
        generation !== contextSearchGeneration.current ||
        selection !== selectionGeneration.current ||
        selected?.id !== symbolId ||
        scopeRef.current?.projectId !== scope.projectId ||
        scopeRef.current?.snapshotId !== scope.snapshotId
      )
        return;
      for (const candidate of result.candidates) {
        const context = projects?.items.find(
          (item) => item.id === candidate.projectId,
        );
        if (
          !context ||
          context.status !== 'ready' ||
          context.snapshotId !== candidate.snapshotId
        )
          throw new ApiFailure(502, {
            error: {
              code: 'WORKSPACE_CONTEXT_MISMATCH',
              message:
                'A declaration context does not match the loaded project snapshots.',
            },
          });
      }
      setContextCandidates(result.candidates);
      if (
        result.candidates.length === 1 &&
        result.candidates[0]?.projectId === scope.projectId
      )
        setContextSearchMessage(
          'This declaration is present only in the active project context.',
        );
      else if (result.candidates.length > 1)
        setContextSearchMessage(
          'The same declaration anchor appears in multiple snapshots. Choose the destination context.',
        );
    } catch (error) {
      if (
        generation === contextSearchGeneration.current &&
        selection === selectionGeneration.current &&
        selected?.id === symbolId &&
        scopeRef.current?.projectId === scope.projectId &&
        scopeRef.current?.snapshotId === scope.snapshotId
      )
        setContextSearchMessage(errorMessage(error));
    } finally {
      if (generation === contextSearchGeneration.current)
        setContextSearchLoading(false);
    }
  }

  async function chooseContextCandidate(
    candidate: FollowContextProjection['candidates'][number],
  ) {
    const generation = ++selectionGeneration.current;
    const context = projects?.items.find(
      (item) => item.id === candidate.projectId,
    );
    if (
      !context ||
      context.status !== 'ready' ||
      context.snapshotId !== candidate.snapshotId
    ) {
      setContextSearchMessage(
        'The destination context is no longer ready or its snapshot identity changed.',
      );
      return;
    }
    if (candidate.projectId !== scopeRef.current?.projectId) {
      const scope = await selectProject(
        candidate.projectId,
        workspace,
        projects,
        'none',
      );
      if (!scope) return;
    }
    if (generation !== selectionGeneration.current) return;
    const scope = scopeRef.current;
    if (
      !scope ||
      scope.projectId !== candidate.projectId ||
      scope.snapshotId !== candidate.snapshotId
    ) {
      setContextSearchMessage(
        'The selected context does not match the verified declaration snapshot.',
      );
      return;
    }
    const projection = await loadGraph(
      candidate.symbolId,
      scope,
      relationKinds,
      direction,
    );
    if (generation !== selectionGeneration.current) return;
    const root = projection?.graph.symbols.find(
      (symbol) => symbol.id === candidate.symbolId,
    );
    if (!root) {
      setContextSearchMessage(
        'The destination query did not return the verified declaration.',
      );
      return;
    }
    setSelected(root);
    setActiveView('source');
    setContextCandidates([]);
    setContextSearchMessage(null);
    pushNavigation({
      ...scope,
      root,
      relationKinds,
      direction,
      selectedRelationId: null,
      selectedEvidenceId: root.declarationEvidenceId,
      view: 'source',
    });
    void loadEvidence(root.declarationEvidenceId, scope);
  }

  async function changeFilters(
    kinds: ('calls' | 'references')[],
    newDirection = direction,
  ) {
    if (!kinds.length) return;
    ++selectionGeneration.current;
    setRelationKinds(kinds);
    setDirection(newDirection);
    const scope = scopeRef.current;
    const root = selected;
    if (!scope || !root) return;
    setActiveView('trace');
    pushNavigation({
      ...scope,
      root,
      relationKinds: kinds,
      direction: newDirection,
      selectedRelationId: null,
      selectedEvidenceId: null,
      view: 'trace',
    });
    void loadGraph(root, scope, kinds, newDirection);
  }

  async function restoreNavigation(entry: NavigationEntry, accept: () => void) {
    const selection = ++selectionGeneration.current;
    const generation = ++navigationRestoreGeneration.current;
    const isCurrent = () =>
      generation === navigationRestoreGeneration.current &&
      selection === selectionGeneration.current;
    const project = projects?.items.find((item) => item.id === entry.projectId);
    if (
      workspace?.scanId !== entry.scanId ||
      project?.status !== 'ready' ||
      project.snapshotId !== entry.snapshotId ||
      (entry.root && entry.root.snapshotId !== entry.snapshotId)
    ) {
      reportWorkspaceError(
        'History snapshot identity no longer matches this project context.',
      );
      return;
    }
    const scope = {
      scanId: entry.scanId,
      projectId: entry.projectId,
      snapshotId: entry.snapshotId,
    };
    const active = scopeRef.current;
    const changesProject =
      !active ||
      active.scanId !== scope.scanId ||
      active.projectId !== scope.projectId ||
      active.snapshotId !== scope.snapshotId;
    invalidateProjectionReads();
    reportWorkspaceError(null);
    try {
      // Keep the displayed context until the destination projections are verified.
      const destination = changesProject ? await readSession(scope) : session;
      if (!destination || !isCurrent()) return;
      const projection = entry.root
        ? await readGraph(
            entry.root.id,
            scope,
            entry.relationKinds,
            entry.direction,
          )
        : null;
      if (!isCurrent()) return;
      const root =
        projection?.graph.symbols.find(
          (symbol) => symbol.id === entry.root?.id,
        ) ?? null;
      if (entry.root && !root) {
        reportWorkspaceError(
          'The restored snapshot did not return the saved declaration.',
        );
        return;
      }
      if (changesProject) {
        resetProject(scope.projectId);
        scopeRef.current = scope;
        setSession(destination);
      } else {
        clearSelection();
      }
      setRelationKinds(entry.relationKinds);
      setDirection(entry.direction);
      setSelected(root);
      setActiveView(entry.view);
      setGraph(projection);
      accept();

      const relationId =
        projection?.graph.relations.find(
          (relation) => relation.id === entry.selectedRelationId,
        )?.id ?? null;
      const id = entry.selectedEvidenceId;
      if (
        id &&
        (root?.declarationEvidenceId === id ||
          projection?.graph.evidenceRefs.some((item) => item.id === id))
      ) {
        void loadEvidence(id, scope, relationId);
      } else if (id) {
        reportWorkspaceError(
          'The saved evidence is no longer in the restored projection.',
        );
      }
    } catch (error) {
      if (isCurrent()) reportWorkspaceError(errorMessage(error));
    }
  }

  useEffect(() => {
    let mounted = true;
    const generation = workspaceGeneration.current;
    const isCurrent = () =>
      mounted && generation === workspaceGeneration.current;
    reportWorkspaceError(null);
    void (async () => {
      try {
        const repositoryResult = await readRepositories();
        if (!isCurrent()) return;
        setRepositories(repositoryResult.items);
        try {
          const recovered = await readWorkspaceMetadata();
          if (!recovered || !isCurrent()) return;
          setSelectedRepositoryId(recovered.workspace.repositoryId);
          await loadProjectContexts(recovered.workspace, resetWorkspace());
        } catch (error) {
          if (
            isCurrent() &&
            !(
              error instanceof ApiFailure &&
              error.code === 'WORKSPACE_SESSION_EXPIRED'
            )
          )
            reportWorkspaceError(errorMessage(error), true);
        }
      } catch (error) {
        if (isCurrent()) reportWorkspaceError(errorMessage(error), true);
      }
    })();
    return () => {
      mounted = false;
      ++workspaceGeneration.current;
      ++contextGeneration.current;
      ++searchGeneration.current;
      ++fileGeneration.current;
      ++graphGeneration.current;
      ++evidenceGeneration.current;
      ++contextSearchGeneration.current;
      ++navigationRestoreGeneration.current;
      ++selectionGeneration.current;
    };
  }, [initializationRetryVersion]);

  useEffect(() => {
    if (!workspace) return;
    const generation = ++fileGeneration.current;
    const workspaceId = workspace.scanId;
    setFilesLoading(true);
    setFilesError(null);
    void readViewer<FilePage>(workspaceId, 'files', { offset: 0 })
      .then((page) => {
        if (
          generation === fileGeneration.current &&
          workspaceId === workspace.scanId
        )
          setFiles(page);
      })
      .catch((error: unknown) => {
        if (generation === fileGeneration.current)
          setFilesError(errorMessage(error));
      })
      .finally(() => {
        if (generation === fileGeneration.current) setFilesLoading(false);
      });
  }, [workspace?.scanId]);

  useEffect(() => {
    if (!workspace || !projects) return;
    const scope = scopeRef.current;
    if (searchMode === 'project' && (!scope || !session)) return;
    const generation = ++searchGeneration.current;
    const contextGenerationAtStart = contextGeneration.current;
    const timer = setTimeout(() => {
      if (generation !== searchGeneration.current) return;
      setSearchLoading(true);
      setSearchError(null);
      const read =
        searchMode === 'repository'
          ? readViewer<CatalogPage>(workspace.scanId, 'catalog', {
              query: searchQuery,
              offset: searchOffset,
            })
          : readViewer<ApiResponse<SymbolPage>>(workspace.scanId, 'symbols', {
              projectId: scope!.projectId,
              request: { query: searchQuery, offset: searchOffset },
            });
      void read
        .then((response) => {
          if (
            generation !== searchGeneration.current ||
            contextGenerationAtStart !== contextGeneration.current
          )
            return;
          if (searchMode === 'repository') {
            const page = response as CatalogPage;
            const items = page.items.map((item) => {
              const context = projects.items.find(
                (candidate) => candidate.id === item.projectId,
              );
              if (
                !context ||
                context.status !== 'ready' ||
                context.snapshotId !== item.snapshotId ||
                item.symbol.snapshotId !== item.snapshotId
              )
                throw new ApiFailure(502, {
                  error: {
                    code: 'WORKSPACE_CONTEXT_MISMATCH',
                    message:
                      'A catalog result does not match a loaded project snapshot.',
                  },
                });
              return {
                projectId: context.id,
                projectLabel: context.label,
                snapshotId: item.snapshotId,
                symbol: item.symbol,
              };
            });
            setSearch({
              items,
              offset: page.offset,
              total: page.total,
              nextOffset: page.nextOffset,
            });
          } else {
            const page = unwrapScoped(
              response as ApiResponse<SymbolPage>,
              scope!,
            );
            const context = projects.items.find(
              (item) => item.id === scope!.projectId,
            );
            setSearch({
              items: page.items.map((symbol) => ({
                projectId: scope!.projectId,
                projectLabel: context?.label ?? scope!.projectId,
                snapshotId: page.snapshotId,
                symbol,
              })),
              offset: page.offset,
              total: page.total,
              nextOffset: page.nextOffset,
            });
          }
        })
        .catch((error: unknown) => {
          if (
            generation === searchGeneration.current &&
            contextGenerationAtStart === contextGeneration.current
          )
            setSearchError(errorMessage(error));
        })
        .finally(() => {
          if (generation === searchGeneration.current) setSearchLoading(false);
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [
    workspace?.scanId,
    projects,
    session?.snapshotId,
    selectedProjectId,
    searchMode,
    searchQuery,
    searchOffset,
    searchRetryVersion,
  ]);

  async function chooseRepository(id: string) {
    const generation = resetWorkspace();
    rememberWorkspaceScan(null);
    setSelectedRepositoryId(id);
    const repository = repositories.find((item) => item.id === id);
    if (!repository) return;
    if (!repository.activeScanId) {
      reportWorkspaceError(
        'This repository has no active scan. Start or select a scan through the existing backend workflow.',
      );
      return;
    }
    try {
      const opened = await openScan(repository.activeScanId);
      if (generation !== workspaceGeneration.current) return;
      if (
        opened.workspace.repositoryId !== id ||
        opened.workspace.scanId !== repository.activeScanId
      )
        throw new ApiFailure(502, {
          error: {
            code: 'WORKSPACE_SCAN_MISMATCH',
            message:
              'The opened scan does not match the selected repository and scan.',
          },
        });
      await loadProjectContexts(opened.workspace, generation);
    } catch (error) {
      if (generation === workspaceGeneration.current)
        reportWorkspaceError(errorMessage(error), true);
    }
  }

  async function chooseSearchPage(offset: number) {
    setSearchOffset(offset);
  }

  async function chooseFilesPage(offset: number) {
    if (!workspace) return;
    const generation = ++fileGeneration.current;
    setFilesLoading(true);
    setFilesError(null);
    try {
      const page = await readViewer<FilePage>(workspace.scanId, 'files', {
        offset,
      });
      if (generation === fileGeneration.current) {
        setFiles(page);
        setFilesError(null);
      }
    } catch (error) {
      if (generation === fileGeneration.current)
        setFilesError(errorMessage(error));
    } finally {
      if (generation === fileGeneration.current) setFilesLoading(false);
    }
  }

  async function retryWorkspace() {
    if (workspace && projects && selectedProjectId) {
      await selectProject(selectedProjectId);
      return;
    }
    if (selectedRepositoryId) {
      await chooseRepository(selectedRepositoryId);
      return;
    }
    setInitializationRetryVersion((version) => version + 1);
  }

  function retryFiles() {
    void chooseFilesPage(files?.offset ?? 0);
  }

  function retrySearch() {
    setSearchRetryVersion((version) => version + 1);
  }

  function retryGraph() {
    const scope = scopeRef.current;
    if (scope && selected)
      void loadGraph(selected, scope, relationKinds, direction);
  }

  function retryEvidence() {
    const scope = scopeRef.current;
    const id = requestedEvidenceId.current;
    if (scope && id) void loadEvidence(id, scope, selectedRelationId);
  }

  function readDeclarationEvidence() {
    const scope = scopeRef.current;
    if (scope && selected?.snapshotId === scope.snapshotId)
      void loadEvidence(selected.declarationEvidenceId, scope);
  }

  function chooseView(view: NavigationEntry['view']) {
    setActiveView(view);
    if (
      view === 'source' &&
      requestedEvidenceId.current !== selected?.declarationEvidenceId
    )
      readDeclarationEvidence();
  }

  const inspectorModal = compactViewport && inspectorOpen;
  return (
    <div className="page-shell">
      <header className="page-header" inert={inspectorModal}>
        <div>
          <p className="eyebrow">CODETHREAD / LOCAL ANALYSIS</p>
          <h1>Investigation Workspace</h1>
          <p>Trace source-backed relationships in a pinned snapshot.</p>
        </div>
        <nav className="history-controls" aria-label="Investigation history">
          <button
            type="button"
            onClick={() => history.move(-1)}
            disabled={!history.canBack}
          >
            Back
          </button>
          <button
            type="button"
            onClick={() => history.move(1)}
            disabled={!history.canForward}
          >
            Forward
          </button>
        </nav>
        <button
          id="inspector-toggle"
          ref={inspectorTriggerRef}
          type="button"
          hidden={!compactViewport}
          aria-expanded={inspectorModal}
          aria-controls="evidence-inspector"
          aria-haspopup="dialog"
          onClick={(event) => openInspector(event.currentTarget)}
        >
          Evidence
        </button>
      </header>
      <p className="scope-note" inert={inspectorModal}>
        Local snapshot only · no source execution · unsupported relationships
        and incomplete coverage stay visible.
      </p>
      <div className="workspace-grid">
        <ExplorerRegion
          inert={inspectorModal}
          repositories={repositories}
          selectedRepositoryId={selectedRepositoryId}
          onRepositoryChange={(id) => void chooseRepository(id)}
          workspace={workspace}
          projects={projects}
          selectedProjectId={selectedProjectId}
          onProjectChange={(id) => {
            ++selectionGeneration.current;
            void selectProject(id);
          }}
          searchQuery={searchQuery}
          onSearchQueryChange={(value) => {
            ++selectionGeneration.current;
            setSearchQuery(value);
            setSearchOffset(0);
            clearSearchResults();
          }}
          searchMode={searchMode}
          searchEnabled={Boolean(workspace && session)}
          onSearchModeChange={(value) => {
            ++selectionGeneration.current;
            setSearchMode(value);
            setSearchOffset(0);
            clearSearchResults();
          }}
          searchItems={search.items}
          searchOffset={search.offset}
          searchTotal={search.total}
          searchNextOffset={search.nextOffset}
          searchLoading={searchLoading}
          searchError={searchError}
          onRetrySearch={retrySearch}
          onSearchPage={(offset) => void chooseSearchPage(offset)}
          onChooseSymbol={(item) => void chooseSymbol(item)}
          files={files}
          filesLoading={filesLoading}
          filesError={filesError}
          onRetryFiles={retryFiles}
          onFilesPage={(offset) => void chooseFilesPage(offset)}
          onChooseFile={(file) => void chooseFile(file)}
          error={workspaceError}
          errorRetryable={workspaceRetryable}
          onRetryWorkspace={() => void retryWorkspace()}
        />
        <MainRegion
          inert={inspectorModal}
          headingRef={workspaceHeadingRef}
          selected={selected}
          evidence={evidence}
          evidenceLoading={evidenceLoading}
          graph={graph}
          graphLoading={graphLoading}
          graphError={graphError}
          evidenceError={evidenceError}
          onRetryGraph={retryGraph}
          onRetryEvidence={readDeclarationEvidence}
          session={session}
          activeView={activeView}
          onViewChange={chooseView}
          relationKinds={relationKinds}
          onRelationKindsChange={(value) => void changeFilters(value)}
          direction={direction}
          onDirectionChange={(value) =>
            void changeFilters(relationKinds, value)
          }
          selectedRelationId={selectedRelationId}
          onSelectEvidence={(id, trigger, relationId) =>
            void chooseEvidence(id, trigger, relationId ?? null)
          }
          onFollowSymbol={(symbol) => void followSymbol(symbol)}
          contextCandidates={contextCandidates}
          contextSearchLoading={contextSearchLoading}
          contextSearchMessage={contextSearchMessage}
          onFindContexts={() => void findMatchingContexts()}
          onChooseContext={(candidate) =>
            void chooseContextCandidate(candidate)
          }
        />
        <EvidenceInspector
          item={evidence}
          loading={evidenceLoading}
          error={evidenceError}
          onRetry={retryEvidence}
          compact={compactViewport}
          open={inspectorOpen}
          onClose={closeInspector}
          closeButtonRef={inspectorCloseRef}
        />
      </div>
      <footer className="page-footer" inert={inspectorModal}>
        <span>Static source evidence · validated API projections</span>
        {workspace ? (
          <span>
            Viewer expires {new Date(workspace.expiresAt).toLocaleTimeString()}
          </span>
        ) : null}
      </footer>
    </div>
  );
}
