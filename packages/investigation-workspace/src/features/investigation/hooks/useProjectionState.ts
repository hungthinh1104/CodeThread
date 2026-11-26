import { useEffect, useRef, useState, type RefObject } from 'react';
import { ApiFailure, readViewer } from '../api.ts';
import {
  errorMessage,
  readEvidence,
  readGraph,
  unwrapScoped,
} from '../queries.ts';
import type {
  ApiResponse,
  CodeSymbol,
  EvidenceItem,
  FollowContextProjection,
  GraphProjection,
  InvestigationView,
  ProjectContexts,
  RelationKindFilter,
  Scope,
  TraceDirection,
} from '../types.ts';

async function queryMatchingContexts(
  scope: Scope,
  symbolId: string,
  projects: ProjectContexts | null,
): Promise<FollowContextProjection['candidates']> {
  const response = await readViewer<ApiResponse<FollowContextProjection>>(
    scope.scanId,
    'follow-context',
    {
      projectId: scope.projectId,
      request: { snapshotId: scope.snapshotId, symbolId },
    },
  );
  const result = unwrapScoped(response, scope);
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
  return result.candidates;
}

function useProjectionStore() {
  const [selected, setSelected] = useState<CodeSymbol | null>(null);
  const [graph, setGraph] = useState<GraphProjection | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<EvidenceItem | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [relationKinds, setRelationKinds] = useState<RelationKindFilter[]>([
    'calls',
  ]);
  const [direction, setDirection] = useState<TraceDirection>('both');
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
  const [activeView, setActiveView] = useState<InvestigationView>('source');
  const graphGeneration = useRef(0);
  const evidenceGeneration = useRef(0);
  const contextSearchGeneration = useRef(0);
  const requestedEvidenceId = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      ++graphGeneration.current;
      ++evidenceGeneration.current;
      ++contextSearchGeneration.current;
    };
  }, []);

  return {
    selected,
    setSelected,
    graph,
    setGraph,
    graphLoading,
    setGraphLoading,
    graphError,
    setGraphError,
    evidence,
    setEvidence,
    evidenceLoading,
    setEvidenceLoading,
    evidenceError,
    setEvidenceError,
    relationKinds,
    setRelationKinds,
    direction,
    setDirection,
    selectedRelationId,
    setSelectedRelationId,
    contextCandidates,
    setContextCandidates,
    contextSearchLoading,
    setContextSearchLoading,
    contextSearchMessage,
    setContextSearchMessage,
    activeView,
    setActiveView,
    graphGeneration,
    evidenceGeneration,
    contextSearchGeneration,
    requestedEvidenceId,
  };
}

function createContextSearchLoader(
  s: ReturnType<typeof useProjectionStore>,
  scopeRef: RefObject<Scope | null>,
  selectionGenerationRef: RefObject<number>,
) {
  return async function findMatchingContexts(projects: ProjectContexts | null) {
    const scope = scopeRef.current;
    if (!scope || !s.selected) return;
    const symbolId = s.selected.id;
    const selection = selectionGenerationRef.current;
    const generation = ++s.contextSearchGeneration.current;
    s.setContextSearchLoading(true);
    s.setContextSearchMessage(null);
    s.setContextCandidates([]);
    const isCurrent = () =>
      generation === s.contextSearchGeneration.current &&
      selection === selectionGenerationRef.current &&
      s.selected?.id === symbolId &&
      scopeRef.current?.projectId === scope.projectId &&
      scopeRef.current?.snapshotId === scope.snapshotId;
    try {
      const candidates = await queryMatchingContexts(scope, symbolId, projects);
      if (!isCurrent()) return;
      s.setContextCandidates(candidates);
      if (
        candidates.length === 1 &&
        candidates[0]?.projectId === scope.projectId
      )
        s.setContextSearchMessage(
          'This declaration is present only in the active project context.',
        );
      else if (candidates.length > 1)
        s.setContextSearchMessage(
          'The same declaration anchor appears in multiple snapshots. Choose the destination context.',
        );
    } catch (error) {
      if (isCurrent()) s.setContextSearchMessage(errorMessage(error));
    } finally {
      if (generation === s.contextSearchGeneration.current)
        s.setContextSearchLoading(false);
    }
  };
}

export function useProjectionState(
  scopeRef: RefObject<Scope | null>,
  selectionGenerationRef: RefObject<number>,
  onCloseDrawer: () => void,
) {
  const s = useProjectionStore();

  function invalidateProjectionReads() {
    ++s.graphGeneration.current;
    ++s.evidenceGeneration.current;
    ++s.contextSearchGeneration.current;
    s.setGraphLoading(false);
    s.setEvidenceLoading(false);
    s.setContextSearchLoading(false);
  }

  function resetContextFollow() {
    ++s.contextSearchGeneration.current;
    s.setContextCandidates([]);
    s.setContextSearchMessage(null);
    s.setContextSearchLoading(false);
  }

  function clearSelection() {
    invalidateProjectionReads();
    s.requestedEvidenceId.current = null;
    s.setSelected(null);
    s.setGraph(null);
    s.setGraphError(null);
    s.setEvidence(null);
    s.setEvidenceError(null);
    s.setSelectedRelationId(null);
    s.setContextCandidates([]);
    s.setContextSearchMessage(null);
    onCloseDrawer();
    s.setActiveView('source');
  }

  async function loadGraph(
    root: CodeSymbol | string,
    scope: Scope,
    kinds: RelationKindFilter[],
    requestedDirection: TraceDirection,
  ): Promise<GraphProjection | null> {
    const generation = ++s.graphGeneration.current;
    const rootSymbolId = typeof root === 'string' ? root : root.id;
    ++s.evidenceGeneration.current;
    s.requestedEvidenceId.current = null;
    s.setGraphLoading(true);
    s.setGraphError(null);
    s.setGraph(null);
    s.setSelectedRelationId(null);
    s.setEvidence(null);
    s.setEvidenceLoading(false);
    s.setEvidenceError(null);
    try {
      const projection = await readGraph(
        rootSymbolId,
        scope,
        kinds,
        requestedDirection,
      );
      if (
        generation !== s.graphGeneration.current ||
        scopeRef.current?.projectId !== scope.projectId ||
        scopeRef.current?.snapshotId !== scope.snapshotId
      )
        return null;
      s.setGraph(projection);
      return projection;
    } catch (error) {
      if (generation === s.graphGeneration.current)
        s.setGraphError(errorMessage(error));
      return null;
    } finally {
      if (generation === s.graphGeneration.current) s.setGraphLoading(false);
    }
  }

  async function loadEvidence(
    id: string,
    scope: Scope,
    relationId: string | null = null,
  ) {
    const generation = ++s.evidenceGeneration.current;
    s.requestedEvidenceId.current = id;
    s.setEvidenceLoading(true);
    s.setEvidenceError(null);
    s.setSelectedRelationId(relationId);
    s.setEvidence(null);
    try {
      const item = await readEvidence(id, scope);
      if (
        generation !== s.evidenceGeneration.current ||
        scopeRef.current?.projectId !== scope.projectId ||
        scopeRef.current?.snapshotId !== scope.snapshotId
      )
        return;
      s.setEvidence(item);
    } catch (error) {
      if (generation === s.evidenceGeneration.current)
        s.setEvidenceError(errorMessage(error));
    } finally {
      if (generation === s.evidenceGeneration.current)
        s.setEvidenceLoading(false);
    }
  }

  return {
    ...s,
    invalidateProjectionReads,
    resetContextFollow,
    clearSelection,
    loadGraph,
    loadEvidence,
    findMatchingContexts: createContextSearchLoader(
      s,
      scopeRef,
      selectionGenerationRef,
    ),
  };
}
