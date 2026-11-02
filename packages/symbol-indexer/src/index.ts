import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createSourcePositionIndex,
  idSchema,
  isSnapshotPath,
} from '@codethread/code-model';
import type {
  AnalysisFacts,
  VerifiedSourceReader,
} from '@codethread/code-model';
import type { PreparedFile, WorkerInput, WorkerOutput } from './protocol.js';
import { verifyFacts } from './verify.js';

export const COMPILER_PROFILE = Object.freeze({
  profile: 'ct-index-001a-esm-v1',
  target: 'ES2023',
  module: 'ESNext',
  moduleResolution: 'Bundler',
  moduleDetection: 'force',
  strict: true,
  noEmit: true,
  allowJs: false,
  types: Object.freeze([] as string[]),
  lib: Object.freeze(['es2023']),
});
export const ANALYSIS_LIMITS = Object.freeze({
  maxFiles: 20,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 2 * 1024 * 1024,
});
export interface AnalysisInput {
  repositoryId: string;
  compilerOptions: typeof COMPILER_PROFILE;
  files: readonly { path: string; bytes: Uint8Array; sha256: string }[];
  /** May lower the ten-second maximum; it never changes semantic identity. */
  deadlineMs?: number;
  /** May lower the 512 MiB V8 heap ceiling. */
  heapLimitMiB?: number;
}
export interface AnalysisSnapshot {
  facts: AnalysisFacts;
  source: VerifiedSourceReader;
}
export type AnalysisErrorCode =
  | 'INVALID_MANIFEST'
  | 'HASH_MISMATCH'
  | 'INVALID_ENCODING'
  | 'INVALID_COMPILER_OPTIONS'
  | 'RESOURCE_LIMIT'
  | 'ANALYSIS_TIMEOUT'
  | 'ANALYSIS_FAILED'
  | 'MALFORMED_SOURCE'
  | 'COMPILER_INTEGRITY';
export class AnalysisError extends Error {
  constructor(
    public readonly code: AnalysisErrorCode,
    message: string,
    public readonly sourcePath?: string,
  ) {
    super(message);
    this.name = 'AnalysisError';
  }
}

function freeze(value: unknown): void {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
}

function runWorker(
  input: WorkerInput,
  remaining: number,
  heapLimitMiB: number,
): Promise<WorkerOutput> {
  return new Promise((resolve, reject) => {
    if (remaining <= 0) {
      reject(
        new AnalysisError('ANALYSIS_TIMEOUT', 'Analysis deadline exceeded'),
      );
      return;
    }
    const env = { ...process.env };
    delete env['NODE_OPTIONS'];
    delete env['NODE_PATH'];
    delete env['NODE_V8_COVERAGE'];
    const semiSpace = heapLimitMiB >= 64 ? 8 : 1;
    const oldSpace = heapLimitMiB - 3 * semiSpace;
    const child = spawn(
      process.execPath,
      [
        `--max-old-space-size=${oldSpace}`,
        `--max-semi-space-size=${semiSpace}`,
        fileURLToPath(new URL('./worker.js', import.meta.url)),
      ],
      { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    const chunks: Buffer[] = [];
    let outputBytes = 0,
      timedOut = false,
      overflow = false,
      stderr = '';
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, remaining);
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 32 * 1024 * 1024) {
        overflow = true;
        child.kill();
      } else chunks.push(chunk);
    });
    // Drain stderr without exposing untrusted source text or retaining unbounded output.
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 8192)
        stderr += chunk.toString('utf8').slice(0, 8192 - stderr.length);
    });
    child.on('error', () => {
      clearTimeout(timer);
      reject(
        new AnalysisError(
          'ANALYSIS_FAILED',
          'Unable to start the analysis process',
        ),
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new AnalysisError('ANALYSIS_TIMEOUT', 'Analysis deadline exceeded'),
        );
        return;
      }
      if (overflow) {
        reject(
          new AnalysisError(
            'RESOURCE_LIMIT',
            'Analysis result exceeded the IPC limit',
          ),
        );
        return;
      }
      if (code !== 0) {
        reject(
          new AnalysisError(
            /heap out of memory|allocation failed/i.test(stderr)
              ? 'RESOURCE_LIMIT'
              : 'ANALYSIS_FAILED',
            'Analysis process terminated',
          ),
        );
        return;
      }
      try {
        resolve(
          JSON.parse(Buffer.concat(chunks).toString('utf8')) as WorkerOutput,
        );
      } catch {
        reject(
          new AnalysisError(
            'ANALYSIS_FAILED',
            'Invalid analysis process response',
          ),
        );
      }
    });
    child.stdin.on('error', () => {
      /* The process may exit before consuming input. */
    });
    child.stdin.end(JSON.stringify(input));
  });
}

export async function analyzeManifest(
  input: AnalysisInput,
): Promise<AnalysisSnapshot> {
  const started = Date.now();
  if (!input || typeof input !== 'object')
    throw new AnalysisError('INVALID_MANIFEST', 'Invalid input');
  const deadlineMs = input.deadlineMs ?? 10000;
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 10000)
    throw new AnalysisError('INVALID_MANIFEST', 'Invalid analysis deadline');
  const heapLimitMiB = input.heapLimitMiB ?? 512;
  if (
    !Number.isInteger(heapLimitMiB) ||
    heapLimitMiB < 16 ||
    heapLimitMiB > 512
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
  if (input.files.length > ANALYSIS_LIMITS.maxFiles)
    throw new AnalysisError('RESOURCE_LIMIT', 'Too many source files');
  let totalBytes = 0;
  for (const file of input.files) {
    if (!file || !(file.bytes instanceof Uint8Array))
      throw new AnalysisError('INVALID_MANIFEST', 'Invalid source bytes');
    totalBytes += file.bytes.byteLength;
    if (
      file.bytes.byteLength > ANALYSIS_LIMITS.maxFileBytes ||
      totalBytes > ANALYSIS_LIMITS.maxTotalBytes
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
    configurationHash: sha(JSON.stringify(COMPILER_PROFILE)),
    files: prepared,
  };
  const output = await runWorker(
    workerInput,
    deadlineMs - (Date.now() - started),
    heapLimitMiB,
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
  const facts = output.facts;
  try {
    verifyFacts(facts, workerInput, sources);
  } catch {
    throw new AnalysisError(
      'ANALYSIS_FAILED',
      'Analysis facts failed source or identity verification',
    );
  }
  if (Date.now() - started > deadlineMs)
    throw new AnalysisError('ANALYSIS_TIMEOUT', 'Analysis deadline exceeded');
  freeze(facts);
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
  return Object.freeze({ facts, source });
}
