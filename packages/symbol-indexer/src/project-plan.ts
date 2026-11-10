import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import ts from 'typescript';
import { AnalysisError } from './analysis-types.js';
import {
  createProjectFilesystem,
  PROJECT_SOURCE_ROOT,
} from './project-filesystem.js';
import { prepareProjectEnvironment, projectOrder } from './project-input.js';
import { parseProjectConfig, projectConfigPath } from './project-config.js';
import { PROJECT_LIMITS } from './project-types.js';
import type {
  ProjectEnvironment,
  RepositoryProject,
  RepositoryProjectPlan,
} from './project-types.js';

export function planRepositoryProjects(
  input: ProjectEnvironment,
): RepositoryProjectPlan {
  const checkpoint = () => {
    if (input.deadlineAt !== undefined) {
      if (!Number.isFinite(input.deadlineAt))
        throw new AnalysisError('INVALID_MANIFEST', 'Invalid project deadline');
      if (performance.now() >= input.deadlineAt)
        throw new AnalysisError(
          'ANALYSIS_TIMEOUT',
          'Project planning deadline exceeded',
        );
    }
    if (input.signal?.aborted)
      throw new AnalysisError('CANCELLED', 'Project planning cancelled');
  };
  checkpoint();
  const prepared = prepareProjectEnvironment(input);
  checkpoint();
  const filesystem = createProjectFilesystem(
    [...prepared.files, ...prepared.metadata],
    prepared.workspacePackages,
  );
  const prefix = PROJECT_SOURCE_ROOT + '/';
  const configPaths = prepared.metadata
    .filter((file) => /(?:^|\/)tsconfig(?:\.[^/]*)?\.json$/.test(file.path))
    .map((file) => file.path);
  const parents = new Set<string>(),
    referenced = new Set<string>();
  for (const configPath of configPaths) {
    checkpoint();
    const file = prepared.metadata.find(
      (candidate) => candidate.path === configPath,
    );
    if (!file) continue;
    const raw = ts.parseConfigFileTextToJson(file.path, file.text).config as
      Record<string, unknown> | undefined;
    if (!raw || typeof raw !== 'object') continue;
    const extensions =
      typeof raw.extends === 'string'
        ? [raw.extends]
        : Array.isArray(raw.extends)
          ? raw.extends
          : [];
    for (const extension of extensions) {
      checkpoint();
      if (typeof extension === 'string' && /^\.\.?\//.test(extension)) {
        const path = posix.resolve(prefix, posix.dirname(file.path), extension);
        if (path.startsWith(prefix))
          parents.add(
            (path.endsWith('.json') ? path : path + '.json').slice(
              prefix.length,
            ),
          );
      }
    }
    checkpoint();
    if (Array.isArray(raw.references))
      for (const reference of raw.references) {
        checkpoint();
        const path = (reference as { path?: unknown })?.path;
        if (typeof path === 'string') {
          const resolved = posix.resolve(
            prefix,
            posix.dirname(file.path),
            path,
          );
          if (resolved.startsWith(prefix))
            referenced.add(projectConfigPath(resolved).slice(prefix.length));
        }
      }
  }
  checkpoint();
  for (const path of referenced) {
    checkpoint();
    if (!configPaths.includes(path)) configPaths.push(path);
  }
  const metadataIdentity = prepared.metadata.map(({ path, sha256 }) => [
    path,
    sha256,
  ]);
  const projectId = (configPath: string | null, roots: readonly string[]) =>
    'project:' +
    createHash('sha256')
      .update(
        JSON.stringify([
          configPath,
          roots,
          metadataIdentity,
          prepared.workspacePackages,
        ]),
      )
      .digest('hex')
      .slice(0, 24);
  const sourcePaths = new Set(prepared.files.map((file) => file.path));
  const projects: RepositoryProject[] = [];
  for (const configPath of configPaths.sort(projectOrder)) {
    checkpoint();
    if (
      parents.has(configPath) &&
      !referenced.has(configPath) &&
      posix.basename(configPath) !== 'tsconfig.json'
    )
      continue;
    const { parsed, diagnostics } = parseProjectConfig(filesystem, configPath);
    checkpoint();
    const rootPaths = [
      ...new Set(
        (parsed?.fileNames ?? [])
          .map((path) => path.slice(prefix.length))
          .filter((path) => sourcePaths.has(path)),
      ),
    ].sort(projectOrder);
    const referencePaths = (parsed?.projectReferences ?? [])
      .map((reference) =>
        projectConfigPath(reference.path).slice(prefix.length),
      )
      .sort(projectOrder);
    projects.push({
      id: projectId(configPath, rootPaths),
      configPath,
      rootPaths,
      referencePaths,
      status:
        diagnostics.length || !parsed
          ? 'invalid'
          : rootPaths.length
            ? 'ready'
            : 'solution',
      diagnostics,
    });
  }
  markReferenceCycles(projects, checkpoint);
  checkpoint();
  const assigned = new Set(
    projects
      .filter((project) => project.status !== 'invalid')
      .flatMap((project) => [...project.rootPaths]),
  );
  const inferred: string[] = [];
  for (const file of prepared.files) {
    checkpoint();
    if (!assigned.has(file.path)) inferred.push(file.path);
  }
  if (inferred.length)
    projects.push({
      id: projectId(null, inferred),
      configPath: null,
      rootPaths: inferred,
      referencePaths: projects
        .filter(
          (project) =>
            project.status === 'ready' && project.configPath !== null,
        )
        .map((project) => project.configPath!),
      status: 'ready',
      diagnostics: [
        {
          code: 'INFERRED_PROJECT_CONTEXT',
          message: 'These sources use the disclosed default compiler context.',
        },
      ],
    });
  if (
    projects.length > PROJECT_LIMITS.maxProjects ||
    projects.reduce((count, project) => count + project.rootPaths.length, 0) >
      PROJECT_LIMITS.maxMemberships
  )
    throw new AnalysisError(
      'RESOURCE_LIMIT',
      'Repository project contexts exceed the declared limit',
    );
  checkpoint();
  let sourceBytes = 0;
  for (const file of prepared.files) {
    checkpoint();
    sourceBytes += file.bytes.length;
  }
  return Object.freeze({
    projects: Object.freeze(
      projects.map((project) => {
        checkpoint();
        return Object.freeze({
          ...project,
          rootPaths: Object.freeze([...project.rootPaths]),
          referencePaths: Object.freeze([...project.referencePaths]),
          diagnostics: Object.freeze(
            project.diagnostics.map((diagnostic) => Object.freeze(diagnostic)),
          ),
        });
      }),
    ),
    sourceFiles: prepared.files.length,
    sourceBytes,
    assignedFiles: assigned.size,
    inferredFiles: inferred.length,
    contextComplete:
      !projects.some((project) => project.status === 'invalid') &&
      inferred.length === 0,
  });
}

function markReferenceCycles(
  projects: RepositoryProject[],
  checkpoint: () => void,
): void {
  const byPath = new Map(
    projects
      .filter((project) => project.configPath !== null)
      .map((project) => [project.configPath!, project]),
  );
  const completed = new Set<string>(),
    active: string[] = [];
  const visit = (path: string): void => {
    checkpoint();
    const cycle = active.indexOf(path);
    if (cycle >= 0) {
      for (const member of active.slice(cycle)) {
        const project = byPath.get(member)!;
        project.status = 'invalid';
        project.diagnostics = [
          ...project.diagnostics,
          {
            code: 'PROJECT_REFERENCE_CYCLE',
            message: 'Project references contain a cycle.',
            path: member,
          },
        ];
      }
      return;
    }
    if (completed.has(path)) return;
    const project = byPath.get(path);
    if (!project) return;
    active.push(path);
    for (const reference of project.referencePaths) visit(reference);
    active.pop();
    completed.add(path);
  };
  for (const path of byPath.keys()) {
    checkpoint();
    visit(path);
  }
}
