import { createHash } from 'node:crypto';
import {
  analysisResourceLimits,
  createSourcePositionIndex,
  idSchema,
  isSnapshotPath,
} from '@codethread/code-model';
import type { VerifiedSourceReader } from '@codethread/code-model';
import { COMPILER_PROFILE, AnalysisError } from './analysis-types.js';
import type {
  AnalysisInput,
  AnalysisSnapshot,
  AnalysisErrorCode,
} from './analysis-types.js';
import { runWorker } from './run-worker.js';
import type { WorkerInput } from './protocol.js';
import type { PreparedFile } from './analysis-types.js';
import type { ProjectWorkerContext } from './project-types.js';
import { verifyFacts } from './verify.js';

function freeze(value: unknown): void {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
}

export async function analyzeManifest(
  input: AnalysisInput,
): Promise<AnalysisSnapshot> {
  return analyzeInput(input);
}

export async function analyzeInput(
  input: AnalysisInput,
  project?: ProjectWorkerContext,
): Promise<AnalysisSnapshot> {
  const started = Date.now();
  if (!input || typeof input !== 'object')
    throw new AnalysisError('INVALID_MANIFEST', 'Invalid input');
  let limits: ReturnType<typeof analysisResourceLimits>;
  try {
    limits = analysisResourceLimits(input.resourceProfile);
  } catch {
    throw new AnalysisError('INVALID_MANIFEST', 'Unknown resource profile');
  }
  if (input.signal?.aborted)
    throw new AnalysisError('CANCELLED', 'Analysis cancelled');
  const deadlineMs = input.deadlineMs ?? limits.maxDeadlineMs;
  if (
    !Number.isInteger(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > limits.maxDeadlineMs
  )
    throw new AnalysisError('INVALID_MANIFEST', 'Invalid analysis deadline');
  const heapLimitMiB = input.heapLimitMiB ?? limits.maxHeapMiB;
  if (
    !Number.isInteger(heapLimitMiB) ||
    heapLimitMiB < 16 ||
    heapLimitMiB > limits.maxHeapMiB
  )
    throw new AnalysisError(
      'INVALID_MANIFEST',
      'Invalid analysis heap ceiling',
    );
  const options = input.compilerOptions as unknown as Record<string, unknown>;
  const expected = COMPILER_PROFILE as unknown as Record<string, unknown>;
  if (
    !options ||
    typeof options !== 'object' ||
    Object.keys(options).length !== Object.keys(expected).length ||
    Object.keys(expected).some(
      (key) => JSON.stringify(options[key]) !== JSON.stringify(expected[key]),
    )
  )
    throw new AnalysisError(
      'INVALID_COMPILER_OPTIONS',
      'Unsupported compiler profile',
    );
  if (
    !idSchema.safeParse(input.repositoryId).success ||
    !Array.isArray(input.files)
  )
    throw new AnalysisError(
      'INVALID_MANIFEST',
      'Invalid repository or source list',
    );
  if (input.files.length > limits.maxFiles)
    throw new AnalysisError('RESOURCE_LIMIT', 'Too many source files');
  let totalBytes = 0;
  for (const file of input.files) {
    if (!file || !(file.bytes instanceof Uint8Array))
      throw new AnalysisError('INVALID_MANIFEST', 'Invalid source bytes');
    totalBytes += file.bytes.byteLength;
    if (
      file.bytes.byteLength > limits.maxFileBytes ||
      totalBytes > limits.maxTotalBytes
    )
      throw new AnalysisError(
        'RESOURCE_LIMIT',
        'Source byte limit exceeded',
        typeof file.path === 'string' ? file.path : undefined,
      );
  }
  const paths = new Set<string>();
  const prepared: PreparedFile[] = [];
  const sources = new Map<
    string,
    {
      bytes: Uint8Array;
      text: string;
      positions: ReturnType<typeof createSourcePositionIndex>;
    }
  >();
  for (const file of input.files) {
    if (
      typeof file.path !== 'string' ||
      !isSnapshotPath(file.path) ||
      !file.path.endsWith('.ts') ||
      new TextDecoder().decode(new TextEncoder().encode(file.path)) !==
        file.path ||
      paths.has(file.path.toLowerCase())
    )
      throw new AnalysisError(
        'INVALID_MANIFEST',
        'Unsafe or conflicting source path',
        typeof file.path === 'string' ? file.path : undefined,
      );
    paths.add(file.path.toLowerCase());
    const bytes = Uint8Array.from(file.bytes);
    if (
      typeof file.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(file.sha256) ||
      createHash('sha256').update(bytes).digest('hex') !== file.sha256
    )
      throw new AnalysisError(
        'HASH_MISMATCH',
        'Source bytes do not match the declared hash',
        file.path,
      );
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        bytes,
      );
    } catch {
      throw new AnalysisError(
        'INVALID_ENCODING',
        'Source bytes are not valid UTF-8',
        file.path,
      );
    }
    prepared.push({
      path: file.path,
      sha256: file.sha256,
      byteLength: bytes.byteLength,
      base64: Buffer.from(bytes).toString('base64'),
    });
    sources.set(file.path, {
      bytes,
      text,
      positions: createSourcePositionIndex(text),
    });
  }
  prepared.sort((a, b) =>
    Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
  );
  const sha = (value: string) =>
    createHash('sha256').update(value).digest('hex');
  const workerInput: WorkerInput = {
    resourceProfile: input.resourceProfile ?? 'selected',
    heapLimitBytes: heapLimitMiB * 1024 * 1024,
    repositoryId: idSchema.parse(input.repositoryId),
    sourceFingerprint: sha(
      JSON.stringify({
        version: 1,
        files: prepared.map(({ path, sha256, byteLength }) => ({
          path,
          sha256,
          byteLength,
        })),
      }),
    ),
    configurationHash: sha(
      JSON.stringify(
        project
          ? {
              profile: 'ct-project-context-v1',
              configPath: project.configPath,
              rootPaths: project.rootPaths,
              referencePaths: project.referencePaths,
              metadata: project.metadata.map(({ path, sha256 }) => ({
                path,
                sha256,
              })),
              workspacePackages: project.workspacePackages,
            }
          : COMPILER_PROFILE,
      ),
    ),
    files: prepared,
    ...(project === undefined ? {} : { project }),
  };
  const inputPreparationMs = Date.now() - started;
  const workerStarted = Date.now();
  const { output, outputBytes } = await runWorker(
    workerInput,
    deadlineMs - (Date.now() - started),
    heapLimitMiB,
    input.signal,
  );
  if (!output || typeof output !== 'object' || typeof output.ok !== 'boolean')
    throw new AnalysisError(
      'ANALYSIS_FAILED',
      'Invalid analysis process response',
    );
  if (!output.ok) {
    if (
      output.sourcePath !== undefined &&
      !input.files.some((file) => file.path === output.sourcePath)
    )
      throw new AnalysisError(
        'ANALYSIS_FAILED',
        'Analysis process returned an unknown source path',
      );
    throw new AnalysisError(
      output.code as AnalysisErrorCode,
      output.message,
      output.sourcePath,
    );
  }
  const workerElapsedMs = Date.now() - workerStarted;
  const phaseTimings = output.phaseTimings;
  if (
    !phaseTimings ||
    !Number.isFinite(phaseTimings.compilerMs) ||
    phaseTimings.compilerMs < 0 ||
    !Number.isFinite(phaseTimings.extractionMs) ||
    phaseTimings.extractionMs < 0 ||
    phaseTimings.compilerMs + phaseTimings.extractionMs > workerElapsedMs + 1000
  )
    throw new AnalysisError(
      'ANALYSIS_FAILED',
      'Analysis process returned invalid phase timings',
    );
  const facts = output.facts;
  const factValidationStarted = Date.now();
  try {
    verifyFacts(facts, workerInput, sources);
  } catch {
    throw new AnalysisError(
      'ANALYSIS_FAILED',
      'Analysis facts failed source or identity verification',
    );
  }
  const factValidationMs = Date.now() - factValidationStarted;
  if (input.signal?.aborted)
    throw new AnalysisError('CANCELLED', 'Analysis cancelled');
  if (Date.now() - started > deadlineMs)
    throw new AnalysisError('ANALYSIS_TIMEOUT', 'Analysis deadline exceeded');
  freeze(facts);
  const retainedPaths = new Set(facts.files.map((file) => file.path));
  for (const path of sources.keys())
    if (!retainedPaths.has(path)) sources.delete(path);
  const byId = new Map(
    facts.evidenceRefs.map((evidence) => [evidence.id, evidence]),
  );
  const files = new Map(facts.files.map((file) => [file.id, file]));
  const source: VerifiedSourceReader = Object.freeze({
    readFile(fileId: string) {
      const file = files.get(fileId.toLowerCase());
      const retained = file && sources.get(file.path);
      return retained ? Uint8Array.from(retained.bytes) : null;
    },
    readEvidence(evidenceId: string) {
      const evidence = byId.get(evidenceId.toLowerCase());
      const unavailable = (
        code:
          | 'EVIDENCE_NOT_FOUND'
          | 'SOURCE_UNAVAILABLE'
          | 'HASH_MISMATCH'
          | 'INVALID_ENCODING'
          | 'EVIDENCE_TOO_LARGE',
      ) => ({
        status: 'unavailable' as const,
        snapshotId: facts.snapshotId,
        evidenceId,
        code,
      });
      if (!evidence) return unavailable('EVIDENCE_NOT_FOUND');
      const file = files.get(evidence.fileId);
      const source = file && sources.get(file.path);
      if (!file || !source) return unavailable('SOURCE_UNAVAILABLE');
      if (
        file.contentHash !== evidence.contentHash ||
        createHash('sha256').update(source.bytes).digest('hex') !==
          evidence.contentHash
      )
        return unavailable('HASH_MISMATCH');
      if (!source.positions.validateRange(evidence.range))
        return unavailable('SOURCE_UNAVAILABLE');
      if (evidence.range.end.offset - evidence.range.start.offset > 65536)
        return unavailable('EVIDENCE_TOO_LARGE');
      return {
        status: 'available' as const,
        evidence,
        filePath: file.path,
        text: source.text.slice(
          evidence.range.start.offset,
          evidence.range.end.offset,
        ),
      };
    },
  });
  return Object.freeze({
    facts,
    source,
    resourceProfile: input.resourceProfile ?? 'selected',
    execution: Object.freeze({
      ipcBytes: outputBytes,
      elapsedMs: Date.now() - started,
      inputPreparationMs,
      workerElapsedMs,
      compilerMs: phaseTimings.compilerMs,
      extractionMs: phaseTimings.extractionMs,
      factValidationMs,
      workerPeakRssBytes:
        typeof output.workerPeakRssBytes === 'number' &&
        Number.isSafeInteger(output.workerPeakRssBytes) &&
        output.workerPeakRssBytes > 0
          ? output.workerPeakRssBytes
          : null,
    }),
    ...(output.contextDiagnostics === undefined
      ? {}
      : { contextDiagnostics: Object.freeze([...output.contextDiagnostics]) }),
  });
}
