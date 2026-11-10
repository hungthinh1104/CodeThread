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
  const started = performance.now(),
    limits = analysisResourceLimits('repository');
  let parentPeakRssBytes = process.memoryUsage().rss;
  const interval = setInterval(() => {
    parentPeakRssBytes = Math.max(
      parentPeakRssBytes,
      process.memoryUsage().rss,
    );
  }, 100);
  let acquired: Awaited<ReturnType<typeof acquireGitRepository>>;
  let workspace: ReturnType<typeof repositoryWorkspaces>;
  let plan: ReturnType<typeof planRepositoryProjects>;
  let environment: Parameters<typeof planRepositoryProjects>[0];
  try {
    acquired = await acquireGitRepository(request);
    workspace = repositoryWorkspaces(acquired.metadata);
    environment = {
      files: acquired.files,
      metadata: acquired.metadata,
      workspacePackages: workspace.packages,
    };
    plan = planRepositoryProjects(environment);
  } catch (error) {
    clearInterval(interval);
    throw error;
  }
  const projects: RepositoryProjectState[] = [];
  let resultBytes = 0,
    memberships = 0,
    contextSourceBytes = 0;
  try {
    for (const project of plan.projects) {
      if (request.signal?.aborted)
        throw new AnalysisError('CANCELLED', 'Repository analysis cancelled');
      if (project.status !== 'ready') {
        projects.push({ project, status: project.status });
        continue;
      }
      const remaining = Math.floor(
        limits.maxDeadlineMs - (performance.now() - started),
      );
      if (remaining < 1) {
        projects.push({
          project,
          status: 'not_analyzed',
          error: {
            code: 'ANALYSIS_TIMEOUT',
            message: 'Repository analysis deadline exceeded.',
          },
        });
        continue;
      }
      try {
        const snapshot = await analyzeProject({
          ...environment,
          repositoryId: acquired.repositoryId,
          configPath: project.configPath,
          rootPaths: project.rootPaths,
          deadlineMs: remaining,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
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
        if (error instanceof AnalysisError && error.code === 'CANCELLED')
          throw error;
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
  } finally {
    clearInterval(interval);
  }
  const analyzed = new Set(
    projects.flatMap(
      (project) => project.snapshot?.facts.files.map((file) => file.path) ?? [],
    ),
  );
  const diagnostics: readonly ProjectDiagnostic[] = Object.freeze([
    ...workspace.diagnostics,
  ]);
  const contextComplete =
    plan.contextComplete &&
    !diagnostics.length &&
    projects.every(
      (project) =>
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
        ),
    );
  const files = acquired.files.map((file) => {
    const owners = projects.filter((project) =>
      project.project.rootPaths.includes(file.path),
    );
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
              reasons.join('; ') || 'No compiler project claimed this source.',
          }
        : {}),
      projectIds: Object.freeze(owners.map((project) => project.project.id)),
    });
  });
  return Object.freeze({
    repositoryId: acquired.repositoryId,
    commitId: acquired.commitId,
    objectFormat: acquired.objectFormat,
    inventory: acquired.inventory,
    files: Object.freeze(files),
    projects: Object.freeze(projects.map((project) => Object.freeze(project))),
    diagnostics,
    sourceCoverageComplete: files.every((file) => file.status === 'analyzed'),
    contextComplete,
    analysisComplete: projects.every(
      (project) => project.status === 'ready' || project.status === 'solution',
    ),
    metrics: Object.freeze({
      acquisitionMs: acquired.durationMs,
      totalMs: performance.now() - started,
      resultBytes,
      memberships,
      contextSourceBytes,
      parentPeakRssBytes,
      git: acquired.statistics,
    }),
  });
}

export type RepositoryInvestigationSession = Awaited<
  ReturnType<typeof analyzeGitRepository>
>;
