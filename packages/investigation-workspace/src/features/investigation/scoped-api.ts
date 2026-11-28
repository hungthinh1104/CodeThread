import { ApiFailure, readViewer } from './api.ts';
import type {
  EvidenceProjection,
  FollowContextProjection,
  GraphProjection,
  PathsProjection,
  ProjectContexts,
  Scope,
  SearchState,
  SessionProjection,
  WorkspaceMetadata,
} from './types.ts';
import type { NavigationEntry } from './useWorkspaceHistory.ts';

export type ApiResponse<T> = T | { projectId: string; result: T };

export function emptySearchState(): SearchState {
  return { items: [], offset: 0, total: 0, nextOffset: null };
}

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

export function errorMessage(error: unknown): string {
  if (error instanceof ApiFailure) return `${error.code}: ${error.message}`;
  return 'The local Investigation Workspace request failed.';
}

export function evidenceId(item: EvidenceProjection['items'][number]): string {
  return item.status === 'available' ? item.evidence.id : item.evidenceId;
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

export async function readSession(scope: Scope): Promise<SessionProjection> {
  return unwrapScoped(
    await readViewer<ApiResponse<SessionProjection>>(scope.scanId, 'session', {
      projectId: scope.projectId,
      request: {},
    }),
    scope,
  );
}

export async function readGraph(
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

export async function readEvidence(id: string, scope: Scope) {
  const response = await readViewer<ApiResponse<EvidenceProjection>>(
    scope.scanId,
    'evidence',
    {
      projectId: scope.projectId,
      request: { snapshotId: scope.snapshotId, evidenceIds: [id] },
    },
  );
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

export async function readFollowContexts(
  symbolId: string,
  scope: Scope,
): Promise<FollowContextProjection> {
  const response = await readViewer<ApiResponse<FollowContextProjection>>(
    scope.scanId,
    'follow-context',
    {
      projectId: scope.projectId,
      request: { snapshotId: scope.snapshotId, symbolId },
    },
  );
  return unwrapScoped(response, scope);
}

export async function readSymbolPaths(
  fromSymbolId: string,
  toSymbolId: string,
  scope: Scope,
  relationKinds: ('calls' | 'references')[],
  depth: number,
): Promise<PathsProjection> {
  const response = await readViewer<ApiResponse<PathsProjection>>(
    scope.scanId,
    'paths',
    {
      projectId: scope.projectId,
      request: {
        snapshotId: scope.snapshotId,
        fromSymbolId,
        toSymbolId,
        relationKinds,
        depth,
        nodeLimit: 200,
        pathLimit: 20,
      },
    },
  );
  return unwrapScoped(response, scope);
}
