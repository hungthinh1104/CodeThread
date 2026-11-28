import {
  errorMessage,
  readEvidence,
  readGraph,
  readSession,
} from './scoped-api.ts';
import type {
  CodeSymbol,
  EvidenceProjection,
  GraphProjection,
  ProjectContexts,
  Scope,
  SessionProjection,
  WorkspaceMetadata,
} from './types.ts';
import type { NavigationEntry } from './useWorkspaceHistory.ts';

type DeclarationCommit = {
  scope: Scope;
  changesProject: boolean;
  destination: SessionProjection;
  root: CodeSymbol;
  projection: GraphProjection;
  declaration: EvidenceProjection['items'][number];
};

type RestoreCommit = {
  scope: Scope;
  changesProject: boolean;
  destination: SessionProjection;
  root: CodeSymbol | null;
  projection: GraphProjection | null;
  entry: NavigationEntry;
};

export async function loadScopedDeclaration(params: {
  scope: Scope;
  symbolId: string;
  currentScope: Scope | null;
  currentSession: SessionProjection | null;
  relationKinds: ('calls' | 'references')[];
  direction: 'outgoing' | 'incoming' | 'both';
  isCurrent: () => boolean;
  reportError: (message: string | null) => void;
  onCommit: (data: DeclarationCommit) => void;
}): Promise<boolean> {
  const { scope, symbolId, currentScope, isCurrent, reportError } = params;
  const changesProject =
    scope.scanId !== currentScope?.scanId ||
    scope.projectId !== currentScope.projectId ||
    scope.snapshotId !== currentScope.snapshotId;
  reportError(null);
  try {
    const destination = changesProject
      ? await readSession(scope)
      : params.currentSession;
    if (!destination || !isCurrent()) return false;
    const projection = await readGraph(
      symbolId,
      scope,
      params.relationKinds,
      params.direction,
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
    params.onCommit({
      scope,
      changesProject,
      destination,
      root,
      projection,
      declaration,
    });
    return true;
  } catch (error) {
    if (isCurrent()) reportError(errorMessage(error));
    return false;
  }
}

export async function restoreNavigationEntry(params: {
  entry: NavigationEntry;
  workspace: WorkspaceMetadata | null;
  projects: ProjectContexts | null;
  currentScope: Scope | null;
  currentSession: SessionProjection | null;
  isCurrent: () => boolean;
  invalidateProjectionReads: () => void;
  reportError: (message: string | null) => void;
  onCommit: (data: RestoreCommit) => void;
  onLoadEvidence: (id: string, scope: Scope, relationId: string | null) => void;
}): Promise<void> {
  const { entry, projects, workspace, currentScope, isCurrent, reportError } =
    params;
  const project = projects?.items.find((item) => item.id === entry.projectId);
  if (
    workspace?.scanId !== entry.scanId ||
    project?.status !== 'ready' ||
    project.snapshotId !== entry.snapshotId ||
    (entry.root && entry.root.snapshotId !== entry.snapshotId)
  ) {
    reportError(
      'History snapshot identity no longer matches this project context.',
    );
    return;
  }
  const scope: Scope = {
    scanId: entry.scanId,
    projectId: entry.projectId,
    snapshotId: entry.snapshotId,
  };
  const changesProject =
    !currentScope ||
    currentScope.scanId !== scope.scanId ||
    currentScope.projectId !== scope.projectId ||
    currentScope.snapshotId !== scope.snapshotId;
  params.invalidateProjectionReads();
  reportError(null);
  try {
    const destination = changesProject
      ? await readSession(scope)
      : params.currentSession;
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
      reportError(
        'The restored snapshot did not return the saved declaration.',
      );
      return;
    }
    params.onCommit({
      scope,
      changesProject,
      destination,
      root,
      projection,
      entry,
    });

    const relationId =
      projection?.graph.relations.find(
        (relation) => relation.id === entry.selectedRelationId,
      )?.id ?? null;
    const id = entry.selectedEvidenceId;
    if (
      id &&
      (root?.declarationEvidenceId === id ||
        projection?.graph.evidenceRefs.some((item) => item.id === id) ||
        projection?.unknowns.items.some((item) => item.evidenceId === id))
    ) {
      params.onLoadEvidence(id, scope, relationId);
    } else if (id) {
      reportError(
        'The saved evidence is no longer in the restored projection.',
      );
    }
  } catch (error) {
    if (isCurrent()) reportError(errorMessage(error));
  }
}
