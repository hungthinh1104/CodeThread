import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analysisResourceLimits } from '@codethread/code-model';
import { AnalysisError } from './analysis-types.js';
import type { WorkerInput, WorkerOutput } from './protocol.js';

export function runWorker(
  input: WorkerInput,
  remaining: number,
  heapLimitMiB: number,
  signal?: AbortSignal,
): Promise<WorkerOutput> {
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
    const onAbort = () => child.kill();
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
      child.kill();
    }, remaining);
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (
        outputBytes >
        analysisResourceLimits(input.resourceProfile).maxResponseBytes
      ) {
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
    const request = JSON.stringify(input);
    if (
      Buffer.byteLength(request) >
      analysisResourceLimits(input.resourceProfile).maxRequestBytes
    ) {
      overflow = true;
      child.kill();
    } else child.stdin.end(request);
  });
}
