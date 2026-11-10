import { AnalysisError } from '@codethread/symbol-indexer';

export interface SessionBudget {
  startedAt: number;
  deadlineAt: number;
  signal: AbortSignal;
  remainingMs(): number;
  throwIfStopped(): void;
  dispose(): void;
}

/** One monotonic deadline and cancellation signal for every repository phase. */
export function createSessionBudget(
  signal: AbortSignal | undefined,
  deadlineMs: number,
  now: () => number = () => performance.now(),
): SessionBudget {
  const startedAt = now(),
    deadlineAt = startedAt + deadlineMs,
    controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, deadlineMs);
  const combinedSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  const timeout = () =>
    new AnalysisError(
      'ANALYSIS_TIMEOUT',
      'Repository analysis deadline exceeded.',
    );
  const throwIfStopped = () => {
    if (expired || now() >= deadlineAt) {
      expired = true;
      controller.abort();
      throw timeout();
    }
    if (signal?.aborted)
      throw new AnalysisError('CANCELLED', 'Repository analysis cancelled.');
    if (controller.signal.aborted) throw timeout();
  };
  return {
    startedAt,
    deadlineAt,
    signal: combinedSignal,
    throwIfStopped,
    remainingMs() {
      throwIfStopped();
      const remaining = Math.floor(deadlineAt - now());
      if (remaining < 1) {
        expired = true;
        controller.abort();
        throw timeout();
      }
      return remaining;
    },
    dispose() {
      clearTimeout(timer);
    },
  };
}
