import {
  ApiFailure,
  findWorkspacePaths,
  readBackendSymbols,
  readDeepNeighbors,
  readDirectEvidence,
  readViewer,
} from './api.ts';
import type {
  ApiResponse,
  EvidenceItem,
  EvidenceProjection,
  FindSymbolPathsRequest,
  FindSymbolPathsResponse,
  GraphProjection,
  ListSymbolsResponse,
  ProjectContexts,
  RelationKindFilter,
  Scope,
  SearchState,
  SessionProjection,
  TraceDepthOption,
  TraceDirection,
  TraceNodeLimitOption,
  WorkspaceMetadata,
} from './types.ts';

export function scopedSnapshotId(value: unknown): string | null {
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

export function unwrapScoped<T>(value: ApiResponse<T>, scope: Scope): T {
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

export async function readSession(scope: Scope): Promise<SessionProjection> {
  return unwrapScoped(
    await readViewer<ApiResponse<SessionProjection>>(scope.scanId, 'session', {
      projectId: scope.projectId,
      request: {},
    }),
    scope,
  );
}

export function requiresBackendGraph(
  kinds: readonly RelationKindFilter[],
  depth: TraceDepthOption,
  nodeLimit: TraceNodeLimitOption,
): boolean {
  return depth !== 2 || nodeLimit !== 50 || kinds.includes('constructs');
}

export async function readGraph(
  symbolId: string,
  scope: Scope,
  kinds: RelationKindFilter[],
  direction: TraceDirection,
  depth: TraceDepthOption = 2,
  nodeLimit: TraceNodeLimitOption = 50,
): Promise<GraphProjection> {
  const request = {
    snapshotId: scope.snapshotId,
    symbolId,
    direction,
    relationKinds: kinds,
    depth,
    nodeLimit,
  };
  if (requiresBackendGraph(kinds, depth, nodeLimit)) {
    return unwrapScoped(
      await readDeepNeighbors(scope.scanId, scope.projectId, request),
      scope,
    );
  }
  return unwrapScoped(
    await readViewer<ApiResponse<GraphProjection>>(scope.scanId, 'neighbors', {
      projectId: scope.projectId,
      request,
    }),
    scope,
  );
}

export async function readSymbolPaths(
  scope: Scope,
  request: FindSymbolPathsRequest,
): Promise<FindSymbolPathsResponse> {
  const response = await findWorkspacePaths(
    scope.scanId,
    scope.projectId,
    request,
  );
  const result = unwrapScoped(response, scope);
  if (
    result.fromSymbolId !== request.fromSymbolId ||
    result.toSymbolId !== request.toSymbolId
  ) {
    throw new ApiFailure(502, {
      error: {
        code: 'WORKSPACE_CONTEXT_MISMATCH',
        message: 'The symbol-path projection did not match the selected pair.',
      },
    });
  }
  return result;
}

export async function readSymbolSearchMeta(
  scope: Scope,
  query: string,
  offset: number,
): Promise<ListSymbolsResponse> {
  return unwrapScoped(
    await readBackendSymbols(scope.scanId, scope.projectId, query, offset),
    scope,
  );
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiFailure) return `${error.code}: ${error.message}`;
  return 'The local Investigation Workspace request failed.';
}

export function evidenceId(item: EvidenceItem): string {
  return item.status === 'available' ? item.evidence.id : item.evidenceId;
}

export async function readEvidence(
  id: string,
  scope: Scope,
): Promise<EvidenceItem> {
  let response: ApiResponse<EvidenceProjection>;
  try {
    response = await readViewer<ApiResponse<EvidenceProjection>>(
      scope.scanId,
      'evidence',
      {
        projectId: scope.projectId,
        request: { snapshotId: scope.snapshotId, evidenceIds: [id] },
      },
    );
  } catch (error) {
    if (error instanceof ApiFailure && error.code === 'VIEWER_UNAVAILABLE') {
      response = await readDirectEvidence(scope.scanId, scope.projectId, {
        snapshotId: scope.snapshotId,
        evidenceIds: [id],
      });
    } else {
      throw error;
    }
  }
  const item = unwrapScoped(response, scope).items.find(
    (candidate) => evidenceId(candidate) === id,
  );
  if (!item)
    throw new ApiFailure(502, {
      error: {
        code: 'WORKSPACE_EVIDENCE_MISSING',
        message:
          'The validated evidence response omitted the requested identity.',
      },
    });
  return item;
}

export function projectScope(
  projectId: string,
  workspace: WorkspaceMetadata | null,
  projects: ProjectContexts | null,
): Scope | null {
  const project = projects?.items.find((item) => item.id === projectId);
  if (!workspace || project?.status !== 'ready' || !project.snapshotId)
    return null;
  return {
    scanId: workspace.scanId,
    projectId,
    snapshotId: project.snapshotId,
  };
}

export function emptySearchState(): SearchState {
  return { items: [], offset: 0, total: 0, nextOffset: null };
}
