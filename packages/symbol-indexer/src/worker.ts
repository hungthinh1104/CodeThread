import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getHeapStatistics } from 'node:v8';
import ts from 'typescript';
import type { AnalysisFacts } from '@codethread/code-model';
import { analysisResourceLimits } from '@codethread/code-model';
import type { WorkerInput, WorkerOutput } from './protocol.js';
import { hash, identity } from './identity.js';
import { extractFacts } from './extract.js';

const sourceRoot = '/__codethread__/source/';
const libraryRoot = '/__codethread__/lib/';
const options: ts.CompilerOptions = {
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
function libraries(): { files: Map<string, string>; buildHash: string } {
  if (ts.version !== '6.0.3') throw new Error('Incorrect TypeScript version');
  const directory = realpathSync(dirname(ts.getDefaultLibFilePath(options)));
  const contents = new Map<string, string>();
  const pending = ['lib.es2023.d.ts'];
  while (pending.length) {
    const name = pending.pop()!;
    if (contents.has(name)) continue;
    if (!/^lib\.[a-z0-9.]+\.d\.ts$/.test(name))
      throw new Error('Invalid compiler library');
    const path = realpathSync(join(directory, name));
    if (!path.startsWith(directory + sep))
      throw new Error('Compiler library escaped its toolchain');
    const source = readFileSync(path, 'utf8');
    contents.set(name, source);
    for (const match of source.matchAll(
      /<reference\s+lib="([a-z0-9.]+)"\s*\/>/g,
    ))
      pending.push(`lib.${match[1]}.d.ts`);
  }
  const digest = createHash('sha256');
  digest.update('codethread-analyzer-build-v2\0typescript-6.0.3\0');
  for (const [name, text] of [...contents].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  ))
    digest.update(name + '\0' + hash(text) + '\0');
  digest.update(hash(readFileSync(join(directory, 'typescript.js'))));
  const own = dirname(fileURLToPath(import.meta.url));
  for (const name of readdirSync(own)
    .filter((item) => item.endsWith('.js'))
    .sort()) {
    digest.update(
      name +
        '\0' +
        hash(readFileSync(join(own, name), 'utf8').replaceAll('\r\n', '\n')) +
        '\0',
    );
  }
  const model = fileURLToPath(import.meta.resolve('@codethread/code-model'));
  digest.update(hash(readFileSync(model, 'utf8').replaceAll('\r\n', '\n')));
  return {
    files: new Map(
      [...contents].map(([name, source]) => [libraryRoot + name, source]),
    ),
    buildHash: digest.digest('hex'),
  };
}

function analyze(input: WorkerInput): WorkerOutput {
  const limits = analysisResourceLimits(input.resourceProfile);
  if (
    getHeapStatistics().heap_size_limit > input.heapLimitBytes ||
    input.heapLimitBytes > limits.maxHeapMiB * 1024 * 1024
  )
    return {
      ok: false,
      code: 'RESOURCE_LIMIT',
      message: 'V8 heap exceeds the configured limit',
    };
  let pinned: ReturnType<typeof libraries>;
  try {
    pinned = libraries();
  } catch {
    return {
      ok: false,
      code: 'COMPILER_INTEGRITY',
      message: 'Pinned compiler libraries could not be verified',
    };
  }
  const text = new Map(pinned.files);
  for (const file of input.files) {
    const bytes = Buffer.from(file.base64, 'base64');
    if (bytes.length !== file.byteLength || hash(bytes) !== file.sha256)
      return {
        ok: false,
        code: 'HASH_MISMATCH',
        message: 'Worker source identity mismatch',
      };
    text.set(
      sourceRoot + file.path,
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
    );
  }
  const directories = new Set<string>();
  for (const path of text.keys()) {
    let end = path.lastIndexOf('/');
    while (end > 0) {
      directories.add(path.slice(0, end));
      end = path.lastIndexOf('/', end - 1);
    }
  }
  const host: ts.CompilerHost = {
    getSourceFile(path, languageVersion) {
      const contents = text.get(path);
      return contents === undefined
        ? undefined
        : ts.createSourceFile(path, contents, languageVersion, true);
    },
    getDefaultLibFileName: () => libraryRoot + 'lib.es2023.d.ts',
    getDefaultLibLocation: () => libraryRoot.slice(0, -1),
    writeFile: () => {
      throw new Error('Compiler emission is disabled');
    },
    getCurrentDirectory: () => sourceRoot.slice(0, -1),
    getCanonicalFileName: (path) => path,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (path) => text.has(path),
    readFile: (path) => text.get(path),
    directoryExists: (path) => directories.has(path),
    getDirectories: () => [],
    realpath: (path) => path,
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
          result.resolvedFileName.startsWith(sourceRoot) &&
          text.has(result.resolvedFileName)
          ? result
          : undefined;
      });
    },
  };
  const program = ts.createProgram(
    input.files.map((file) => sourceRoot + file.path),
    options,
    host,
  );
  if (
    program.getOptionsDiagnostics().length ||
    program.getGlobalDiagnostics().length
  )
    return {
      ok: false,
      code: 'COMPILER_INTEGRITY',
      message: 'The pinned compiler environment is incomplete',
    };
  const syntaxDiagnostics = program.getSyntacticDiagnostics();
  if (syntaxDiagnostics.length) {
    const sourcePath = syntaxDiagnostics
      .find((diagnostic) => diagnostic.file?.fileName.startsWith(sourceRoot))
      ?.file?.fileName.slice(sourceRoot.length);
    return {
      ok: false,
      code: 'MALFORMED_SOURCE',
      message: 'A source file contains invalid TypeScript syntax',
      ...(sourcePath === undefined ? {} : { sourcePath }),
    };
  }
  const identityParts = {
    repositoryId: input.repositoryId,
    sourceFingerprint: input.sourceFingerprint,
    analyzerVersion: 'ct-index-001b/0.1.0;typescript/6.0.3',
    analyzerBuildHash: pinned.buildHash,
    configurationHash: input.configurationHash,
  };
  const snapshotId = identity('snapshot', identityParts);
  const facts: AnalysisFacts = {
    snapshotId,
    identity: identityParts,
    files: input.files.map((file) => ({
      snapshotId,
      id: identity('file', [snapshotId, file.path]),
      path: file.path,
      contentHash: file.sha256,
      byteLength: file.byteLength,
    })),
    symbols: [],
    relations: [],
    evidenceRefs: [],
    diagnostics: [],
    observations: [],
    coverageByCapability: {
      'declarations.v1': 'not_analyzed',
      'relationships.v1': 'not_analyzed',
      'imports.v1': 'not_analyzed',
      'references.v1': 'not_analyzed',
      'test_behavior.v1': 'not_analyzed',
    },
    counts: {
      files: input.files.length,
      declarations: 0,
      callSites: 0,
      exact: 0,
      unresolved: 0,
      ambiguous: 0,
      unsupported: 0,
      notAnalyzedInputs: input.files.length,
    },
  };
  return extractFacts(program, facts, sourceRoot, limits);
}

let request = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  request += chunk;
  if (
    Buffer.byteLength(request) >
    analysisResourceLimits('repository').maxRequestBytes
  )
    process.exit(2);
});
process.stdin.on('end', () => {
  try {
    process.stdout.write(
      JSON.stringify(analyze(JSON.parse(request) as WorkerInput)),
    );
  } catch {
    process.stdout.write(
      JSON.stringify({
        ok: false,
        code: 'ANALYSIS_FAILED',
        message: 'The compiler failed without producing a result',
      } satisfies WorkerOutput),
    );
  }
});
