import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}
interface Options {
  env?: NodeJS.ProcessEnv;
  nodeArguments?: readonly string[];
  deadlineMs?: number;
}

export function startInvestigationCli(
  args: readonly string[],
  options: Options = {},
) {
  const script = fileURLToPath(
    new URL('../../scripts/investigate.ts', import.meta.url),
  );
  const child = spawn(
    process.execPath,
    [
      '--disable-warning=ExperimentalWarning',
      ...(options.nodeArguments ?? []),
      script,
      ...args,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, ...options.env },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let stdout = '',
    stderr = '',
    bytes = 0,
    closed = false;
  const outputDecoder = new StringDecoder('utf8'),
    errorDecoder = new StringDecoder('utf8');
  const waiters = new Set<{
    pattern: RegExp;
    resolve(value: RegExpMatchArray): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  let rejectResult: (error: Error) => void;
  const result = new Promise<CliResult>((resolveResult, reject) => {
    rejectResult = reject;
    const deadline = setTimeout(() => {
      child.kill();
      reject(new Error('CLI exceeded the test harness deadline.'));
    }, options.deadlineMs ?? 30000);
    const collect = (chunk: Buffer, error: boolean) => {
      bytes += chunk.length;
      if (bytes > 256 * 1024) {
        child.kill();
        reject(new Error('CLI exceeded the test harness output bound.'));
        return;
      }
      if (error) stderr += errorDecoder.write(chunk);
      else stdout += outputDecoder.write(chunk);
      for (const waiter of waiters) {
        const match = stdout.match(waiter.pattern);
        if (match) {
          clearTimeout(waiter.timer);
          waiters.delete(waiter);
          waiter.resolve(match);
        }
      }
    };
    child.stdout.on('data', (chunk: Buffer) => collect(chunk, false));
    child.stderr.on('data', (chunk: Buffer) => collect(chunk, true));
    child.once('error', (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once('close', (code) => {
      closed = true;
      clearTimeout(deadline);
      stdout += outputDecoder.end();
      stderr += errorDecoder.end();
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('CLI closed before the expected output.'));
      }
      waiters.clear();
      resolveResult({ code, stdout, stderr });
    });
  });
  child.stdin.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') rejectResult(error);
  });
  return {
    child,
    result,
    waitFor(pattern: RegExp, timeoutMs = 15000): Promise<RegExpMatchArray> {
      const match = stdout.match(pattern);
      if (match) return Promise.resolve(match);
      if (closed) return Promise.reject(new Error('CLI has already closed.'));
      return new Promise((resolveMatch, reject) => {
        const waiter = {
          pattern,
          resolve: resolveMatch,
          reject,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(new Error('CLI output wait expired.'));
          }, timeoutMs),
        };
        waiters.add(waiter);
      });
    },
    async stop(): Promise<void> {
      if (!closed) child.kill();
      await result;
    },
  };
}

export async function runInvestigationCli(
  args: readonly string[],
  input = '',
  env: NodeJS.ProcessEnv = {},
): Promise<CliResult> {
  const running = startInvestigationCli(args, { env, deadlineMs: 15000 });
  running.child.stdin.end(input);
  return await running.result;
}
