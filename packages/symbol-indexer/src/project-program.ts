import ts from 'typescript';
import { AnalysisError } from './analysis-types.js';
import type { PreparedFile } from './analysis-types.js';
import { hash } from './identity.js';
import {
  createProjectFilesystem,
  PROJECT_SOURCE_ROOT,
  PROJECT_LIBRARY_ROOT,
} from './project-filesystem.js';
import { parseProjectConfig } from './project-config.js';
import { prepareProjectEnvironment } from './project-input.js';
import { libraries } from './compiler-libraries.js';
import type { WorkerInput } from './protocol.js';

const defaultOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  moduleDetection: ts.ModuleDetectionKind.Force,
  strict: true,
  noEmit: true,
  allowJs: false,
  types: [],
  lib: ['lib.es2023.d.ts'],
};
function decode(file: PreparedFile) {
  const bytes = Buffer.from(file.base64, 'base64');
  if (bytes.length !== file.byteLength || hash(bytes) !== file.sha256)
    throw new AnalysisError('HASH_MISMATCH', 'Worker source identity mismatch');
  const text = new TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  return { path: file.path, bytes, sha256: file.sha256, text };
}

/** One compiler program per context; project source redirects never emit or read disk outputs. */
export function buildCompilerProgram(input: WorkerInput) {
  const sources = input.files.map(decode),
    metadata = input.project?.metadata.map(decode) ?? [];
  const project = input.project;
  const workspaces = project
    ? prepareProjectEnvironment({
        files: [],
        metadata,
        workspacePackages: project.workspacePackages,
      }).workspacePackages
    : [];
  const initial = createProjectFilesystem(
    [...sources, ...metadata],
    workspaces,
  );
  const configured = project?.configPath
    ? parseProjectConfig(initial, project.configPath)
    : undefined;
  if (configured && (configured.diagnostics.length || !configured.parsed))
    throw new AnalysisError(
      'INVALID_COMPILER_OPTIONS',
      'Pinned project configuration is invalid',
    );
  const options = configured?.parsed?.options ?? defaultOptions;
  const roots = project
    ? project.rootPaths.map((path) => PROJECT_SOURCE_ROOT + '/' + path)
    : sources.map((file) => PROJECT_SOURCE_ROOT + '/' + file.path);
  const pinned = libraries(options.lib ?? [ts.getDefaultLibFileName(options)]);
  const filesystem = createProjectFilesystem(
    [...sources, ...metadata],
    workspaces,
    pinned.files,
  );
  const defaultLibrary = () =>
    PROJECT_LIBRARY_ROOT + '/' + ts.getDefaultLibFileName(options);
  let program: ts.Program;
  let dispose = () => {};
  if (project) {
    const cache = new Map<string, ts.ParsedCommandLine | undefined>();
    const getParsedCommandLine = (path: string) => {
      if (!cache.has(path))
        cache.set(path, parseProjectConfig(filesystem, path).parsed);
      return cache.get(path);
    };
    // TypeScript 6.0.3 forwards this documented watch-host hook to its compiler host.
    const host: ts.LanguageServiceHost &
      Pick<
        ts.WatchCompilerHost<ts.BuilderProgram>,
        'useSourceOfProjectReferenceRedirect'
      > = {
      ...filesystem.host,
      getCompilationSettings: () => ({ ...options, noEmit: true }),
      useCaseSensitiveFileNames: () => true,
      getScriptFileNames: () => roots,
      getScriptVersion: () => '1',
      getScriptSnapshot(path) {
        const text = filesystem.host.readFile(path);
        return text === undefined
          ? undefined
          : ts.ScriptSnapshot.fromString(text);
      },
      getDefaultLibFileName: defaultLibrary,
      readDirectory: (path, extensions, excludes, includes, depth) => [
        ...filesystem.host.readDirectory(
          path,
          extensions ?? ['.ts'],
          excludes,
          includes ?? ['**/*'],
          depth,
        ),
      ],
      getProjectReferences: () =>
        configured?.parsed?.projectReferences ??
        project.referencePaths.map((path) => ({
          path: PROJECT_SOURCE_ROOT + '/' + path,
        })),
      getParsedCommandLine,
      useSourceOfProjectReferenceRedirect: () => true,
    };
    const service = ts.createLanguageService(host);
    const result = service.getProgram();
    if (!result)
      throw new AnalysisError(
        'ANALYSIS_FAILED',
        'Project compiler returned no program',
      );
    program = result;
    dispose = () => service.dispose();
  } else {
    const host: ts.CompilerHost = {
      ...filesystem.host,
      getSourceFile(path, languageVersion) {
        const text = filesystem.host.readFile(path);
        return text === undefined
          ? undefined
          : ts.createSourceFile(path, text, languageVersion, true);
      },
      getCanonicalFileName: (path) => path,
      readDirectory: (path, extensions, excludes, includes, depth) => [
        ...filesystem.host.readDirectory(
          path,
          extensions,
          excludes,
          includes,
          depth,
        ),
      ],
      useCaseSensitiveFileNames: () => true,
      getDefaultLibFileName: defaultLibrary,
      getDefaultLibLocation: () => PROJECT_LIBRARY_ROOT,
      getNewLine: () => '\n',
      writeFile: () => {
        throw new Error('Compiler emission is disabled');
      },
      resolveModuleNames(names, containingFile) {
        return names.map((name) => {
          if (!/^\.\.?\//.test(name) || name.includes('\\')) return undefined;
          const result = ts.resolveModuleName(
            name,
            containingFile,
            options,
            host,
          ).resolvedModule;
          return result &&
            result.resolvedFileName.startsWith(PROJECT_SOURCE_ROOT + '/') &&
            filesystem.files.has(result.resolvedFileName)
            ? result
            : undefined;
        });
      },
    };
    program = ts.createProgram(roots, options, host);
  }
  return { program, buildHash: pinned.buildHash, dispose };
}
