import { describe, expect, it } from 'vitest';
import {
  monitorWorkerRecovery,
  waitForBackendReady,
  type BackendHealthSnapshot,
  type HealthFetchLike,
} from '../scripts/run-local-stack.ts';

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('run-local-stack backend health and degraded worker startup', () => {
  const origin = 'http://127.0.0.1:8765';
  const token = 'a'.repeat(32);
  const aliveProcess = { exitCode: null, signalCode: null };

  it('returns immediately when API, database, and worker are all ready (HTTP 200)', async () => {
    let seenRedirect: RequestRedirect | undefined;
    const fetchImpl: HealthFetchLike = async (_url, init) => {
      seenRedirect = init?.redirect;
      return jsonResponse(
        { api: 'ready', database: 'ready', worker: 'ready', ready: true },
        200,
      );
    };
    const state = await waitForBackendReady(origin, token, aliveProcess, {
      fetchImpl,
      timeoutMs: 5_000,
      workerGraceMs: 1_000,
      sleep: async () => {},
    });
    expect(seenRedirect).toBe('manual');
    expect(state).toEqual({
      ready: true,
      degraded: false,
      health: {
        api: 'ready',
        database: 'ready',
        worker: 'ready',
        ready: true,
      },
    });
  });

  it('starts in degraded mode when API and database are ready (HTTP 503) while worker is unavailable, and detects later worker recovery', async () => {
    let clock = 0;
    const sleep = async (ms: number) => {
      clock += ms;
    };
    let calls = 0;
    const fetchImpl: HealthFetchLike = async () => {
      calls += 1;
      return jsonResponse(
        {
          api: 'ready',
          database: 'ready',
          worker: 'unavailable',
          ready: false,
        },
        503,
      );
    };

    const startup = await waitForBackendReady(origin, token, aliveProcess, {
      fetchImpl,
      timeoutMs: 10_000,
      workerGraceMs: 500,
      pollIntervalMs: 250,
      now: () => clock,
      sleep,
    });
    expect(startup).toEqual({
      ready: false,
      degraded: true,
      health: {
        api: 'ready',
        database: 'ready',
        worker: 'unavailable',
        ready: false,
      },
    });
    expect(calls).toBeGreaterThanOrEqual(3);

    // Verify background worker recovery detection when worker transitions to ready.
    let recoveryPolls = 0;
    let recoveredHealth: BackendHealthSnapshot | null = null;
    const abort = new AbortController();
    const recovered = await monitorWorkerRecovery(
      origin,
      token,
      abort.signal,
      (health) => {
        recoveredHealth = health;
      },
      {
        pollIntervalMs: 10,
        sleep: async () => {},
        fetchImpl: async () => {
          recoveryPolls += 1;
          if (recoveryPolls < 3) {
            return jsonResponse(
              {
                api: 'ready',
                database: 'ready',
                worker: 'unavailable',
                ready: false,
              },
              503,
            );
          }
          return jsonResponse(
            { api: 'ready', database: 'ready', worker: 'ready', ready: true },
            200,
          );
        },
      },
    );
    expect(recovered).toBe(true);
    expect(recoveryPolls).toBe(3);
    expect(recoveredHealth).toEqual({
      api: 'ready',
      database: 'ready',
      worker: 'ready',
      ready: true,
    });
  });

  it('does not treat database unavailability as degraded worker mode and fails explicitly at timeout', async () => {
    let clock = 0;
    const fetchImpl: HealthFetchLike = async () =>
      jsonResponse(
        {
          api: 'ready',
          database: 'unavailable',
          worker: 'unavailable',
          ready: false,
        },
        503,
      );

    await expect(
      waitForBackendReady(origin, token, aliveProcess, {
        fetchImpl,
        timeoutMs: 1_000,
        workerGraceMs: 200,
        pollIntervalMs: 250,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      }),
    ).rejects.toThrow(/Backend database .* remained unavailable/);
  });

  it('fails immediately if the backend child process exits before readiness', async () => {
    await expect(
      waitForBackendReady(
        origin,
        token,
        { exitCode: 1, signalCode: null },
        { fetchImpl: async () => new Response('', { status: 500 }) },
      ),
    ).rejects.toThrow(/Backend process exited before becoming ready/);
  });
});
