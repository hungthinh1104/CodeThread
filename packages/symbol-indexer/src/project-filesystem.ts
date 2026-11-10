import { posix } from 'node:path';
import ts from 'typescript';
import type { WorkspacePackage } from './project-types.js';

export const PROJECT_SOURCE_ROOT = '/__codethread__/source';
export const PROJECT_LIBRARY_ROOT = '/__codethread__/lib';

/** A data-only host. No fallback to the machine filesystem or installed dependencies. */
export function createProjectFilesystem(
  inputs: readonly { path: string; text: string }[],
  workspacePackages: readonly WorkspacePackage[],
  libraries: ReadonlyMap<string, string> = new Map(),
) {
  const files = new Map(
    inputs.map((file) => [PROJECT_SOURCE_ROOT + '/' + file.path, file.text]),
  );
  for (const [path, text] of libraries) files.set(path, text);
  const aliases = workspacePackages.map((workspace) => ({
    alias: PROJECT_SOURCE_ROOT + '/node_modules/' + workspace.name,
    target: PROJECT_SOURCE_ROOT + (workspace.path ? '/' + workspace.path : ''),
  }));
  const canonical = (input: string): string => {
    const path = posix.resolve(
      PROJECT_SOURCE_ROOT,
      input.replaceAll('\\', '/'),
    );
    const alias = aliases.find(
      (item) => path === item.alias || path.startsWith(item.alias + '/'),
    );
    return alias ? alias.target + path.slice(alias.alias.length) : path;
  };
  const directories = new Set<string>();
  for (const path of [
    ...files.keys(),
    ...aliases.map((item) => item.alias + '/package.json'),
  ]) {
    let directory = posix.dirname(path);
    while (directory !== '/') {
      directories.add(directory);
      directory = posix.dirname(directory);
    }
  }
  const patternMatches = (
    file: string,
    root: string,
    pattern: string,
  ): boolean => {
    const absolute = posix.resolve(root, pattern.replaceAll('\\', '/'));
    const glob =
      !/[?*]/.test(absolute) && !posix.extname(absolute)
        ? absolute.replace(/\/$/, '') + '/**/*'
        : absolute;
    return posix.matchesGlob(file, glob);
  };
  const host: ts.ParseConfigFileHost = {
    useCaseSensitiveFileNames: true,
    getCurrentDirectory: () => PROJECT_SOURCE_ROOT,
    fileExists: (path) => files.has(canonical(path)),
    readFile: (path) => files.get(canonical(path)),
    directoryExists: (path) =>
      directories.has(canonical(path)) || directories.has(path),
    getDirectories: (path) =>
      [...directories].filter(
        (directory) => posix.dirname(directory) === canonical(path),
      ),
    realpath: canonical,
    readDirectory(rootDir, extensions, excludes, includes, depth) {
      const root = canonical(rootDir);
      return [...files.keys()]
        .filter(
          (path) =>
            path.startsWith(root + '/') &&
            (extensions === undefined ||
              extensions.some((extension) => path.endsWith(extension))) &&
            (depth === undefined ||
              path.slice(root.length + 1).split('/').length <= depth + 1) &&
            (includes ?? ['**/*']).some((pattern) =>
              patternMatches(path, root, pattern),
            ) &&
            !(excludes ?? []).some((pattern) =>
              patternMatches(path, root, pattern),
            ),
        )
        .sort();
    },
    onUnRecoverableConfigFileDiagnostic() {},
  };
  return { files, canonical, host };
}

export type ProjectFilesystem = ReturnType<typeof createProjectFilesystem>;
