'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiFailure,
  openScan,
  readRepositories,
  readViewer,
  readWorkspaceMetadata,
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

type Scope = { scanId: string; projectId: string; snapshotId: string };
type NavigationEntry = {
  scanId: string;
  projectId: string;
  snapshotId: string;
  root: CodeSymbol | null;
  relationKinds: ('calls' | 'references')[];
  direction: 'outgoing' | 'incoming' | 'both';
  selectedRelationId: string | null;
  selectedEvidenceId: string | null;
  view: 'source' | 'trace';
};
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
  const [historyVersion, setHistoryVersion] = useState(0);
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
  const navigationRecords = useRef(new Map<string, NavigationEntry>());
  const navigationKeys = useRef<string[]>([]);
  const navigationIndex = useRef(0);
  const inspectorTriggerRef = useRef<HTMLButtonElement>(null);
  const inspectorCloseRef = useRef<HTMLButtonElement>(null);

  const closeInspector = useCallback(() => {
    setInspectorOpen(false);
    window.requestAnimationFrame(() => inspectorTriggerRef.current?.focus());
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
    if (typeof window === 'undefined') return;
    navigationRecords.current.clear();
    navigationKeys.current = [];
    navigationIndex.current = 0;
    const key = crypto.randomUUID();
    if (entry) navigationRecords.current.set(key, entry);
    navigationKeys.current.push(key);
    window.history.replaceState(
      { ctWorkspaceKey: key },
      '',
      window.location.href,
    );
    setHistoryVersion((version) => version + 1);
  }

  function pushNavigation(entry: NavigationEntry) {
    ++navigationRestoreGeneration.current;
    const key = crypto.randomUUID();
    navigationKeys.current = navigationKeys.current.slice(
      0,
      navigationIndex.current + 1,
    );
    navigationKeys.current.push(key);
    navigationIndex.current = navigationKeys.current.length - 1;
    navigationRecords.current.set(key, entry);
    window.history.pushState({ ctWorkspaceKey: key }, '', window.location.href);
    setHistoryVersion((version) => version + 1);
  }

  async function loadProjectContexts(metadata: WorkspaceMetadata) {
    const generation = ++workspaceGeneration.current;
    ++contextGeneration.current;
    ++graphGeneration.current;
    ++evidenceGeneration.current;
    ++searchGeneration.current;
    ++fileGeneration.current;
    scopeRef.current = null;
    setWorkspace(null);
    setProjects(null);
    setSelectedProjectId('');
    setSession(null);
    setSelected(null);
    setSearch(emptySearchState());
    setSearchError(null);
    setSearchLoading(false);
    setGraph(null);
    setEvidence(null);
    setContextCandidates([]);
    setContextSearchMessage(null);
    setFiles(null);
    setFilesError(null);
    requestedEvidenceId.current = null;
    reportWorkspaceError(null);
    setGraphError(null);
    setEvidenceError(null);
    resetNavigation(null);
    try {
      const result = await readViewer<ProjectContexts>('projects', {});
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
  ) {
    if (!metadata || !contexts) return;
    const project = contexts.items.find((item) => item.id === projectId);
    if (!project || project.status !== 'ready' || !project.snapshotId) {
      reportWorkspaceError(
        'Only a ready project context with a published snapshot can be selected.',
      );
      return;
    }
    const generation = ++contextGeneration.current;
    if (historyMode !== 'none') ++navigationRestoreGeneration.current;
    ++graphGeneration.current;
    ++evidenceGeneration.current;
    const scope = {
      scanId: metadata.scanId,
      projectId,
      snapshotId: project.snapshotId,
    };
    scopeRef.current = scope;
    requestedEvidenceId.current = null;
    setSelectedProjectId(projectId);
    setSession(null);
    setSelected(null);
    setSearch(emptySearchState());
    setSearchError(null);
    setSearchLoading(false);
    setGraph(null);
    setEvidence(null);
    setSelectedRelationId(null);
    setContextCandidates([]);
    setContextSearchMessage(null);
    setGraphError(null);
    setEvidenceError(null);
    reportWorkspaceError(null);
    try {
      const response = await readViewer<ApiResponse<SessionProjection>>(
        'session',
        {
          projectId,
          request: {},
        },
      );
      if (generation !== contextGeneration.current) return;
      const projection = unwrapScoped(response, scope);
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
    } catch (error) {
      if (generation === contextGeneration.current)
        reportWorkspaceError(errorMessage(error), true);
    }
  }

  async function loadGraph(
    root: CodeSymbol | string,
    scope: Scope,
    kinds: ('calls' | 'references')[],
    requestedDirection: 'outgoing' | 'incoming' | 'both',
    preserveRelationId: string | null = null,
  ): Promise<GraphProjection | null> {
    const generation = ++graphGeneration.current;
    const rootSymbolId = typeof root === 'string' ? root : root.id;
    ++evidenceGeneration.current;
    setGraphLoading(true);
    setGraphError(null);
    setGraph(null);
    setSelectedRelationId(null);
    setEvidence(null);
    setEvidenceLoading(false);
    setEvidenceError(null);
    try {
      const response = await readViewer<ApiResponse<GraphProjection>>(
        'neighbors',
        {
          projectId: scope.projectId,
          request: {
            snapshotId: scope.snapshotId,
            symbolId: rootSymbolId,
            direction: requestedDirection,
            relationKinds: kinds,
            depth: 2,
            nodeLimit: 50,
          },
        },
      );
      const projection = unwrapScoped(response, scope);
      if (
        generation !== graphGeneration.current ||
        scopeRef.current?.projectId !== scope.projectId ||
        scopeRef.current?.snapshotId !== scope.snapshotId
      )
        return null;
      setGraph(projection);
      if (
        preserveRelationId &&
        projection.graph.relations.some(
          (item) => item.id === preserveRelationId,
        )
      )
        setSelectedRelationId(preserveRelationId);
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
      await selectProject(item.projectId, workspace, projects, 'none');
      if (generation !== selectionGeneration.current) return;
      scope = scopeRef.current;
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
      await selectProject(contextId);
      if (generation !== selectionGeneration.current) return;
      const scope = scopeRef.current;
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

  async function chooseEvidence(id: string, relationId: string | null = null) {
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
    if (candidate.projectId !== selectedProjectId)
      await selectProject(candidate.projectId, workspace, projects, 'none');
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

  async function restoreNavigation(entry: NavigationEntry) {
    const selection = ++selectionGeneration.current;
    const generation = ++navigationRestoreGeneration.current;
    const metadata = workspace;
    if (!metadata || metadata.scanId !== entry.scanId) {
      reportWorkspaceError(
        'This history entry belongs to a scan that is no longer open.',
      );
      return;
    }
    if (scopeRef.current?.projectId !== entry.projectId) {
      await selectProject(entry.projectId, metadata, projects, 'none');
    }
    if (
      generation !== navigationRestoreGeneration.current ||
      selection !== selectionGeneration.current
    )
      return;
    const currentScope = scopeRef.current;
    if (
      !currentScope ||
      currentScope.projectId !== entry.projectId ||
      currentScope.snapshotId !== entry.snapshotId
    ) {
      reportWorkspaceError(
        'History snapshot identity no longer matches this project context.',
      );
      return;
    }
    setRelationKinds(entry.relationKinds);
    setDirection(entry.direction);
    setSelected(entry.root);
    setActiveView(entry.view);
    setSelectedRelationId(null);
    setGraph(null);
    setEvidence(null);
    if (!entry.root) return;
    const projection = await loadGraph(
      entry.root,
      currentScope,
      entry.relationKinds,
      entry.direction,
      entry.selectedRelationId,
    );
    if (
      !projection ||
      generation !== navigationRestoreGeneration.current ||
      selection !== selectionGeneration.current
    )
      return;
    const availableIds = new Set(
      projection.graph.evidenceRefs.map((item) => item.id),
    );
    if (
      entry.selectedEvidenceId &&
      (availableIds.has(entry.selectedEvidenceId) ||
        entry.root.declarationEvidenceId === entry.selectedEvidenceId)
    ) {
      await loadEvidence(
        entry.selectedEvidenceId,
        currentScope,
        entry.selectedRelationId,
      );
      if (
        generation !== navigationRestoreGeneration.current ||
        selection !== selectionGeneration.current
      )
        return;
    }
  }

  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      const key = (event.state as { ctWorkspaceKey?: string } | null)
        ?.ctWorkspaceKey;
      const index = key ? navigationKeys.current.indexOf(key) : -1;
      const entry = key ? navigationRecords.current.get(key) : undefined;
      if (index < 0 || !entry) return;
      navigationIndex.current = index;
      setHistoryVersion((version) => version + 1);
      void restoreNavigation(entry);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  });

  useEffect(() => {
    let mounted = true;
    reportWorkspaceError(null);
    void (async () => {
      try {
        const repositoryResult = await readRepositories();
        if (!mounted) return;
        setRepositories(repositoryResult.items);
        try {
          const recovered = await readWorkspaceMetadata();
          if (!mounted) return;
          setSelectedRepositoryId(recovered.workspace.repositoryId);
          await loadProjectContexts(recovered.workspace);
        } catch (error) {
          if (
            mounted &&
            !(
              error instanceof ApiFailure &&
              error.code === 'WORKSPACE_SESSION_EXPIRED'
            )
          )
            reportWorkspaceError(errorMessage(error), true);
        }
      } catch (error) {
        if (mounted) reportWorkspaceError(errorMessage(error), true);
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
    void readViewer<FilePage>('files', { offset: 0 })
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
      setSearchLoading(true);
      setSearchError(null);
      const read =
        searchMode === 'repository'
          ? readViewer<CatalogPage>('catalog', {
              query: searchQuery,
              offset: searchOffset,
            })
          : readViewer<ApiResponse<SymbolPage>>('symbols', {
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
    ++navigationRestoreGeneration.current;
    ++selectionGeneration.current;
    const generation = ++workspaceGeneration.current;
    ++contextGeneration.current;
    ++graphGeneration.current;
    ++evidenceGeneration.current;
    ++searchGeneration.current;
    ++fileGeneration.current;
    ++contextSearchGeneration.current;
    scopeRef.current = null;
    setSelectedRepositoryId(id);
    reportWorkspaceError(null);
    setWorkspace(null);
    setProjects(null);
    setSelectedProjectId('');
    setFiles(null);
    setFilesLoading(false);
    setFilesError(null);
    setSession(null);
    setSelected(null);
    setSearch(emptySearchState());
    setSearchQuery('');
    setSearchOffset(0);
    setSearchError(null);
    setSearchLoading(false);
    setGraph(null);
    setGraphLoading(false);
    setGraphError(null);
    setEvidence(null);
    setEvidenceLoading(false);
    setEvidenceError(null);
    setSelectedRelationId(null);
    setContextCandidates([]);
    setContextSearchLoading(false);
    setContextSearchMessage(null);
    setInspectorOpen(false);
    setActiveView('source');
    requestedEvidenceId.current = null;
    resetNavigation(null);
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
      if (opened.workspace.repositoryId !== id)
        throw new ApiFailure(502, {
          error: {
            code: 'WORKSPACE_SCAN_MISMATCH',
            message:
              'The opened scan does not belong to the selected repository.',
          },
        });
      await loadProjectContexts(opened.workspace);
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
      const page = await readViewer<FilePage>('files', { offset });
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

  const hasBack = navigationIndex.current > 0;
  const hasForward =
    navigationIndex.current < navigationKeys.current.length - 1;

  return (
    <div className="page-shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">CODETHREAD / LOCAL ANALYSIS</p>
          <h1>Investigation Workspace</h1>
          <p>Trace source-backed relationships in a pinned snapshot.</p>
        </div>
        <nav
          className="history-controls"
          aria-label="Investigation history"
          data-history-version={historyVersion}
        >
          <button
            type="button"
            onClick={() => window.history.back()}
            disabled={!hasBack}
          >
            Back
          </button>
          <button
            type="button"
            onClick={() => window.history.forward()}
            disabled={!hasForward}
          >
            Forward
          </button>
        </nav>
        <button
          id="inspector-toggle"
          ref={inspectorTriggerRef}
          type="button"
          hidden={!compactViewport}
          aria-expanded={compactViewport && inspectorOpen}
          aria-controls="evidence-inspector"
          onClick={() => setInspectorOpen(true)}
        >
          Evidence
        </button>
      </header>
      <p className="scope-note">
        Local snapshot only · no source execution · unsupported relationships
        and incomplete coverage stay visible.
      </p>
      <div className="workspace-grid">
        <ExplorerRegion
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
            setSearch(emptySearchState());
            setSearchError(null);
            setSearchLoading(false);
          }}
          searchMode={searchMode}
          searchEnabled={Boolean(workspace && session)}
          onSearchModeChange={(value) => {
            ++selectionGeneration.current;
            setSearchMode(value);
            setSearchOffset(0);
            setSearch(emptySearchState());
            setSearchError(null);
            setSearchLoading(false);
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
          selected={selected}
          evidence={evidence}
          evidenceLoading={evidenceLoading}
          graph={graph}
          graphLoading={graphLoading}
          graphError={graphError}
          evidenceError={evidenceError}
          onRetryGraph={retryGraph}
          onRetryEvidence={retryEvidence}
          session={session}
          activeView={activeView}
          onViewChange={setActiveView}
          relationKinds={relationKinds}
          onRelationKindsChange={(value) => void changeFilters(value)}
          direction={direction}
          onDirectionChange={(value) =>
            void changeFilters(relationKinds, value)
          }
          selectedRelationId={selectedRelationId}
          onSelectEvidence={(id, relationId) =>
            void chooseEvidence(id, relationId ?? null)
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
      <footer className="page-footer">
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
