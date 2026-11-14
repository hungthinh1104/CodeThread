import { analysisResourceLimits } from '@codethread/code-model';
import {
  analyzeProject,
  AnalysisError,
  planRepositoryProjects,
  PROJECT_LIMITS,
} from '@codethread/symbol-indexer';
import type {
  AnalysisSnapshot,
  ProjectDiagnostic,
  RepositoryProject,
} from '@codethread/symbol-indexer';
import { acquireGitRepository } from '../git-source/repository-intake.ts';
import type { AcquiredGitRepository } from '../git-source/repository-intake.ts';
import type { GitSourceRequest } from '../git-source/types.ts';
import { repositoryWorkspaces } from './repository-workspaces.ts';
import { createSessionBudget } from './session-budget.ts';

export interface RepositoryProjectState {
  project: RepositoryProject;
  status: RepositoryProject['status'] | 'failed' | 'not_analyzed';
  snapshot?: AnalysisSnapshot;
  error?: { code: string; message: string };
}

/** Sequential project execution owns one overall deadline and bounded retained results. */
export async function analyzeGitRepository(
  request: Omit<GitSourceRequest, 'selectedPaths'>,
  pinnedAcquisition?: AcquiredGitRepository,
) {
  const limits = analysisResourceLimits('repository'),
    budget = createSessionBudget(request.signal, limits.maxDeadlineMs);
  let deadlineExceeded = false;
  let parentPeakRssBytes = process.memoryUsage().rss;
  const interval = setInterval(() => {
    parentPeakRssBytes = Math.max(
      parentPeakRssBytes,
      process.memoryUsage().rss,
    );
  }, 100);
  try {
    budget.throwIfStopped();
    const acquired =
      pinnedAcquisition ??
      (await acquireGitRepository(
        { ...request, signal: budget.signal },
        budget.throwIfStopped,
      ));
    if (
      acquired.repositoryId !== request.repositoryId ||
      (pinnedAcquisition !== undefined &&
        acquired.commitId !== request.revision)
    )
      throw new AnalysisError(
        'INVALID_MANIFEST',
        'Pinned repository acquisition does not match the analysis request.',
      );
    budget.throwIfStopped();
    const workspace = repositoryWorkspaces(
      acquired.metadata,
      budget.throwIfStopped,
    );
    budget.throwIfStopped();
    const environment = {
      files: acquired.files,
      metadata: acquired.metadata,
      workspacePackages: workspace.packages,
      deadlineAt: budget.deadlineAt,
      signal: budget.signal,
    };
    const plan = planRepositoryProjects(environment);
    budget.throwIfStopped();
    const projects: RepositoryProjectState[] = [];
    let resultBytes = 0,
      memberships = 0,
      contextSourceBytes = 0;
    const throwIfCallerCancelled = () => {
      if (request.signal?.aborted)
        throw new AnalysisError('CANCELLED', 'Repository analysis cancelled.');
    };
    const markRemainingProjects = (startIndex: number) => {
      deadlineExceeded = true;
      for (const project of plan.projects.slice(startIndex))
        projects.push(
          project.status === 'ready'
            ? {
                project,
                status: 'not_analyzed',
                error: {
                  code: 'ANALYSIS_TIMEOUT',
                  message:
                    'Project analysis did not complete before the repository session deadline.',
                },
              }
            : { project, status: project.status },
        );
    };
    const recordTimeout = (error: unknown, projectIndex: number) => {
      if (!(
        error instanceof AnalysisError && error.code === 'ANALYSIS_TIMEOUT'
      ))
        return false;
      throwIfCallerCancelled();
      markRemainingProjects(projectIndex);
      return true;
    };
    const checkProjectBudget = (projectIndex: number) => {
      try {
        throwIfCallerCancelled();
        budget.throwIfStopped();
        return true;
      } catch (error) {
        if (recordTimeout(error, projectIndex)) return false;
        throw error;
      }
    };
    for (
      let projectIndex = 0;
      projectIndex < plan.projects.length;
      projectIndex++
    ) {
      const project = plan.projects[projectIndex]!;
      if (!checkProjectBudget(projectIndex)) break;
      if (project.status !== 'ready') {
        projects.push({ project, status: project.status });
        continue;
      }
      try {
        const remaining = budget.remainingMs();
        const snapshot = await analyzeProject({
          ...environment,
          repositoryId: acquired.repositoryId,
          configPath: project.configPath,
          rootPaths: project.rootPaths,
          deadlineMs: remaining,
          deadlineAt: budget.deadlineAt,
          signal: budget.signal,
        });
        throwIfCallerCancelled();
        budget.throwIfStopped();
        const bytes = snapshot.execution?.ipcBytes ?? 0;
        const sourceBytes = snapshot.facts.files.reduce(
          (count, file) => count + file.byteLength,
          0,
        );
        if (
          resultBytes + bytes > PROJECT_LIMITS.maxSessionResultBytes ||
          memberships + snapshot.facts.files.length >
            PROJECT_LIMITS.maxMemberships ||
          contextSourceBytes + sourceBytes >
            PROJECT_LIMITS.maxContextSourceBytes
        )
          throw new AnalysisError(
            'RESOURCE_LIMIT',
            'Retained project results exceed the repository session limit',
          );
        resultBytes += bytes;
        memberships += snapshot.facts.files.length;
        contextSourceBytes += sourceBytes;
        projects.push({ project, status: 'ready', snapshot });
      } catch (error) {
        if (error instanceof AnalysisError && error.code === 'CANCELLED') {
          throwIfCallerCancelled();
          if (!checkProjectBudget(projectIndex)) break;
          throw error;
        }
        if (recordTimeout(error, projectIndex)) break;
        if (!checkProjectBudget(projectIndex)) break;
        projects.push({
          project,
          status: 'failed',
          error: {
            code:
              error instanceof AnalysisError ? error.code : 'ANALYSIS_FAILED',
            message:
              error instanceof AnalysisError
                ? error.message
                : 'Project analysis failed.',
          },
        });
      }
      parentPeakRssBytes = Math.max(
        parentPeakRssBytes,
        process.memoryUsage().rss,
      );
    }
    throwIfCallerCancelled();
    const analyzed = new Set<string>();
    for (const project of projects) {
      throwIfCallerCancelled();
      for (const file of project.snapshot?.facts.files ?? [])
        analyzed.add(file.path);
    }
    const diagnostics: readonly ProjectDiagnostic[] = Object.freeze([
      ...workspace.diagnostics,
    ]);
    const contextComplete =
      !deadlineExceeded &&
      plan.contextComplete &&
      !diagnostics.length &&
      projects.every((project) => {
        throwIfCallerCancelled();
        return (
          (project.status === 'ready' || project.status === 'solution') &&
          !project.snapshot?.contextDiagnostics?.length &&
          !project.snapshot?.facts.diagnostics.some((diagnostic) =>
            [
              'TS_2307',
              'TS_2688',
              'TS_6053',
              'TS_7016',
              'TS_2792',
              'TS_2591',
            ].includes(diagnostic.code),
          )
        );
      });
    const files = acquired.files.map((file) => {
      throwIfCallerCancelled();
      const owners = projects.filter((project) => {
        throwIfCallerCancelled();
        return project.project.rootPaths.includes(file.path);
      });
      const status = analyzed.has(file.path) ? 'analyzed' : 'not_analyzed';
      const reasons = owners.map((project) => {
        const label = project.project.configPath ?? 'default context';
        const diagnostic =
          project.error?.code ??
          project.project.diagnostics[0]?.code ??
          project.snapshot?.contextDiagnostics?.[0]?.code ??
          (project.snapshot
            ? 'SOURCE_NOT_EMITTED'
            : project.status.toUpperCase());
        return `${label}: ${diagnostic}`;
      });
      return Object.freeze({
        path: file.path,
        sha256: file.sha256,
        blobId: file.blobId,
        byteLength: file.bytes.length,
        status,
        ...(status === 'not_analyzed'
          ? {
              analysisReason:
                reasons.join('; ') ||
                'No compiler project claimed this source.',
            }
          : {}),
        projectIds: Object.freeze(owners.map((project) => project.project.id)),
      });
    });
    throwIfCallerCancelled();
    const session = Object.freeze({
      repositoryId: acquired.repositoryId,
      commitId: acquired.commitId,
      objectFormat: acquired.objectFormat,
      inventory: acquired.inventory,
      files: Object.freeze(files),
      projects: Object.freeze(
        projects.map((project) => {
          throwIfCallerCancelled();
          return Object.freeze(project);
        }),
      ),
      diagnostics,
      sourceCoverageComplete: files.every((file) => file.status === 'analyzed'),
      contextComplete,
      analysisComplete:
        !deadlineExceeded &&
        projects.every(
          (project) =>
            project.status === 'ready' || project.status === 'solution',
        ),
      metrics: Object.freeze({
        acquisitionMs: acquired.durationMs,
        totalMs: performance.now() - budget.startedAt,
        resultBytes,
        memberships,
        contextSourceBytes,
        parentPeakRssBytes,
        git: acquired.statistics,
      }),
    });
    throwIfCallerCancelled();
    return session;
  } catch (error) {
    if (request.signal?.aborted)
      throw new AnalysisError('CANCELLED', 'Repository analysis cancelled.');
    if (!deadlineExceeded) budget.throwIfStopped();
    throw error;
  } finally {
    clearInterval(interval);
    budget.dispose();
  }
}

type AnalyzedRepositorySession = Awaited<
  ReturnType<typeof analyzeGitRepository>
>;
export type RepositoryInvestigationSession = Omit<
  AnalyzedRepositorySession,
  'inventory'
> & {
  inventory: Omit<AnalyzedRepositorySession['inventory'], 'complete'> & {
    complete: boolean;
  };
};
