import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireGitSources,
  openGitInventory,
  GitSourceError,
} from '../scripts/git-source.ts';
import {
  createGitRepository,
  runGitFixture,
  writeFixtureTree,
  commitFixtureTree,
  gitFixtureEnvironment,
} from './helpers/git-fixture.ts';

type Mode =
  | 'passthrough'
  | 'hang'
  | 'fail'
  | 'observe'
  | 'malformed-metadata'
  | 'wrong-type'
  | 'wrong-id'
  | 'overflow'
  | 'truncated-body';
const processControl = vi.hoisted<{
  mode: Mode;
  intercepted: boolean;
  childClosed: boolean;
  objectSize: number;
  onIntercept: (() => void) | undefined;
}>(() => ({
  mode: 'passthrough',
  intercepted: false,
  childClosed: false,
  objectSize: 0,
  onIntercept: undefined,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const [command, commandArgs = [], options] = args;
      const check = commandArgs.some((argument) =>
        argument.startsWith('--batch-check='),
      );
      if (
        processControl.mode === 'observe' &&
        check &&
        !processControl.intercepted
      ) {
        processControl.intercepted = true;
        const child = actual.spawn(command, commandArgs, options);
        processControl.onIntercept?.();
        return child;
      }
      if (
        processControl.mode !== 'passthrough' &&
        processControl.mode !== 'observe' &&
        (processControl.mode === 'truncated-body'
          ? commandArgs.includes('--batch')
          : check)
      ) {
        processControl.intercepted = true;
        const readOid =
          "const oid = require('node:fs').readFileSync(0, 'utf8').trim().split('\\n')[0]; ";
        const scripts = {
          fail: "process.stderr.write('private fixture failure'); process.exitCode = 17;",
          hang: 'setInterval(() => {}, 1000);',
          'malformed-metadata':
            readOid + "process.stdout.write(oid + ' tree nope\\n');",
          'wrong-type': readOid + "process.stdout.write(oid + ' blob 0\\n');",
          'wrong-id':
            readOid +
            "process.stdout.write('0'.repeat(oid.length) + ' commit 0\\n');",
          overflow: "process.stdout.write('x'.repeat(10000));",
          'truncated-body':
            readOid +
            `process.stdout.write(oid + ' commit ${processControl.objectSize}\\n');`,
        };
        const source = scripts[processControl.mode];
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
  const { directory, revision } = await createGitRepository(
    [{ path: 'entry.ts', source: 'export function entry() {}\r\n' }],
    temporaryDirectories,
  );
  processControl.objectSize = Number(
    await runGitFixture(directory, ['cat-file', '-s', revision]),
  );
  return { path: directory, revision };
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
  processControl.objectSize = 0;
  processControl.onIntercept = undefined;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('Git child process failure handling', () => {
  it.each([
    ['malformed-metadata', 'GIT_PROTOCOL'],
    ['wrong-type', 'CORRUPT_OBJECT'],
    ['wrong-id', 'GIT_PROTOCOL'],
    ['overflow', 'RESOURCE_LIMIT'],
    ['truncated-body', 'GIT_PROTOCOL'],
  ] as const)(
    'rejects trusted harness protocol fault %s without retaining invalid source',
    async (mode, code) => {
      const repository = await createRepository();
      processControl.mode = mode;
      await expect(
        openGitInventory({
          repositoryPath: repository.path,
          repositoryId: '00000000-0000-4000-8000-000000000012',
          revision: repository.revision,
        }),
      ).rejects.toMatchObject({ code });
      expect(processControl.intercepted).toBe(true);
      expect(processControl.childClosed).toBe(true);
    },
  );

  it('cancels inventory traversal and confirms the trusted hanging child is closed', async () => {
    const repository = await createRepository(),
      controller = new AbortController();
    processControl.mode = 'hang';
    processControl.onIntercept = () => controller.abort();
    await expect(
      openGitInventory({
        repositoryPath: repository.path,
        repositoryId: '00000000-0000-4000-8000-000000000012',
        revision: repository.revision,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(processControl.intercepted).toBe(true);
    expect(processControl.childClosed).toBe(true);
  });

  it('enforces the inventory stage deadline and closes its active child', async () => {
    const repository = await createRepository();
    processControl.mode = 'hang';
    await expect(
      openGitInventory({
        repositoryPath: repository.path,
        repositoryId: '00000000-0000-4000-8000-000000000012',
        revision: repository.revision,
        limits: { deadlineMs: 5000 },
      }),
    ).rejects.toMatchObject({ code: 'GIT_TIMEOUT' });
    expect(processControl.intercepted).toBe(true);
    expect(processControl.childClosed).toBe(true);
  }, 10000);

  it('keeps source acquisition on the pinned commit when its ref moves during a real Git read', async () => {
    const repository = await createRepository();
    const session = await openGitInventory({
      repositoryPath: repository.path,
      repositoryId: '00000000-0000-4000-8000-000000000012',
      revision: 'HEAD',
    });
    const oid = (
      await runGitFixture(repository.path, ['rev-parse', 'HEAD:entry.ts'])
    ).trim();
    const tree = await writeFixtureTree(repository.path, [
      { mode: '100644', type: 'blob', oid, name: 'changed.ts' },
    ]);
    const next = await commitFixtureTree(repository.path, tree);
    processControl.mode = 'observe';
    processControl.onIntercept = () => {
      execFileSync('git', ['update-ref', 'HEAD', next], {
        cwd: repository.path,
        env: gitFixtureEnvironment(),
        timeout: 5000,
      });
    };
    const acquired = await session.acquire(
      session.select({ paths: ['entry.ts'] }),
    );
    expect(processControl.intercepted).toBe(true);
    expect(acquired.provenance.commitId).toBe(repository.revision);
    expect(Buffer.from(acquired.input.files[0]!.bytes).toString('utf8')).toBe(
      'export function entry() {}\r\n',
    );
    expect(
      (await runGitFixture(repository.path, ['rev-parse', 'HEAD'])).trim(),
    ).toBe(next);
    expect(session.statistics().commitReads).toBe(1);
  }, 15000);
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
