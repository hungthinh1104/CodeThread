import { useEffect, useRef, useState, type RefObject } from 'react';
import {
  ApiFailure,
  openScan,
  readRepositories,
  readViewer,
  readWorkspaceMetadata,
  rememberWorkspaceScan,
} from './api.ts';
import { errorMessage, projectScope, readSession } from './scoped-api.ts';
import type {
  ProjectContexts,
  RepositoryItem,
  Scope,
  SessionProjection,
  WorkspaceMetadata,
} from './types.ts';
import type { NavigationEntry } from './useWorkspaceHistory.ts';

type RetryTarget =
  | {
      kind: 'project';
      projectId: string;
      metadata: WorkspaceMetadata;
      contexts: ProjectContexts;
    }
  | { kind: 'contexts'; metadata: WorkspaceMetadata }
  | null;

type SessionInput = {
  scopeRef: RefObject<Scope | null>;
  contextGenerationRef: RefObject<number>;
  navigationRestoreGenerationRef: RefObject<number>;
  selectionGenerationRef: RefObject<number>;
  getFilterDefaults: () => Pick<NavigationEntry, 'relationKinds' | 'direction'>;
  onResetProject: (clearCatalog: boolean) => void;
  onResetWorkspace: () => void;
  onUnmountInvalidate: () => void;
  onResetHistory: (entry: NavigationEntry | null) => void;
  onPushHistory: (entry: NavigationEntry) => void;
};

export function useWorkspaceSession(input: SessionInput) {
  const [repositories, setRepositories] = useState<RepositoryItem[]>([]);
  const [selectedRepositoryId, setSelectedRepositoryId] = useState('');
  const [workspace, setWorkspace] = useState<WorkspaceMetadata | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [projects, setProjects] = useState<ProjectContexts | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [session, setSession] = useState<SessionProjection | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [workspaceNotice, setWorkspaceNotice] = useState<string | null>(null);
  const [workspaceRetryable, setWorkspaceRetryable] = useState(false);
  const [initializationRetryVersion, setInitializationRetryVersion] =
    useState(0);

  const retryTargetRef = useRef<RetryTarget>(null);
  const workspaceGeneration = useRef(0);

  function reportWorkspaceError(message: string | null, retryable = false) {
    setWorkspaceError(message);
    setWorkspaceRetryable(message !== null && retryable);
  }

  function resetProject(projectId: string, clearCatalog = false) {
    const generation = ++input.contextGenerationRef.current;
    input.scopeRef.current = null;
    setSelectedProjectId(projectId);
    setSession(null);
    input.onResetProject(clearCatalog);
    reportWorkspaceError(null);
    setWorkspaceNotice(null);
    return generation;
  }

  function resetWorkspace() {
    const generation = ++workspaceGeneration.current;
    ++input.selectionGenerationRef.current;
    retryTargetRef.current = null;
    resetProject('', true);
    input.onResetWorkspace();
    setWorkspace(null);
    setSessionExpired(false);
    setProjects(null);
    input.onResetHistory(null);
    return generation;
  }

  useEffect(() => {
    if (!workspace?.expiresAt) {
      setSessionExpired(false);
      return;
    }
    const expiresMs = Date.parse(workspace.expiresAt);
    if (!Number.isFinite(expiresMs)) {
      setSessionExpired(false);
      return;
    }
    const remaining = expiresMs - Date.now();
    if (remaining <= 0) {
      setSessionExpired(true);
      return;
    }
    setSessionExpired(false);
    const timer = setTimeout(
      () => setSessionExpired(true),
      Math.min(remaining, 2_147_483_647),
    );
    return () => clearTimeout(timer);
  }, [workspace?.expiresAt]);

  async function selectProject(
    projectId: string,
    metadata = workspace,
    contexts = projects,
    historyMode: 'push' | 'replace' = 'push',
  ): Promise<Scope | null> {
    if (!metadata || !contexts) return null;
    const scope = projectScope(projectId, metadata, contexts);
    if (!scope) {
      reportWorkspaceError(
        'Only a ready project context with a published snapshot can be selected.',
      );
      return null;
    }
    ++input.navigationRestoreGenerationRef.current;
    const selection = input.selectionGenerationRef.current;
    const contextAtStart = input.contextGenerationRef.current;
    const isCurrent = () =>
      selection === input.selectionGenerationRef.current &&
      contextAtStart === input.contextGenerationRef.current;
    reportWorkspaceError(null);
    setWorkspaceNotice(null);
    try {
      const projection = await readSession(scope);
      if (!isCurrent()) return null;
      retryTargetRef.current = null;
      resetProject(projectId);
      input.scopeRef.current = scope;
      setSession(projection);
      const entry: NavigationEntry = {
        ...scope,
        root: null,
        ...input.getFilterDefaults(),
        selectedRelationId: null,
        selectedEvidenceId: null,
        view: 'source',
      };
      if (historyMode === 'replace') input.onResetHistory(entry);
      else input.onPushHistory(entry);
      return scope;
    } catch (error) {
      if (isCurrent()) {
        if (!input.scopeRef.current)
          retryTargetRef.current = {
            kind: 'project',
            projectId,
            metadata,
            contexts,
          };
        reportWorkspaceError(errorMessage(error), !input.scopeRef.current);
      }
      return null;
    }
  }

  async function loadProjectContexts(
    metadata: WorkspaceMetadata,
    generation: number,
    preferredProjectId?: string | null,
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
      retryTargetRef.current = null;
      setWorkspace(metadata);
      setProjects(result);
      const ready = result.items.filter(
        (item) => item.status === 'ready' && item.snapshotId !== null,
      );
      const initial =
        (preferredProjectId
          ? ready.find((item) => item.id === preferredProjectId)
          : undefined) ??
        ready.find((item) => item.id === result.initialProjectId) ??
        ready[0];
      if (!initial) {
        reportWorkspaceError(
          'This scan has no ready project context. Failed and unsupported contexts remain listed with their diagnostics.',
        );
        return;
      }
      await selectProject(initial.id, metadata, result, 'replace');
    } catch (error) {
      if (generation === workspaceGeneration.current) {
        retryTargetRef.current = { kind: 'contexts', metadata };
        reportWorkspaceError(errorMessage(error), true);
      }
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
        const params = new URLSearchParams(window.location.search);
        const deepScanId = params.get('scanId');
        const deepProjectId = params.get('projectId');
        if (
          deepScanId &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            deepScanId,
          )
        ) {
          try {
            const opened = await openScan(deepScanId);
            if (!isCurrent()) return;
            setSelectedRepositoryId(opened.workspace.repositoryId);
            await loadProjectContexts(
              opened.workspace,
              resetWorkspace(),
              deepProjectId,
            );
            return;
          } catch (error) {
            if (isCurrent()) reportWorkspaceError(errorMessage(error), true);
            return;
          }
        }
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
      ++input.contextGenerationRef.current;
      ++input.navigationRestoreGenerationRef.current;
      ++input.selectionGenerationRef.current;
      input.onUnmountInvalidate();
    };
  }, [initializationRetryVersion]);

  async function chooseRepository(id: string) {
    const generation = resetWorkspace();
    rememberWorkspaceScan(null);
    setSelectedRepositoryId(id);
    const repository = repositories.find((item) => item.id === id);
    if (!repository) return;
    if (!repository.activeScanId) {
      reportWorkspaceError(
        'This repository has no active scan. Queue a scan from Repositories.',
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

  async function retryWorkspace() {
    const target = retryTargetRef.current;
    if (target?.kind === 'project') {
      await selectProject(
        target.projectId,
        target.metadata,
        target.contexts,
        'replace',
      );
      return;
    }
    if (target?.kind === 'contexts') {
      await loadProjectContexts(target.metadata, workspaceGeneration.current);
      return;
    }
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

  return {
    repositories,
    selectedRepositoryId,
    workspace,
    sessionExpired,
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
    selectProject,
    chooseRepository,
    retryWorkspace,
  };
}
