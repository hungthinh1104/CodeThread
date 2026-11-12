import type {
  AnalysisInput,
  PreparedFile,
  ProjectDiagnostic,
} from './analysis-types.js';

export type ProjectFile = AnalysisInput['files'][number];
export interface WorkspacePackage {
  name: string;
  path: string;
}
export interface ProjectEnvironment {
  files: readonly ProjectFile[];
  metadata: readonly ProjectFile[];
  workspacePackages: readonly WorkspacePackage[];
  /** Absolute monotonic deadline shared by repository planning and analysis. */
  deadlineAt?: number;
  signal?: AbortSignal;
}
export interface RepositoryProject {
  id: string;
  configPath: string | null;
  rootPaths: readonly string[];
  referencePaths: readonly string[];
  status: 'ready' | 'invalid' | 'solution';
  diagnostics: readonly ProjectDiagnostic[];
}
export interface RepositoryProjectPlan {
  projects: readonly RepositoryProject[];
  sourceFiles: number;
  sourceBytes: number;
  assignedFiles: number;
  inferredFiles: number;
  contextComplete: boolean;
}
export interface ProjectAnalysisInput extends ProjectEnvironment {
  repositoryId: string;
  configPath: string | null;
  /** Explicit roots for the disclosed inferred context; configured projects use tsconfig. */
  rootPaths?: readonly string[];
  deadlineMs?: number;
  heapLimitMiB?: number;
}
export interface ProjectWorkerContext {
  configPath: string | null;
  rootPaths: string[];
  referencePaths: string[];
  metadata: PreparedFile[];
  workspacePackages: WorkspacePackage[];
}

export const PROJECT_LIMITS = Object.freeze({
  maxProjects: 32,
  maxMemberships: 4000,
  maxMetadataFiles: 256,
  maxMetadataBytes: 4 * 1024 * 1024,
  maxContextSourceBytes: 128 * 1024 * 1024,
  maxSessionResultBytes: 384 * 1024 * 1024,
});
