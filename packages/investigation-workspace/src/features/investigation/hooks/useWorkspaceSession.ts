import { useEffect, useRef, useState, type RefObject } from 'react';
import {
  ApiFailure,
  openScan,
  readRepositories,
  readViewer,
  readWorkspaceMetadata,
  rememberWorkspaceScan,
} from '../api.ts';
import { errorMessage, projectScope, readSession } from '../queries.ts';
import type {
  NavigationEntry,
  ProjectContexts,
  RelationKindFilter,
  RepositoryItem,
  Scope,
  SessionProjection,
  TraceDirection,
  WorkspaceMetadata,
} from '../types.ts';

type RetryTarget =
  | {
      kind: 'project';
      projectId: string;
      metadata: WorkspaceMetadata;
      contexts: ProjectContexts;
    }
  | { kind: 'contexts'; metadata: WorkspaceMetadata }
  | null;

export interface WorkspaceSessionRefs {
  readonly scopeRef: RefObject<Scope | null>;
  readonly workspaceGeneration: RefObject<number>;
  readonly contextGeneration: RefObject<number>;
  readonly selectionGeneration: RefObject<number>;
  readonly navigationRestoreGeneration: RefObject<number>;
}

export interface UseWorkspaceSessionInput {
  readonly refs: WorkspaceSessionRefs;
  readonly relationKinds: RelationKindFilter[];
  readonly direction: TraceDirection;
  readonly clearSelection: () => void;
  readonly onProjectReset: (clearCatalog: boolean) => void;
  readonly onWorkspaceReset: () => void;
  readonly resetHistory: (entry: NavigationEntry | null) => void;
  readonly pushHistory: (entry: NavigationEntry) => void;
}

function findInitialReadyProject(result: ProjectContexts) {
  const ready = result.items.filter(
    (item) => item.status === 'ready' && item.snapshotId !== null,
  );
  return ready.find((item) => item.id === result.initialProjectId) ?? ready[0];
}

function useInitialWorkspaceRecovery(
  retryVersion: number,
  refs: WorkspaceSessionRefs,
  callbacks: {
    reportWorkspaceError: (message: string | null, retryable?: boolean) => void;
    setRepositories: (items: RepositoryItem[]) => void;
    setSelectedRepositoryId: (id: string) => void;
    resetWorkspace: () => number;
    loadProjectContexts: (
      metadata: WorkspaceMetadata,
      generation: number,
    ) => Promise<void>;
  },
) {
  const latestCallbacks = useRef(callbacks);
  latestCallbacks.current = callbacks;

  useEffect(() => {
    let mounted = true;
    const generation = refs.workspaceGeneration.current;
    const isCurrent = () =>
      mounted && generation === refs.workspaceGeneration.current;
    latestCallbacks.current.reportWorkspaceError(null);
    void (async () => {
      try {
        const repositoryResult = await readRepositories();
        if (!isCurrent()) return;
        latestCallbacks.current.setRepositories(repositoryResult.items);
        try {
          const recovered = await readWorkspaceMetadata();
          if (!recovered || !isCurrent()) return;
          latestCallbacks.current.setSelectedRepositoryId(
            recovered.workspace.repositoryId,
          );
          await latestCallbacks.current.loadProjectContexts(
            recovered.workspace,
            latestCallbacks.current.resetWorkspace(),
          );
        } catch (error) {
          if (
            isCurrent() &&
            !(
              error instanceof ApiFailure &&
              error.code === 'WORKSPACE_SESSION_EXPIRED'
            )
          )
            latestCallbacks.current.reportWorkspaceError(
              errorMessage(error),
              true,
            );
        }
      } catch (error) {
        if (isCurrent())
          latestCallbacks.current.reportWorkspaceError(
            errorMessage(error),
            true,
          );
      }
    })();
    return () => {
      mounted = false;
      ++refs.workspaceGeneration.current;
      ++refs.contextGeneration.current;
      ++refs.navigationRestoreGeneration.current;
      ++refs.selectionGeneration.current;
    };
  }, [retryVersion]);
}

function createContextActions(params: {
  input: UseWorkspaceSessionInput;
  workspace: WorkspaceMetadata | null;
  projects: ProjectContexts | null;
  setWorkspace: (metadata: WorkspaceMetadata | null) => void;
  setProjects: (contexts: ProjectContexts | null) => void;
  setSession: (session: SessionProjection | null) => void;
  setWorkspaceNotice: (notice: string | null) => void;
  reportWorkspaceError: (message: string | null, retryable?: boolean) => void;
  resetProject: (projectId: string, clearCatalog?: boolean) => number;
  retryTargetRef: RefObject<RetryTarget>;
}) {
  const { refs } = params.input;

  async function selectProject(
    projectId: string,
    metadata = params.workspace,
    contexts = params.projects,
    historyMode: 'push' | 'replace' = 'push',
  ): Promise<Scope | null> {
    if (!metadata || !contexts) return null;
    const scope = projectScope(projectId, metadata, contexts);
    if (!scope) {
      params.reportWorkspaceError(
        'Only a ready project context with a published snapshot can be selected.',
      );
      return null;
    }
    ++refs.navigationRestoreGeneration.current;
    const selection = refs.selectionGeneration.current;
    const contextAtStart = refs.contextGeneration.current;
    const isCurrent = () =>
      selection === refs.selectionGeneration.current &&
      contextAtStart === refs.contextGeneration.current;
    params.reportWorkspaceError(null);
    params.setWorkspaceNotice(null);
    try {
      const projection = await readSession(scope);
      if (!isCurrent()) return null;
      params.retryTargetRef.current = null;
      params.resetProject(projectId);
      refs.scopeRef.current = scope;
      params.setSession(projection);
      const entry: NavigationEntry = {
        ...scope,
        root: null,
        relationKinds: params.input.relationKinds,
        direction: params.input.direction,
        selectedRelationId: null,
        selectedEvidenceId: null,
        view: 'source',
      };
      ++refs.navigationRestoreGeneration.current;
      if (historyMode === 'replace') params.input.resetHistory(entry);
      else params.input.pushHistory(entry);
      return scope;
    } catch (error) {
      if (isCurrent()) {
        if (!refs.scopeRef.current)
          params.retryTargetRef.current = {
            kind: 'project',
            projectId,
            metadata,
            contexts,
          };
        params.reportWorkspaceError(
          errorMessage(error),
          !refs.scopeRef.current,
        );
      }
      return null;
    }
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
      if (generation !== refs.workspaceGeneration.current) return;
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
      params.retryTargetRef.current = null;
      params.setWorkspace(metadata);
      params.setProjects(result);
      const initial = findInitialReadyProject(result);
      if (!initial) {
        params.reportWorkspaceError(
          'This scan has no ready project context. Failed and unsupported contexts remain listed with their diagnostics.',
        );
        return;
      }
      await selectProject(initial.id, metadata, result, 'replace');
    } catch (error) {
      if (generation === refs.workspaceGeneration.current) {
        params.retryTargetRef.current = { kind: 'contexts', metadata };
        params.reportWorkspaceError(errorMessage(error), true);
      }
    }
  }

  return { selectProject, loadProjectContexts };
}

function createRepositoryActions(context: {
  repositories: RepositoryItem[];
  workspace: WorkspaceMetadata | null;
  projects: ProjectContexts | null;
  selectedProjectId: string;
  selectedRepositoryId: string;
  setSelectedRepositoryId: (id: string) => void;
  retryTargetRef: RefObject<RetryTarget>;
  workspaceGenerationRef: RefObject<number>;
  resetWorkspace: () => number;
  loadProjectContexts: (
    metadata: WorkspaceMetadata,
    generation: number,
  ) => Promise<void>;
  selectProject: (
    projectId: string,
    metadata?: WorkspaceMetadata | null,
    contexts?: ProjectContexts | null,
    historyMode?: 'push' | 'replace',
  ) => Promise<Scope | null>;
  reportWorkspaceError: (message: string | null, retryable?: boolean) => void;
  bumpRetry: () => void;
}) {
  async function chooseRepository(id: string) {
    const generation = context.resetWorkspace();
    rememberWorkspaceScan(null);
    context.setSelectedRepositoryId(id);
    const repository = context.repositories.find((item) => item.id === id);
    if (!repository) return;
    if (!repository.activeScanId) {
      context.reportWorkspaceError(
        'This repository has no active scan. Start or select a scan through the existing backend workflow.',
      );
      return;
    }
    try {
      const opened = await openScan(repository.activeScanId);
      if (generation !== context.workspaceGenerationRef.current) return;
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
      await context.loadProjectContexts(opened.workspace, generation);
    } catch (error) {
      if (generation === context.workspaceGenerationRef.current)
        context.reportWorkspaceError(errorMessage(error), true);
    }
  }

  async function retryWorkspace() {
    const target = context.retryTargetRef.current;
    if (target?.kind === 'project') {
      await context.selectProject(
        target.projectId,
        target.metadata,
        target.contexts,
        'replace',
      );
      return;
    }
    if (target?.kind === 'contexts') {
      await context.loadProjectContexts(
        target.metadata,
        context.workspaceGenerationRef.current,
      );
      return;
    }
    if (context.workspace && context.projects && context.selectedProjectId) {
      await context.selectProject(context.selectedProjectId);
      return;
    }
    if (context.selectedRepositoryId) {
      await chooseRepository(context.selectedRepositoryId);
      return;
    }
    context.bumpRetry();
  }

  async function openSpecificScan(repositoryId: string, scanId: string) {
    const generation = context.resetWorkspace();
    rememberWorkspaceScan(null);
    context.setSelectedRepositoryId(repositoryId);
    try {
      const opened = await openScan(scanId);
      if (generation !== context.workspaceGenerationRef.current) return;
      if (
        opened.workspace.repositoryId !== repositoryId ||
        opened.workspace.scanId !== scanId
      )
        throw new ApiFailure(502, {
          error: {
            code: 'WORKSPACE_SCAN_MISMATCH',
            message:
              'The opened scan does not match the selected repository and scan.',
          },
        });
      await context.loadProjectContexts(opened.workspace, generation);
    } catch (error) {
      if (generation === context.workspaceGenerationRef.current)
        context.reportWorkspaceError(errorMessage(error), true);
    }
  }

  return { chooseRepository, openSpecificScan, retryWorkspace };
}

export function useWorkspaceSession(input: UseWorkspaceSessionInput) {
  const { refs } = input;
  const [repositories, setRepositories] = useState<RepositoryItem[]>([]);
  const [selectedRepositoryId, setSelectedRepositoryId] = useState('');
  const [workspace, setWorkspace] = useState<WorkspaceMetadata | null>(null);
  const [projects, setProjects] = useState<ProjectContexts | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [session, setSession] = useState<SessionProjection | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [workspaceNotice, setWorkspaceNotice] = useState<string | null>(null);
  const [workspaceRetryable, setWorkspaceRetryable] = useState(false);
  const [retryVersion, setRetryVersion] = useState(0);
  const retryTargetRef = useRef<RetryTarget>(null);

  function reportWorkspaceError(message: string | null, retryable = false) {
    setWorkspaceError(message);
    setWorkspaceRetryable(message !== null && retryable);
  }

  function resetProject(projectId: string, clearCatalog = false) {
    const generation = ++refs.contextGeneration.current;
    refs.scopeRef.current = null;
    setSelectedProjectId(projectId);
    setSession(null);
    input.clearSelection();
    input.onProjectReset(clearCatalog);
    reportWorkspaceError(null);
    setWorkspaceNotice(null);
    return generation;
  }

  function resetWorkspace() {
    const generation = ++refs.workspaceGeneration.current;
    ++refs.selectionGeneration.current;
    retryTargetRef.current = null;
    resetProject('', true);
    setWorkspace(null);
    setProjects(null);
    input.onWorkspaceReset();
    ++refs.navigationRestoreGeneration.current;
    input.resetHistory(null);
    return generation;
  }

  const contextActions = createContextActions({
    input,
    workspace,
    projects,
    setWorkspace,
    setProjects,
    setSession,
    setWorkspaceNotice,
    reportWorkspaceError,
    resetProject,
    retryTargetRef,
  });

  const repositoryActions = createRepositoryActions({
    repositories,
    workspace,
    projects,
    selectedProjectId,
    selectedRepositoryId,
    setSelectedRepositoryId,
    retryTargetRef,
    workspaceGenerationRef: refs.workspaceGeneration,
    resetWorkspace,
    loadProjectContexts: contextActions.loadProjectContexts,
    selectProject: contextActions.selectProject,
    reportWorkspaceError,
    bumpRetry: () => setRetryVersion((version) => version + 1),
  });

  useInitialWorkspaceRecovery(retryVersion, refs, {
    reportWorkspaceError,
    setRepositories,
    setSelectedRepositoryId,
    resetWorkspace,
    loadProjectContexts: contextActions.loadProjectContexts,
  });

  function upsertRepository(updated: RepositoryItem) {
    setRepositories((prev) => {
      const exists = prev.some((item) => item.id === updated.id);
      return exists
        ? prev.map((item) => (item.id === updated.id ? updated : item))
        : [updated, ...prev];
    });
  }

  function selectRegisteredRepository(created: RepositoryItem) {
    upsertRepository(created);
    resetWorkspace();
    rememberWorkspaceScan(null);
    setSelectedRepositoryId(created.id);
    setWorkspaceNotice(
      'Repository registered. Run a scan to publish an immutable snapshot.',
    );
  }

  return {
    repositories,
    upsertRepository,
    selectRegisteredRepository,
    selectedRepositoryId,
    workspace,
    projects,
    selectedProjectId,
    session,
    setSession,
    workspaceError,
    workspaceNotice,
    setWorkspaceNotice,
    workspaceRetryable,
    reportWorkspaceError,
    resetProject,
    selectProject: contextActions.selectProject,
    ...repositoryActions,
  };
}
