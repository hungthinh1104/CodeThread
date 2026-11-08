import { relative, sep, isAbsolute, delimiter, resolve } from 'node:path';
import { access, realpath, stat, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { GitSourceError, MAX_STDERR_BYTES } from './types.ts';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

export interface GitProcessResult {
  stdout: Buffer;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === code
  );
}

function isOutside(path: string, directory: string): boolean {
  const remainder = relative(directory, path);
  return (
    remainder === '..' ||
    remainder.startsWith(`..${sep}`) ||
    isAbsolute(remainder)
  );
}

export async function resolveGitExecutable(
  repositoryRoot: string,
): Promise<string> {
  const searchPath = process.env['PATH'] ?? '',
    extensions = process.platform === 'win32' ? ['.exe'] : [''];
  for (const directory of searchPath.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = resolve(directory, `git${extension}`);
      try {
        await access(
          candidate,
          process.platform === 'win32' ? undefined : constants.X_OK,
        );
        const absolute = await realpath(candidate),
          metadata = await stat(absolute);
        if (metadata.isFile() && isOutside(absolute, repositoryRoot))
          return absolute;
      } catch {
        // Continue through the caller's PATH; candidate paths are not diagnostics.
      }
    }
  }
  throw new GitSourceError(
    'GIT_UNAVAILABLE',
    'A trusted native Git executable outside the repository was not found.',
  );
}

function childEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'] ?? '',
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TRACE: '0',
    GIT_TRACE_SETUP: '0',
    GIT_TRACE_PACKET: '0',
    GIT_TRACE_PERFORMANCE: '0',
    GIT_TRACE2: '0',
    GIT_TRACE2_EVENT: '0',
    GIT_TRACE2_PERF: '0',
  };
  for (const key of ['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

export function runGit(
  executable: string,
  gitDirectory: string,
  workTree: string,
  args: readonly string[],
  deadlineAt: number,
  signal: AbortSignal | undefined,
  maxStdoutBytes: number,
  input: Buffer = Buffer.alloc(0),
): Promise<GitProcessResult> {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(
        new GitSourceError('CANCELLED', 'Git source acquisition cancelled.'),
      );
      return;
    }
    const remaining = deadlineAt - performance.now();
    if (remaining <= 0) {
      reject(
        new GitSourceError('GIT_TIMEOUT', 'Git source acquisition timed out.'),
      );
      return;
    }
    const child = spawn(
      executable,
      [
        '--git-dir',
        gitDirectory,
        '--work-tree',
        workTree,
        '--no-replace-objects',
        '--no-optional-locks',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.pager=cat',
        '-c',
        'protocol.allow=never',
        ...args,
      ],
      {
        cwd: workTree,
        env: childEnvironment(),
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    let stdoutBytes = 0,
      stderrBytes = 0,
      overflow = false,
      timedOut = false,
      cancelled = false,
      settled = false;
    const finishReject = (error: GitSourceError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(error);
    };
    const abort = () => {
      cancelled = true;
      child.kill();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, remaining);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        overflow = true;
        child.kill();
      } else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const retained = chunk.subarray(
        0,
        Math.max(0, MAX_STDERR_BYTES - stderrBytes),
      );
      stderrBytes += retained.length;
      if (retained.length > 0) stderr.push(retained);
    });
    child.stdin.on('error', () => {
      // A bounded Git command can exit before consuming its complete input.
    });
    child.stdin.end(input);
    child.once('error', () => {
      finishReject(
        new GitSourceError(
          'GIT_UNAVAILABLE',
          'Unable to start the Git process.',
        ),
      );
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (cancelled || signal?.aborted) {
        reject(
          new GitSourceError('CANCELLED', 'Git source acquisition cancelled.'),
        );
      } else if (timedOut) {
        reject(
          new GitSourceError(
            'GIT_TIMEOUT',
            'Git source acquisition timed out.',
          ),
        );
      } else if (overflow) {
        reject(
          new GitSourceError(
            'RESOURCE_LIMIT',
            'Git output exceeded its bound.',
          ),
        );
      } else if (code !== 0) {
        const diagnostic = Buffer.concat(stderr, stderrBytes).toString('utf8');
        const code =
          /could not get object info|object .* missing|not a valid object name/i.test(
            diagnostic,
          )
            ? 'MISSING_OBJECT'
            : /corrupt|bad object|unable to unpack|inflate/i.test(diagnostic)
              ? 'CORRUPT_OBJECT'
              : 'GIT_FAILED';
        reject(
          new GitSourceError(code, 'A required Git object operation failed.'),
        );
      } else {
        resolvePromise({
          stdout: Buffer.concat(stdout, stdoutBytes),
        });
      }
    });
  });
}

export function outputText(result: GitProcessResult): string {
  return result.stdout.toString('utf8').trim();
}

export async function assertRepositoryLayout(
  requestedPath: string,
): Promise<{ root: string; gitDirectory: string }> {
  let root: string;
  try {
    root = await realpath(resolve(requestedPath));
    const rootInfo = await stat(root);
    if (!rootInfo.isDirectory()) throw new Error('not-directory');
  } catch {
    throw new GitSourceError(
      'INVALID_REPOSITORY',
      'Repository root is unavailable.',
    );
  }
  const gitDirectory = resolve(root, '.git');
  try {
    const gitInfo = await lstat(gitDirectory);
    if (!gitInfo.isDirectory() || gitInfo.isSymbolicLink())
      throw new Error('unsupported-layout');
    const gitReal = await realpath(gitDirectory);
    if (resolve(gitReal) !== resolve(gitDirectory))
      throw new Error('unsupported-layout');
    const objects = resolve(gitDirectory, 'objects'),
      objectInfo = await lstat(objects);
    if (!objectInfo.isDirectory() || objectInfo.isSymbolicLink())
      throw new Error('unsupported-layout');
    for (const unsupported of [
      resolve(gitDirectory, 'commondir'),
      resolve(objects, 'info', 'alternates'),
    ]) {
      try {
        await lstat(unsupported);
      } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) throw error;
        continue;
      }
      throw new GitSourceError(
        'UNSUPPORTED_REPOSITORY_LAYOUT',
        'Linked worktrees and alternate object stores are not supported.',
      );
    }
    return { root, gitDirectory };
  } catch {
    throw new GitSourceError(
      'UNSUPPORTED_REPOSITORY_LAYOUT',
      'Only standard repositories with a real .git directory and local object store are supported.',
    );
  }
}
