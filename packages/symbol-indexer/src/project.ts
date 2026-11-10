import { AnalysisError, COMPILER_PROFILE } from './analysis-types.js';
import { performance } from 'node:perf_hooks';
import type { ProjectAnalysisInput } from './project-types.js';
import { prepareProjectEnvironment } from './project-input.js';
import { planRepositoryProjects } from './project-plan.js';
import { analyzeInput } from './manifest.js';

export async function analyzeProject(input: ProjectAnalysisInput) {
  const started = performance.now(),
    requestedDeadline = input.deadlineMs ?? 120000;
  if (!Number.isFinite(requestedDeadline) || requestedDeadline < 1)
    throw new AnalysisError('INVALID_MANIFEST', 'Invalid project deadline');
  if (input.deadlineAt !== undefined && !Number.isFinite(input.deadlineAt))
    throw new AnalysisError('INVALID_MANIFEST', 'Invalid project deadline');
  const requestedDeadlineAt = started + requestedDeadline,
    deadlineAt =
      input.deadlineAt === undefined
        ? requestedDeadlineAt
        : Math.min(input.deadlineAt, requestedDeadlineAt);
  const checkDeadline = () => {
    if (!Number.isFinite(deadlineAt))
      throw new AnalysisError('INVALID_MANIFEST', 'Invalid project deadline');
    if (performance.now() >= deadlineAt)
      throw new AnalysisError(
        'ANALYSIS_TIMEOUT',
        'Project analysis deadline exceeded',
      );
    if (input.signal?.aborted)
      throw new AnalysisError('CANCELLED', 'Analysis cancelled');
  };
  checkDeadline();
  const plan = planRepositoryProjects({ ...input, deadlineAt });
  checkDeadline();
  const context = plan.projects.find(
    (project) => project.configPath === input.configPath,
  );
  if (!context || context.status !== 'ready')
    throw new AnalysisError(
      'INVALID_COMPILER_OPTIONS',
      'Project context is unavailable or invalid',
    );
  if (
    input.rootPaths &&
    JSON.stringify([...input.rootPaths].sort()) !==
      JSON.stringify([...context.rootPaths].sort())
  )
    throw new AnalysisError(
      'INVALID_MANIFEST',
      'Project roots differ from the pinned configuration',
    );
  const prepared = prepareProjectEnvironment(input);
  checkDeadline();
  const deadlineMs = Math.floor(deadlineAt - performance.now());
  if (deadlineMs < 1)
    throw new AnalysisError(
      'ANALYSIS_TIMEOUT',
      'Project analysis deadline exceeded',
    );
  const snapshot = await analyzeInput(
    {
      repositoryId: input.repositoryId,
      compilerOptions: COMPILER_PROFILE,
      files: prepared.files,
      resourceProfile: 'repository',
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      deadlineMs,
      ...(input.heapLimitMiB === undefined
        ? {}
        : { heapLimitMiB: input.heapLimitMiB }),
    },
    {
      configPath: context.configPath,
      rootPaths: [...context.rootPaths],
      referencePaths: [...context.referencePaths],
      workspacePackages: prepared.workspacePackages,
      metadata: prepared.metadata.map((file) => ({
        path: file.path,
        byteLength: file.bytes.length,
        sha256: file.sha256,
        base64: Buffer.from(file.bytes).toString('base64'),
      })),
    },
  );
  checkDeadline();
  return Object.freeze({
    ...snapshot,
    contextDiagnostics: Object.freeze([
      ...context.diagnostics,
      ...(snapshot.contextDiagnostics ?? []),
    ]),
  });
}
