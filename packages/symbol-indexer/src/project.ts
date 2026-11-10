import { AnalysisError, COMPILER_PROFILE } from './analysis-types.js';
import type { ProjectAnalysisInput } from './project-types.js';
import { prepareProjectEnvironment } from './project-input.js';
import { planRepositoryProjects } from './project-plan.js';
import { analyzeInput } from './manifest.js';

export async function analyzeProject(input: ProjectAnalysisInput) {
  const started = Date.now();
  if (input.signal?.aborted)
    throw new AnalysisError('CANCELLED', 'Analysis cancelled');
  const plan = planRepositoryProjects(input);
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
  const deadlineMs = (input.deadlineMs ?? 120000) - (Date.now() - started);
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
  return Object.freeze({
    ...snapshot,
    contextDiagnostics: Object.freeze([
      ...context.diagnostics,
      ...(snapshot.contextDiagnostics ?? []),
    ]),
  });
}
