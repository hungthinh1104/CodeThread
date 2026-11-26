import type { RefObject } from 'react';
import { errorMessage, readGraph, readSession } from '../queries.ts';
import type {
  CodeSymbol,
  EvidenceItem,
  FindSymbolPathsResponse,
  GraphProjection,
  InvestigationView,
  NavigationEntry,
  ProjectContexts,
  RelationKindFilter,
  Scope,
  SessionProjection,
  TraceDirection,
  WorkspaceMetadata,
} from '../types.ts';
import type { WorkspaceSessionRefs } from './useWorkspaceSession.ts';

export interface InvestigationActionsInput {
  readonly refs: WorkspaceSessionRefs;
  readonly workspace: WorkspaceMetadata | null;
  readonly projects: ProjectContexts | null;
  readonly session: SessionProjection | null;
  readonly setSession: (session: SessionProjection | null) => void;
  readonly resetProject: (projectId: string, clearCatalog?: boolean) => number;
  readonly selectProject: (projectId: string) => Promise<Scope | null>;
  readonly reportWorkspaceError: (
    message: string | null,
    retryable?: boolean,
  ) => void;
  readonly setWorkspaceNotice: (notice: string | null) => void;
  readonly selected: CodeSymbol | null;
  readonly setSelected: (symbol: CodeSymbol | null) => void;
  readonly graph: GraphProjection | null;
  readonly setGraph: (graph: GraphProjection | null) => void;
  readonly evidence: EvidenceItem | null;
  readonly setEvidence: (item: EvidenceItem | null) => void;
  readonly relationKinds: RelationKindFilter[];
  readonly setRelationKinds: (kinds: RelationKindFilter[]) => void;
  readonly direction: TraceDirection;
  readonly setDirection: (direction: TraceDirection) => void;
  readonly selectedRelationId: string | null;
  readonly activeView: InvestigationView;
  readonly setActiveView: (view: InvestigationView) => void;
  readonly requestedEvidenceId: RefObject<string | null>;
  readonly invalidateProjectionReads: () => void;
  readonly resetContextFollow: () => void;
  readonly clearSelection: () => void;
  readonly loadGraph: (
    root: CodeSymbol | string,
    scope: Scope,
    kinds: RelationKindFilter[],
    direction: TraceDirection,
  ) => Promise<GraphProjection | null>;
  readonly loadEvidence: (
    id: string,
    scope: Scope,
    relationId?: string | null,
  ) => Promise<void>;
  readonly setContextSearchMessage: (message: string | null) => void;
  readonly pathsResult: FindSymbolPathsResponse | null;
  readonly setSearchMode: (mode: 'project' | 'repository') => void;
  readonly setSearchOffset: (offset: number) => void;
  readonly setSearchQuery: (query: string) => void;
  readonly compactViewport: boolean;
  readonly openInspector: (trigger: HTMLButtonElement) => void;
  readonly focusSelectedDeclaration: (generation: number) => void;
  readonly pushHistory: (entry: NavigationEntry) => void;
}

export function isAllowedEvidence(
  id: string,
  selected: CodeSymbol | null,
  graph: GraphProjection | null,
  pathsResult: FindSymbolPathsResponse | null,
): boolean {
  return Boolean(
    selected?.declarationEvidenceId === id ||
    graph?.graph.evidenceRefs.some((item) => item.id === id) ||
    graph?.unknowns.items.some((item) => item.evidenceId === id) ||
    pathsResult?.evidenceRefs.some((item) => item.id === id),
  );
}

export function createRestoreHandler(input: InvestigationActionsInput) {
  const { refs } = input;
  return async function restoreNavigation(
    entry: NavigationEntry,
    accept: () => void,
  ) {
    const selection = ++refs.selectionGeneration.current;
    const generation = ++refs.navigationRestoreGeneration.current;
    const isCurrent = () =>
      generation === refs.navigationRestoreGeneration.current &&
      selection === refs.selectionGeneration.current;
    const project = input.projects?.items.find(
      (item) => item.id === entry.projectId,
    );
    if (
      input.workspace?.scanId !== entry.scanId ||
      project?.status !== 'ready' ||
      project.snapshotId !== entry.snapshotId ||
      (entry.root && entry.root.snapshotId !== entry.snapshotId)
    ) {
      input.reportWorkspaceError(
        'History snapshot identity no longer matches this project context.',
      );
      return;
    }
    const scope: Scope = {
      scanId: entry.scanId,
      projectId: entry.projectId,
      snapshotId: entry.snapshotId,
    };
    const active = refs.scopeRef.current;
    const changesProject =
      !active ||
      active.scanId !== scope.scanId ||
      active.projectId !== scope.projectId ||
      active.snapshotId !== scope.snapshotId;
    input.invalidateProjectionReads();
    input.reportWorkspaceError(null);
    try {
      const destination = changesProject
        ? await readSession(scope)
        : input.session;
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
        input.reportWorkspaceError(
          'The restored snapshot did not return the saved declaration.',
        );
        return;
      }
      if (changesProject) {
        input.resetProject(scope.projectId);
        refs.scopeRef.current = scope;
        input.setSession(destination);
      } else {
        input.clearSelection();
      }
      input.setRelationKinds(entry.relationKinds);
      input.setDirection(entry.direction);
      input.setSelected(root);
      input.setActiveView(entry.view);
      input.setGraph(projection);
      accept();

      const relationId =
        projection?.graph.relations.find(
          (relation) => relation.id === entry.selectedRelationId,
        )?.id ?? null;
      const id = entry.selectedEvidenceId;
      if (id && isAllowedEvidence(id, root, projection, null)) {
        void input.loadEvidence(id, scope, relationId);
      } else if (id) {
        input.reportWorkspaceError(
          'The saved evidence is no longer in the restored projection.',
        );
      }
    } catch (error) {
      if (isCurrent()) input.reportWorkspaceError(errorMessage(error));
    }
  };
}
