import { describe, expect, it } from 'vitest';
import { createSessionBudget } from '../scripts/investigation/session-budget.ts';

describe('repository session deadline', () => {
  it('aborts the shared signal and returns a typed timeout at the deadline', () => {
    let now = 10;
    const budget = createSessionBudget(undefined, 50, () => now);
    try {
      expect(budget.remainingMs()).toBe(50);
      now = budget.deadlineAt;
      expect(() => budget.throwIfStopped()).toThrowError(
        expect.objectContaining({ code: 'ANALYSIS_TIMEOUT' }),
      );
      expect(budget.signal.aborted).toBe(true);
    } finally {
      budget.dispose();
    }
  });

  it('keeps caller cancellation distinct from a session timeout', () => {
    const controller = new AbortController(),
      budget = createSessionBudget(controller.signal, 50);
    try {
      controller.abort();
      expect(budget.signal.aborted).toBe(true);
      expect(() => budget.throwIfStopped()).toThrowError(
        expect.objectContaining({ code: 'CANCELLED' }),
      );
    } finally {
      budget.dispose();
    }
  });
});
