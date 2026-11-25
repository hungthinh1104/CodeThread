import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analysisResourceLimits } from '@codethread/code-model';
import { AnalysisError } from './analysis-types.js';
import type { WorkerInput, WorkerOutput } from './protocol.js';

const ALLOWED_WORKER_ENV_KEYS = new Set([
  'PATH',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'TZ',
  'LANG',
  'LC_ALL',
]);

export function workerEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source))
    if (value !== undefined && ALLOWED_WORKER_ENV_KEYS.has(key.toUpperCase()))
      env[key] = value;
  return env;
}

export function runWorker(
  input: WorkerInput,
  remaining: number,
  heapLimitMiB: number,
  signal?: AbortSignal,
): Promise<{ output: WorkerOutput; outputBytes: number }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AnalysisError('CANCELLED', 'Analysis cancelled'));
      return;
    }
    if (remaining <= 0) {
      reject(
        new AnalysisError('ANALYSIS_TIMEOUT', 'Analysis deadline exceeded'),
      );
      return;
    }
    const env = workerEnvironment();
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
    // The worker has no external state to flush on cancellation or a bound.
    const terminate = () => child.kill('SIGKILL');
    const onAbort = terminate;
    signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    let outputBytes = 0,
      timedOut = false,
      overflow = false,
      stderr = '';
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, remaining);
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (
        outputBytes >
        analysisResourceLimits(input.resourceProfile).maxResponseBytes
      ) {
        overflow = true;
        terminate();
      } else chunks.push(chunk);
    });
    // Drain stderr without exposing untrusted source text or retaining unbounded output.
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 8192)
        stderr += chunk.toString('utf8').slice(0, 8192 - stderr.length);
    });
    child.on('error', () => {
      cleanup();
      reject(
        new AnalysisError(
          'ANALYSIS_FAILED',
          'Unable to start the analysis process',
        ),
      );
    });
    child.on('close', (code) => {
      cleanup();
      if (signal?.aborted) {
        reject(new AnalysisError('CANCELLED', 'Analysis cancelled'));
        return;
      }
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
        resolve({
          output: JSON.parse(
            Buffer.concat(chunks).toString('utf8'),
          ) as WorkerOutput,
          outputBytes,
        });
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
    const request = JSON.stringify(input);
    if (
      Buffer.byteLength(request) >
      analysisResourceLimits(input.resourceProfile).maxRequestBytes
    ) {
      overflow = true;
      terminate();
    } else child.stdin.end(request);
  });
}
