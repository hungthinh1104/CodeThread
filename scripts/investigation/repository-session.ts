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
) {
  const limits = analysisResourceLimits('repository'),
    budget = createSessionBudget(request.signal, limits.maxDeadlineMs);
  let parentPeakRssBytes = process.memoryUsage().rss;
  const interval = setInterval(() => {
    parentPeakRssBytes = Math.max(
      parentPeakRssBytes,
      process.memoryUsage().rss,
    );
  }, 100);
  try {
    budget.throwIfStopped();
    const acquired = await acquireGitRepository(
      { ...request, signal: budget.signal },
      budget.throwIfStopped,
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
    for (const project of plan.projects) {
      budget.throwIfStopped();
      if (project.status !== 'ready') {
        projects.push({ project, status: project.status });
        continue;
      }
      const remaining = budget.remainingMs();
      try {
        const snapshot = await analyzeProject({
          ...environment,
          repositoryId: acquired.repositoryId,
          configPath: project.configPath,
          rootPaths: project.rootPaths,
          deadlineMs: remaining,
          deadlineAt: budget.deadlineAt,
          signal: budget.signal,
        });
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
        if (
          error instanceof AnalysisError &&
          ['CANCELLED', 'ANALYSIS_TIMEOUT'].includes(error.code)
        ) {
          budget.throwIfStopped();
          throw error;
        }
        budget.throwIfStopped();
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
    budget.throwIfStopped();
    const analyzed = new Set<string>();
    for (const project of projects) {
      budget.throwIfStopped();
      for (const file of project.snapshot?.facts.files ?? [])
        analyzed.add(file.path);
    }
    const diagnostics: readonly ProjectDiagnostic[] = Object.freeze([
      ...workspace.diagnostics,
    ]);
    const contextComplete =
      plan.contextComplete &&
      !diagnostics.length &&
      projects.every((project) => {
        budget.throwIfStopped();
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
      budget.throwIfStopped();
      const owners = projects.filter((project) => {
        budget.throwIfStopped();
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
    budget.throwIfStopped();
    const session = Object.freeze({
      repositoryId: acquired.repositoryId,
      commitId: acquired.commitId,
      objectFormat: acquired.objectFormat,
      inventory: acquired.inventory,
      files: Object.freeze(files),
      projects: Object.freeze(
        projects.map((project) => {
          budget.throwIfStopped();
          return Object.freeze(project);
        }),
      ),
      diagnostics,
      sourceCoverageComplete: files.every((file) => file.status === 'analyzed'),
      contextComplete,
      analysisComplete: projects.every(
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
    budget.throwIfStopped();
    return session;
  } catch (error) {
    budget.throwIfStopped();
    throw error;
  } finally {
    clearInterval(interval);
    budget.dispose();
  }
}

export type RepositoryInvestigationSession = Awaited<
  ReturnType<typeof analyzeGitRepository>
>;
