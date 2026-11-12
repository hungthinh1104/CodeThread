import { posix } from 'node:path';
import { parseDocument } from 'yaml';
import type {
  ProjectDiagnostic,
  WorkspacePackage,
} from '@codethread/symbol-indexer';
import type { PinnedInput } from '../git-source/repository-metadata.ts';

const MAX_WORKSPACE_PATTERNS = 128;
const MAX_WORKSPACE_PATH_LENGTH = 1024;
const MAX_WORKSPACE_NAME_LENGTH = 256;

/** Workspace declarations are data; package scripts and executable configuration are never loaded. */
export function repositoryWorkspaces(
  metadata: readonly PinnedInput[],
  checkpoint: () => void = () => {},
) {
  checkpoint();
  const diagnostics: ProjectDiagnostic[] = [],
    patterns: string[] = [];
  const fail = (path: string, code = 'WORKSPACE_METADATA_INVALID') =>
    diagnostics.push({
      path,
      code,
      message: 'Workspace metadata is incomplete or unsupported.',
    });
  const root = metadata.find((file) => file.path === 'package.json');
  if (root)
    try {
      const json = JSON.parse(new TextDecoder().decode(root.bytes)) as {
        workspaces?: unknown;
      };
      const workspaces = json.workspaces;
      const packages = Array.isArray(workspaces)
        ? workspaces
        : workspaces && typeof workspaces === 'object'
          ? (workspaces as { packages?: unknown }).packages
          : undefined;
      if (
        Array.isArray(packages) &&
        packages.every((item) => typeof item === 'string')
      ) {
        if (packages.length + patterns.length > MAX_WORKSPACE_PATTERNS)
          fail(root.path, 'WORKSPACE_RESOURCE_LIMIT');
        else patterns.push(...(packages as string[]));
      } else if (workspaces !== undefined) fail(root.path);
    } catch {
      fail(root.path);
    }
  checkpoint();
  const pnpm = metadata.find((file) => file.path === 'pnpm-workspace.yaml');
  if (pnpm)
    try {
      const document = parseDocument(new TextDecoder().decode(pnpm.bytes), {
        uniqueKeys: true,
      });
      if (document.errors.length || document.warnings.length)
        throw new Error('Invalid workspace YAML');
      const data = document.toJS({ maxAliasCount: 0 }) as {
        packages?: unknown;
      };
      if (
        !Array.isArray(data.packages) ||
        !data.packages.every((item) => typeof item === 'string')
      )
        throw new Error('Invalid package patterns');
      if (data.packages.length + patterns.length > MAX_WORKSPACE_PATTERNS)
        fail(pnpm.path, 'WORKSPACE_RESOURCE_LIMIT');
      else patterns.push(...(data.packages as string[]));
    } catch {
      fail(pnpm.path);
    }
  checkpoint();
  const valid = patterns.filter((pattern) => {
    checkpoint();
    if (
      !pattern ||
      pattern.length > MAX_WORKSPACE_PATH_LENGTH ||
      pattern.includes('\\') ||
      pattern.startsWith('/') ||
      ['{', '}', '[', ']'].some((character) => pattern.includes(character)) ||
      pattern.slice(1).includes('!') ||
      pattern.replace(/^!/, '').split('/').includes('..')
    ) {
      fail('package.json', 'UNSUPPORTED_WORKSPACE_PATTERN');
      return false;
    }
    return true;
  });
  const included = valid.filter((pattern) => !pattern.startsWith('!')),
    excluded = valid
      .filter((pattern) => pattern.startsWith('!'))
      .map((pattern) => pattern.slice(1));
  const candidates: WorkspacePackage[] = [];
  for (const file of metadata) {
    checkpoint();
    if (posix.basename(file.path) !== 'package.json') continue;
    const path =
      posix.dirname(file.path) === '.' ? '' : posix.dirname(file.path);
    if (
      !included.some((pattern) => posix.matchesGlob(path || '.', pattern)) ||
      excluded.some((pattern) => posix.matchesGlob(path || '.', pattern))
    )
      continue;
    try {
      const data = JSON.parse(new TextDecoder().decode(file.bytes)) as {
        name?: unknown;
      };
      if (
        typeof data.name !== 'string' ||
        data.name.length > MAX_WORKSPACE_NAME_LENGTH ||
        !/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(data.name)
      )
        throw new Error('Missing workspace name');
      candidates.push({ name: data.name, path });
    } catch {
      fail(file.path);
    }
  }
  const names = new Map<string, number>();
  for (const candidate of candidates) {
    checkpoint();
    names.set(candidate.name, (names.get(candidate.name) ?? 0) + 1);
  }
  const packages = candidates.filter((candidate) => {
    checkpoint();
    if (names.get(candidate.name) === 1) return true;
    fail(
      (candidate.path ? candidate.path + '/' : '') + 'package.json',
      'AMBIGUOUS_WORKSPACE_NAME',
    );
    return false;
  });
  checkpoint();
  return { packages, diagnostics };
}
