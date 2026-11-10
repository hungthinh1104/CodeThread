import { posix } from 'node:path';
import ts from 'typescript';
import type { ProjectFilesystem } from './project-filesystem.js';
import { PROJECT_SOURCE_ROOT } from './project-filesystem.js';
import type { ProjectDiagnostic } from './analysis-types.js';

const MAX_EXTENSIONS = 32;
const MAX_REFERENCES = 32;
const MAX_SOURCE_PATHS = 1000;
const MAX_GLOBS = 128;
const MAX_OPTION_ENTRIES = 128;
const MAX_CONFIG_PATH_LENGTH = 1024;
const MAX_OPTION_NAME_LENGTH = 256;

export function projectConfigPath(input: string): string {
  const absolute = posix.resolve(PROJECT_SOURCE_ROOT, input);
  return absolute.endsWith('.json') ? absolute : absolute + '/tsconfig.json';
}

export function parseProjectConfig(
  filesystem: ProjectFilesystem,
  path: string,
) {
  const diagnostics: ProjectDiagnostic[] = [];
  const absolute = projectConfigPath(path);
  if (!absolute.startsWith(PROJECT_SOURCE_ROOT + '/')) {
    diagnostics.push({
      code: 'PROJECT_PATH_ESCAPE',
      message: 'Configuration escapes the pinned repository.',
      path,
    });
    return { parsed: undefined, diagnostics };
  }
  const configPath = absolute.slice(PROJECT_SOURCE_ROOT.length + 1);
  const text = filesystem.host.readFile(absolute);
  if (text === undefined) {
    diagnostics.push({
      code: 'PROJECT_CONFIG_MISSING',
      message: 'Pinned project configuration is unavailable.',
      path: configPath,
    });
    return { parsed: undefined, diagnostics };
  }
  const onDiagnostic = (diagnostic: ts.Diagnostic) =>
    diagnostics.push({
      code: `TS_${diagnostic.code}`,
      message: `TypeScript configuration diagnostic ${diagnostic.code}.`,
      path: configPath,
    });
  const json = ts.parseConfigFileTextToJson(absolute, text);
  if (json.error) {
    onDiagnostic(json.error);
    return { parsed: undefined, diagnostics };
  }
  const raw = json.config as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    diagnostics.push({
      code: 'INVALID_PROJECT_CONFIG',
      message: 'Project configuration must be a JSON object.',
      path: configPath,
    });
    return { parsed: undefined, diagnostics };
  }
  let unsafe = false;
  const reject = (code: string, message: string) => {
    unsafe = true;
    diagnostics.push({ code, message, path: configPath });
  };
  const checkStrings = (
    value: unknown,
    name: string,
    maximum: number,
    maxLength: number,
  ) => {
    if (value === undefined) return;
    if (!Array.isArray(value)) {
      reject(
        'INVALID_PROJECT_CONFIG',
        `${name} must be a bounded string list.`,
      );
      return;
    }
    if (value.length > maximum) {
      reject(
        'PROJECT_CONFIG_LIMIT',
        `${name} exceeds its configured item limit.`,
      );
    }
    for (const item of value.slice(0, maximum))
      if (typeof item !== 'string' || item.length > maxLength)
        reject(
          'PROJECT_CONFIG_LIMIT',
          `${name} contains a non-string or oversized value.`,
        );
  };
  const extensions =
    typeof raw.extends === 'string'
      ? [raw.extends]
      : Array.isArray(raw.extends)
        ? raw.extends
        : raw.extends === undefined
          ? []
          : null;
  if (!extensions)
    reject('INVALID_PROJECT_CONFIG', 'extends must contain relative paths.');
  else {
    if (extensions.length > MAX_EXTENSIONS)
      reject('PROJECT_CONFIG_LIMIT', 'extends exceeds 32 entries.');
    for (const extension of extensions.slice(0, MAX_EXTENSIONS)) {
      if (
        typeof extension !== 'string' ||
        extension.length > MAX_CONFIG_PATH_LENGTH ||
        !/^\.\.?\//.test(extension)
      ) {
        reject(
          'EXTERNAL_CONFIG_UNAVAILABLE',
          'Only pinned relative configuration extensions are supported.',
        );
      } else if (
        !posix
          .resolve(posix.dirname(absolute), extension)
          .startsWith(PROJECT_SOURCE_ROOT + '/')
      ) {
        reject(
          'PROJECT_PATH_ESCAPE',
          'Configuration escapes the pinned repository.',
        );
      }
    }
  }
  checkStrings(raw.files, 'files', MAX_SOURCE_PATHS, MAX_CONFIG_PATH_LENGTH);
  for (const key of ['include', 'exclude'] as const) {
    const patterns = raw[key];
    checkStrings(patterns, key, MAX_GLOBS, MAX_CONFIG_PATH_LENGTH);
    if (Array.isArray(patterns))
      for (const pattern of patterns.slice(0, MAX_GLOBS))
        if (
          typeof pattern === 'string' &&
          (pattern.includes('\\') ||
            pattern.startsWith('/') ||
            pattern.split('/').includes('..') ||
            ['!', '{', '}', '[', ']'].some((character) =>
              pattern.includes(character),
            ))
        )
          reject(
            'UNSUPPORTED_CONFIG_PATTERN',
            'A project glob is outside the supported configuration patterns.',
          );
  }
  if (raw.references !== undefined) {
    if (!Array.isArray(raw.references))
      reject('INVALID_PROJECT_CONFIG', 'references must be an array.');
    else {
      if (raw.references.length > MAX_REFERENCES)
        reject('PROJECT_CONFIG_LIMIT', 'references exceeds 32 entries.');
      for (const item of raw.references.slice(0, MAX_REFERENCES)) {
        const reference = item as { path?: unknown } | null;
        if (
          !reference ||
          typeof reference.path !== 'string' ||
          reference.path.length > MAX_CONFIG_PATH_LENGTH ||
          reference.path.includes('\\')
        ) {
          reject(
            'INVALID_PROJECT_CONFIG',
            'A project reference has an invalid path.',
          );
          continue;
        }
        if (
          !posix
            .resolve(posix.dirname(absolute), reference.path)
            .startsWith(PROJECT_SOURCE_ROOT + '/')
        )
          reject(
            'PROJECT_PATH_ESCAPE',
            'A project reference escapes the pinned repository.',
          );
      }
    }
  }
  const compilerOptions = raw.compilerOptions;
  if (
    compilerOptions !== undefined &&
    (!compilerOptions ||
      typeof compilerOptions !== 'object' ||
      Array.isArray(compilerOptions))
  )
    reject('INVALID_PROJECT_CONFIG', 'compilerOptions must be an object.');
  if (
    compilerOptions &&
    typeof compilerOptions === 'object' &&
    !Array.isArray(compilerOptions)
  ) {
    const options = compilerOptions as Record<string, unknown>;
    for (const key of ['types', 'lib', 'typeRoots'] as const)
      checkStrings(options[key], `compilerOptions.${key}`, MAX_GLOBS, 256);
    for (const key of ['rootDirs'] as const)
      checkStrings(
        options[key],
        `compilerOptions.${key}`,
        MAX_GLOBS,
        MAX_CONFIG_PATH_LENGTH,
      );
    const paths = options.paths;
    if (paths !== undefined) {
      if (!paths || typeof paths !== 'object' || Array.isArray(paths))
        reject(
          'INVALID_PROJECT_CONFIG',
          'compilerOptions.paths must be an object.',
        );
      else {
        const entries = Object.entries(paths);
        if (entries.length > MAX_OPTION_ENTRIES)
          reject(
            'PROJECT_CONFIG_LIMIT',
            'compilerOptions.paths exceeds 128 entries.',
          );
        for (const [name, targets] of entries.slice(0, MAX_OPTION_ENTRIES)) {
          if (name.length > MAX_OPTION_NAME_LENGTH)
            reject('PROJECT_CONFIG_LIMIT', 'A compiler path key is oversized.');
          checkStrings(
            targets,
            `compilerOptions.paths.${name}`,
            MAX_GLOBS,
            MAX_CONFIG_PATH_LENGTH,
          );
        }
      }
    }
  }
  if (unsafe) return { parsed: undefined, diagnostics };
  const parsed = ts.getParsedCommandLineOfConfigFile(
    absolute,
    {},
    {
      ...filesystem.host,
      onUnRecoverableConfigFileDiagnostic: onDiagnostic,
    },
  );
  for (const diagnostic of parsed?.errors ?? []) onDiagnostic(diagnostic);
  for (const file of parsed?.fileNames ?? []) {
    if (!file.startsWith(PROJECT_SOURCE_ROOT + '/'))
      diagnostics.push({
        code: 'PROJECT_PATH_ESCAPE',
        message: 'A project source escapes the pinned repository.',
        path: configPath,
      });
    else if (!filesystem.host.fileExists(file))
      diagnostics.push({
        code: 'PROJECT_SOURCE_MISSING',
        message: 'An explicitly configured source is unavailable.',
        path: configPath,
      });
  }
  for (const reference of parsed?.projectReferences ?? []) {
    if (!reference.path.startsWith(PROJECT_SOURCE_ROOT + '/'))
      diagnostics.push({
        code: 'PROJECT_PATH_ESCAPE',
        message: 'A project reference escapes the pinned repository.',
        path: configPath,
      });
    else if (!filesystem.host.fileExists(projectConfigPath(reference.path)))
      diagnostics.push({
        code: 'PROJECT_REFERENCE_MISSING',
        message: 'A referenced pinned project is unavailable.',
        path: configPath,
      });
  }
  return { parsed, diagnostics };
}
