import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { analyzeManifest, COMPILER_PROFILE } from '@codethread/symbol-indexer';
import { expect, it, vi } from 'vitest';
import { runGit } from '../scripts/git-source/process.ts';

const control = vi.hoisted(() => ({
  abort: null as AbortController | null,
  ready: false,
  watchdog: false,
  closedBy: null as NodeJS.Signals | null,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
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
