import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireGitSources, GitSourceError } from '../scripts/git-source.ts';

const processControl = vi.hoisted(() => ({
  mode: 'passthrough' as 'passthrough' | 'hang' | 'fail',
  intercepted: false,
  childClosed: false,
  onIntercept: undefined as (() => void) | undefined,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const [command, commandArgs = [], options] = args;
      if (
        processControl.mode !== 'passthrough' &&
        commandArgs.some((argument) => argument.startsWith('--batch-check='))
      ) {
        processControl.intercepted = true;
        const source =
          processControl.mode === 'fail'
            ? "process.stderr.write('private fixture failure'); process.exitCode = 17;"
            : 'setInterval(() => {}, 1000);';
        const child = actual.spawn(process.execPath, ['-e', source], options);
        child.once('close', () => {
          processControl.childClosed = true;
        });
        queueMicrotask(() => processControl.onIntercept?.());
        return child;
      }
      return actual.spawn(command, commandArgs, options);
    },
  };
});

const temporaryDirectories: string[] = [];

async function createRepository(): Promise<{
  path: string;
  revision: string;
}> {
  const path = await mkdtemp(resolve(tmpdir(), 'codethread-git-process-'));
  temporaryDirectories.push(path);
  await writeFile(resolve(path, 'entry.ts'), 'export function entry() {}\r\n');
  execFileSync('git', ['init', '--quiet'], { cwd: path });
  execFileSync('git', ['add', '--', 'entry.ts'], { cwd: path });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=CodeThread Test',
      '-c',
      'user.email=codethread-test@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'process fixture',
    ],
    { cwd: path },
  );
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: path,
    encoding: 'utf8',
  }).trim();
  return { path, revision };
}

function request(path: string, revision: string, signal?: AbortSignal) {
  return acquireGitSources({
    repositoryPath: path,
    repositoryId: '00000000-0000-4000-8000-000000000012',
    revision,
    selectedPaths: ['entry.ts'],
    ...(signal === undefined ? {} : { signal }),
  });
}

afterEach(async () => {
  processControl.mode = 'passthrough';
  processControl.intercepted = false;
  processControl.childClosed = false;
  processControl.onIntercept = undefined;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('Git child process failure handling', () => {
  it('kills an active Git child when the request is cancelled', async () => {
    const repository = await createRepository(),
      controller = new AbortController();
    processControl.mode = 'hang';
    processControl.onIntercept = () => controller.abort();

    await expect(
      request(repository.path, repository.revision, controller.signal),
    ).rejects.toMatchObject({ name: 'GitSourceError', code: 'CANCELLED' });
    expect(processControl.intercepted).toBe(true);
    expect(processControl.childClosed).toBe(true);
  }, 15_000);

  it('kills an active Git child at the stage deadline', async () => {
    const repository = await createRepository();
    processControl.mode = 'hang';

    await expect(
      request(repository.path, repository.revision),
    ).rejects.toMatchObject({ name: 'GitSourceError', code: 'GIT_TIMEOUT' });
    expect(processControl.intercepted).toBe(true);
    expect(processControl.childClosed).toBe(true);
  }, 15_000);

  it('sanitizes unexpected Git process failures', async () => {
    const repository = await createRepository();
    processControl.mode = 'fail';

    let failure: unknown;
    try {
      await request(repository.path, repository.revision);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(GitSourceError);
    expect(failure).toMatchObject({ code: 'GIT_FAILED' });
    if (failure instanceof GitSourceError)
      expect(failure.message).not.toContain('private fixture failure');
    expect(processControl.intercepted).toBe(true);
  }, 15_000);
});
