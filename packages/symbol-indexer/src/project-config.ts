import { posix } from 'node:path';
import ts from 'typescript';
import { PROJECT_SOURCE_ROOT } from './project-filesystem.js';
import type { ProjectFilesystem } from './project-filesystem.js';
import type { ProjectDiagnostic } from './analysis-types.js';

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
  const json = ts.parseConfigFileTextToJson(absolute, text);
  const raw = json.config as Record<string, unknown> | undefined;
  if (raw && typeof raw === 'object') {
    const extensions =
      typeof raw.extends === 'string'
        ? [raw.extends]
        : Array.isArray(raw.extends)
          ? raw.extends
          : [];
    for (const extension of extensions) {
      if (typeof extension !== 'string' || !/^\.\.?\//.test(extension))
        diagnostics.push({
          code: 'EXTERNAL_CONFIG_UNAVAILABLE',
          message:
            'Only pinned relative configuration extensions are supported.',
          path: configPath,
        });
      else if (
        !posix
          .resolve(posix.dirname(absolute), extension)
          .startsWith(PROJECT_SOURCE_ROOT + '/')
      )
        diagnostics.push({
          code: 'PROJECT_PATH_ESCAPE',
          message: 'Configuration escapes the pinned repository.',
          path: configPath,
        });
    }
    for (const key of ['include', 'exclude']) {
      const patterns = raw[key];
      if (
        Array.isArray(patterns) &&
        patterns.some(
          (pattern) =>
            typeof pattern === 'string' &&
            ['!', '{', '}', '[', ']'].some((character) =>
              pattern.includes(character),
            ),
        )
      )
        diagnostics.push({
          code: 'UNSUPPORTED_CONFIG_PATTERN',
          message:
            'A project glob is outside the supported configuration patterns.',
          path: configPath,
        });
    }
  }
  const onDiagnostic = (diagnostic: ts.Diagnostic) =>
    diagnostics.push({
      code: `TS_${diagnostic.code}`,
      message: `TypeScript configuration diagnostic ${diagnostic.code}.`,
      path: configPath,
    });
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
