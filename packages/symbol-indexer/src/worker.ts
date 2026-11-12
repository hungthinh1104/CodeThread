import { getHeapStatistics } from 'node:v8';
import { analysisResourceLimits } from '@codethread/code-model';
import type { AnalysisFacts } from '@codethread/code-model';
import type { WorkerInput, WorkerOutput } from './protocol.js';
import { AnalysisError } from './analysis-types.js';
import { identity } from './identity.js';
import { extractFacts } from './extract.js';
import { buildCompilerProgram } from './project-program.js';
import { PROJECT_SOURCE_ROOT } from './project-filesystem.js';

const sourceRoot = PROJECT_SOURCE_ROOT + '/';
const now = () => Number(process.hrtime.bigint()) / 1_000_000;

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
  const compilerStarted = now();
  const compiled = buildCompilerProgram(input);
  try {
    const program = compiled.program;
    const contextErrors = [
      ...program.getOptionsDiagnostics(),
      ...program.getGlobalDiagnostics(),
    ];
    if (!input.project && contextErrors.length)
      return {
        ok: false,
        code: 'COMPILER_INTEGRITY',
        message: 'The pinned compiler environment is incomplete',
      };
    const syntax = program.getSyntacticDiagnostics();
    if (syntax.length) {
      const sourcePath = syntax
        .find((item) => item.file?.fileName.startsWith(sourceRoot))
        ?.file?.fileName.slice(sourceRoot.length);
      return {
        ok: false,
        code: 'MALFORMED_SOURCE',
        message: 'A source file contains invalid TypeScript syntax',
        ...(sourcePath === undefined ? {} : { sourcePath }),
      };
    }
    const programFiles = new Set(
      program.getSourceFiles().map((file) => file.fileName),
    );
    const compilerMs = now() - compilerStarted;
    const admitted = input.project
      ? input.files.filter((file) => programFiles.has(sourceRoot + file.path))
      : input.files;
    const identityParts = {
      repositoryId: input.repositoryId,
      sourceFingerprint: input.sourceFingerprint,
      analyzerVersion: 'ct-index-001b/0.1.0;typescript/6.0.3',
      analyzerBuildHash: compiled.buildHash,
      configurationHash: input.configurationHash,
    };
    const snapshotId = identity('snapshot', identityParts);
    const facts: AnalysisFacts = {
      snapshotId,
      identity: identityParts,
      files: admitted.map((file) => ({
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
        files: admitted.length,
        declarations: 0,
        callSites: 0,
        exact: 0,
        unresolved: 0,
        ambiguous: 0,
        unsupported: 0,
        notAnalyzedInputs: admitted.length,
      },
    };

    const extractionStarted = now();
    const result = extractFacts(
      program,
      facts,
      sourceRoot,
      limits,
      !!input.project,
    );
    if (result.ok)
      return {
        ...result,
        phaseTimings: {
          compilerMs,
          extractionMs: now() - extractionStarted,
        },
        ...(input.project
          ? {
              contextDiagnostics: contextErrors
                .slice(0, 100)
                .map((item) => ({
                  code: 'TS_' + item.code,
                  message:
                    'TypeScript project context diagnostic ' + item.code + '.',
                }))
                .concat(result.contextDiagnostics ?? []),
            }
          : {}),
      };
    return result;
  } finally {
    compiled.dispose();
  }
}

let request = '',
  requestBytes = 0;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  requestBytes += Buffer.byteLength(chunk);
  if (requestBytes > analysisResourceLimits('repository').maxRequestBytes)
    process.exit(2);
  request += chunk;
});
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(request) as WorkerInput;
    if (
      requestBytes >
      analysisResourceLimits(input.resourceProfile).maxRequestBytes
    )
      throw new AnalysisError(
        'RESOURCE_LIMIT',
        'Compiler request exceeds its profile',
      );
    const result = analyze(input);
    const encoded = JSON.stringify(result);
    const peakRssBytes = process.resourceUsage().maxRSS * 1024;
    const suffix = ',"workerPeakRssBytes":' + peakRssBytes + '}';
    process.stdout.write(result.ok ? encoded.slice(0, -1) + suffix : encoded);
  } catch (error) {
    const failure: WorkerOutput =
      error instanceof AnalysisError
        ? {
            ok: false,
            code: error.code,
            message: error.message,
            ...(error.sourcePath === undefined
              ? {}
              : { sourcePath: error.sourcePath }),
          }
        : {
            ok: false,
            code: 'ANALYSIS_FAILED',
            message: 'The compiler failed without producing a result',
          };
    process.stdout.write(JSON.stringify(failure));
  }
});
