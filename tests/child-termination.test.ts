import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { analyzeManifest, COMPILER_PROFILE } from '@codethread/symbol-indexer';
import { expect, it, vi } from 'vitest';
import { runGit } from '../scripts/git-source/process.ts';

const control = vi.hoisted(() => ({
  abort: null as AbortController | null,
  captureEnv: false,
  capturedEnv: null as NodeJS.ProcessEnv | null,
  ready: false,
  watchdog: false,
  closedBy: null as NodeJS.Signals | null,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      if (control.captureEnv && args[0] === process.execPath) {
        control.capturedEnv = args[2]?.env ?? null;
        return actual.spawn(...args);
      }
      const abort = control.abort;
      if (!abort || args[0] !== process.execPath) return actual.spawn(...args);
      const child = actual.spawn(
        process.execPath,
        [
          '-e',
          'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000);',
        ],
        args[2],
      );
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      child.stdout!.once('data', () => {
        control.ready = true;
        watchdog = setTimeout(() => {
          control.watchdog = true;
          child.kill('SIGKILL');
        }, 1000);
        abort.abort();
      });
      child.once('close', (_code, signal) => {
        clearTimeout(watchdog);
        control.closedBy = signal;
      });
      return child;
    },
  };
});

it.skipIf(process.platform === 'win32').each(['Git', 'analyzer'] as const)(
  'reaps a trusted %s child that ignores SIGTERM',
  async (operation) => {
    const abort = new AbortController();
    control.abort = abort;
    control.ready = false;
    control.watchdog = false;
    control.closedBy = null;
    try {
      const bytes = Buffer.from('export function entry() { return 1; }');
      const pending =
        operation === 'Git'
          ? runGit(
              process.execPath,
              tmpdir(),
              tmpdir(),
              ['version'],
              performance.now() + 5000,
              abort.signal,
              1024,
            )
          : analyzeManifest({
              repositoryId: '00000000-0000-4000-8000-000000000076',
              compilerOptions: COMPILER_PROFILE,
              files: [
                {
                  path: 'entry.ts',
                  bytes,
                  sha256: createHash('sha256').update(bytes).digest('hex'),
                },
              ],
              signal: abort.signal,
            });
      await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
      expect(control.ready).toBe(true);
      expect(control.watchdog).toBe(false);
      expect(control.closedBy).toBe('SIGKILL');
    } finally {
      control.abort = null;
    }
  },
);

it('isolates host secrets and mixed-case NODE_* variables from the analyzer worker', async () => {
  const previous = {
    CODETHREAD_API_TOKEN: process.env.CODETHREAD_API_TOKEN,
    CODETHREAD_DATABASE_URL: process.env.CODETHREAD_DATABASE_URL,
    Node_Options: process.env.Node_Options,
    NODE_PATH: process.env.NODE_PATH,
  };
  process.env.CODETHREAD_API_TOKEN = 'secret-token-should-not-leak';
  process.env.CODETHREAD_DATABASE_URL = 'postgres://secret@127.0.0.1/db';
  process.env.Node_Options = '--max-old-space-size=9999';
  process.env.NODE_PATH = '/tmp/untrusted';
  control.captureEnv = true;
  control.capturedEnv = null;
  try {
    const bytes = Buffer.from('export function entry() { return 1; }');
    await analyzeManifest({
      repositoryId: '00000000-0000-4000-8000-000000000076',
      compilerOptions: COMPILER_PROFILE,
      files: [
        {
          path: 'entry.ts',
          bytes,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    });
    expect(control.capturedEnv).not.toBeNull();
    const upperKeys = Object.keys(control.capturedEnv!).map((key) =>
      key.toUpperCase(),
    );
    expect(upperKeys).not.toContain('CODETHREAD_API_TOKEN');
    expect(upperKeys).not.toContain('CODETHREAD_DATABASE_URL');
    expect(upperKeys).not.toContain('NODE_OPTIONS');
    expect(upperKeys).not.toContain('NODE_PATH');
    expect(upperKeys).not.toContain('NODE_V8_COVERAGE');
  } finally {
    control.captureEnv = false;
    control.capturedEnv = null;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
