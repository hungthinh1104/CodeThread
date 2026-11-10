import { createHash } from 'node:crypto';
import { analysisResourceLimits, isSnapshotPath } from '@codethread/code-model';
import { AnalysisError } from './analysis-types.js';
import type {
  ProjectEnvironment,
  ProjectFile,
  WorkspacePackage,
} from './project-types.js';
import { PROJECT_LIMITS } from './project-types.js';

export const projectOrder = (a: string, b: string) =>
  Buffer.compare(Buffer.from(a), Buffer.from(b));

function verifiedFiles(files: readonly ProjectFile[], metadata: boolean) {
  if (!Array.isArray(files))
    throw new AnalysisError('INVALID_MANIFEST', 'Missing project inputs');
  const limits = analysisResourceLimits('repository');
  if (
    files.length >
    (metadata ? PROJECT_LIMITS.maxMetadataFiles : limits.maxFiles)
  )
    throw new AnalysisError('RESOURCE_LIMIT', 'Too many project inputs');
  const seen = new Set<string>();
  let total = 0;
  return files
    .map((file) => {
      if (
        !file ||
        typeof file.path !== 'string' ||
        !isSnapshotPath(file.path) ||
        new TextDecoder().decode(new TextEncoder().encode(file.path)) !==
          file.path ||
        (!metadata && !file.path.endsWith('.ts')) ||
        !(file.bytes instanceof Uint8Array) ||
        seen.has(file.path.toLowerCase())
      )
        throw new AnalysisError(
          'INVALID_MANIFEST',
          'Unsafe or conflicting project input',
        );
      seen.add(file.path.toLowerCase());
      const bytes = Uint8Array.from(file.bytes);
      total += bytes.length;
      if (
        bytes.length > limits.maxFileBytes ||
        total >
          (metadata ? PROJECT_LIMITS.maxMetadataBytes : limits.maxTotalBytes)
      )
        throw new AnalysisError(
          'RESOURCE_LIMIT',
          'Project input exceeds its byte limit',
        );
      if (createHash('sha256').update(bytes).digest('hex') !== file.sha256)
        throw new AnalysisError(
          'HASH_MISMATCH',
          'Project input hash mismatch',
          file.path,
        );
      let text: string;
      try {
        text = new TextDecoder('utf-8', {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes);
      } catch {
        throw new AnalysisError(
          'INVALID_ENCODING',
          'Invalid project input encoding',
          file.path,
        );
      }
      return { path: file.path, bytes, sha256: file.sha256, text };
    })
    .sort((a, b) => projectOrder(a.path, b.path));
}

export function prepareProjectEnvironment(input: ProjectEnvironment) {
  const files = verifiedFiles(input.files, false),
    metadata = verifiedFiles(input.metadata, true);
  const allPaths = new Set(files.map((file) => file.path.toLowerCase()));
  if (metadata.some((file) => allPaths.has(file.path.toLowerCase())))
    throw new AnalysisError(
      'INVALID_MANIFEST',
      'Metadata overlaps source inputs',
    );
  if (
    !Array.isArray(input.workspacePackages) ||
    input.workspacePackages.length > PROJECT_LIMITS.maxMetadataFiles
  )
    throw new AnalysisError('INVALID_MANIFEST', 'Invalid workspace mappings');
  const names = new Set<string>();
  const workspacePackages = input.workspacePackages
    .map((workspace: WorkspacePackage) => {
      if (
        !workspace ||
        typeof workspace.name !== 'string' ||
        !/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(workspace.name) ||
        workspace.name
          .split('/')
          .some((part) => part === '.' || part === '..') ||
        typeof workspace.path !== 'string' ||
        (workspace.path !== '' && !isSnapshotPath(workspace.path)) ||
        names.has(workspace.name)
      )
        throw new AnalysisError(
          'INVALID_MANIFEST',
          'Unsafe or ambiguous workspace mapping',
        );
      const packagePath =
        (workspace.path ? workspace.path + '/' : '') + 'package.json';
      const packageFile = metadata.find((file) => file.path === packagePath);
      try {
        if (
          !packageFile ||
          (JSON.parse(packageFile.text) as { name?: unknown }).name !==
            workspace.name
        )
          throw new Error('Missing package proof');
      } catch {
        throw new AnalysisError(
          'INVALID_MANIFEST',
          'Workspace mapping lacks package metadata',
        );
      }
      names.add(workspace.name);
      return { name: workspace.name, path: workspace.path };
    })
    .sort((a, b) => projectOrder(a.name, b.name));
  return { files, metadata, workspacePackages };
}
