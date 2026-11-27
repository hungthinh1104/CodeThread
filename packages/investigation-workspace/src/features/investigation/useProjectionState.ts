import { useRef, useState, type RefObject } from 'react';
import { ApiFailure } from './api.ts';
import {
  errorMessage,
  evidenceId,
  readEvidence,
  readFollowContexts,
  readGraph,
} from './scoped-api.ts';
import type {
  CodeSymbol,
  EvidenceProjection,
  EvidenceRole,
  FollowContextProjection,
  GraphProjection,
  ProjectContexts,
  Scope,
} from './types.ts';
import type { NavigationEntry } from './useWorkspaceHistory.ts';

type ProjectionInput = {
  scopeRef: RefObject<Scope | null>;
  selectionGenerationRef: RefObject<number>;
  projects: ProjectContexts | null;
  resetInspector: () => void;
};

export function useProjectionState({
  scopeRef,
  selectionGenerationRef,
  projects,
  resetInspector,
}: ProjectionInput) {
  const [selected, setSelected] = useState<CodeSymbol | null>(null);
  const [graph, setGraph] = useState<GraphProjection | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<
    EvidenceProjection['items'][number] | null
  >(null);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
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

  const graphGeneration = useRef(0);
  const evidenceGeneration = useRef(0);
  const contextSearchGeneration = useRef(0);
  const requestedEvidenceId = useRef<string | null>(null);

  function invalidateProjectionReads() {
    ++graphGeneration.current;
    ++evidenceGeneration.current;
    ++contextSearchGeneration.current;
    setGraphLoading(false);
    setEvidenceLoading(false);
    setContextSearchLoading(false);
  }

  function clearContextSearch() {
    ++contextSearchGeneration.current;
    setContextCandidates([]);
    setContextSearchMessage(null);
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
    resetInspector();
    setActiveView('source');
  }

  async function loadGraph(
    root: CodeSymbol | string,
    scope: Scope,
    kinds: ('calls' | 'references')[],
    requestedDirection: 'outgoing' | 'incoming' | 'both',
    options?: { preserveDeclarationEvidence?: boolean },
  ): Promise<GraphProjection | null> {
    const generation = ++graphGeneration.current;
    const rootSymbolId = typeof root === 'string' ? root : root.id;
    const declarationId =
      typeof root === 'string' ? null : root.declarationEvidenceId;
    const keepDeclarationEvidence =
      Boolean(options?.preserveDeclarationEvidence) &&
      declarationId !== null &&
      requestedEvidenceId.current === declarationId;
    setGraphLoading(true);
    setGraphError(null);
    setGraph(null);
    setSelectedRelationId(null);
    if (!keepDeclarationEvidence) {
      ++evidenceGeneration.current;
      requestedEvidenceId.current = null;
      setEvidence(null);
      setEvidenceLoading(false);
      setEvidenceError(null);
    }
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
      const item = await readEvidence(id, scope);
      if (
        generation !== evidenceGeneration.current ||
        scopeRef.current?.projectId !== scope.projectId ||
        scopeRef.current?.snapshotId !== scope.snapshotId
      )
        return;
      setEvidence(item);
    } catch (error) {
      if (generation === evidenceGeneration.current)
        setEvidenceError(errorMessage(error));
    } finally {
      if (generation === evidenceGeneration.current) setEvidenceLoading(false);
    }
  }

  async function findMatchingContexts() {
    const scope = scopeRef.current;
    if (!scope || !selected) return;
    const symbolId = selected.id;
    const selection = selectionGenerationRef.current;
    const generation = ++contextSearchGeneration.current;
    setContextSearchLoading(true);
    setContextSearchMessage(null);
    setContextCandidates([]);
    try {
      const result = await readFollowContexts(symbolId, scope);
      if (
        generation !== contextSearchGeneration.current ||
        selection !== selectionGenerationRef.current ||
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
        selection === selectionGenerationRef.current &&
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

  const displayedEvidenceId = evidence ? evidenceId(evidence) : null;
  const evidenceRole: EvidenceRole | null = !displayedEvidenceId
    ? null
    : selectedRelationId !== null
      ? 'occurrence'
      : selected?.declarationEvidenceId === displayedEvidenceId
        ? 'declaration'
        : 'observation';

  return {
    selected,
    setSelected,
    graph,
    setGraph,
    graphLoading,
    graphError,
    evidence,
    setEvidence,
    evidenceLoading,
    evidenceError,
    evidenceRole,
    relationKinds,
    setRelationKinds,
    direction,
    setDirection,
    selectedRelationId,
    contextCandidates,
    contextSearchLoading,
    contextSearchMessage,
    setContextSearchMessage,
    activeView,
    setActiveView,
    requestedEvidenceId,
    invalidateProjectionReads,
    clearContextSearch,
    clearSelection,
    loadGraph,
    loadEvidence,
    findMatchingContexts,
    retryGraph,
    retryEvidence,
    readDeclarationEvidence,
    chooseView,
  };
}
