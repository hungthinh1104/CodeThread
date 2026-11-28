import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { localPostgresConnection } from './backend/local-postgres-url.ts';

type StackOptions = {
  apiPort: number;
  webPort: number;
  migrate: boolean;
  mode: 'dev' | 'start';
};

export type BackendHealthSnapshot = {
  readonly api: 'ready';
  readonly database: 'ready' | 'unavailable';
  readonly worker: 'ready' | 'unavailable';
  readonly ready: boolean;
};

export type BackendStartupState = {
  readonly ready: boolean;
  readonly degraded: boolean;
  readonly health: BackendHealthSnapshot;
};

export type HealthFetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

function parseHealthSnapshot(value: unknown): BackendHealthSnapshot | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    record['api'] === 'ready' &&
    (record['database'] === 'ready' || record['database'] === 'unavailable') &&
    (record['worker'] === 'ready' || record['worker'] === 'unavailable') &&
    typeof record['ready'] === 'boolean'
  ) {
    const expectedReady =
      record['database'] === 'ready' && record['worker'] === 'ready';
    if (record['ready'] !== expectedReady) return null;
    return {
      api: 'ready',
      database: record['database'],
      worker: record['worker'],
      ready: record['ready'],
    };
  }
  return null;
}

export async function probeBackendHealth(
  origin: string,
  token: string,
  fetchImpl: HealthFetchLike = fetch,
  probeTimeoutMs = 2_000,
): Promise<BackendHealthSnapshot | null> {
  try {
    const response = await fetchImpl(`${origin}/v1/health`, {
      headers: { authorization: `Bearer ${token}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(probeTimeoutMs),
    });
    if (response.status !== 200 && response.status !== 503) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    const body: unknown = await response.json();
    return parseHealthSnapshot(body);
  } catch {
    return null;
  }
}

export interface WaitForBackendOptions {
  readonly timeoutMs?: number;
  readonly workerGraceMs?: number;
  readonly pollIntervalMs?: number;
  readonly probeTimeoutMs?: number;
  readonly fetchImpl?: HealthFetchLike;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Waits for the backend API and PostgreSQL database to become available.
 * Separates API/database availability from worker readiness:
 * - Full readiness (`ready === true`) returns immediately.
 * - Degraded worker (`api === 'ready' && database === 'ready' && worker === 'unavailable'`)
 *   allows startup after `workerGraceMs` (or when `timeoutMs` elapses while API+DB
 *   are already ready) so read-only investigation can launch while clearly
 *   reporting degraded worker state.
 * - Database or API unavailability continues waiting until `timeoutMs` and fails
 *   explicitly without confusing database failure with worker unavailability.
 */
export async function waitForBackendReady(
  origin: string,
  token: string,
  backend: Pick<ChildProcess, 'exitCode' | 'signalCode'>,
  options: WaitForBackendOptions = {},
): Promise<BackendStartupState> {
  const timeoutMs = options.timeoutMs ?? 25_000;
  const workerGraceMs = options.workerGraceMs ?? 3_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const probeTimeoutMs = options.probeTimeoutMs ?? 2_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => delay(ms));

  const deadline = now() + timeoutMs;
  let coreReadySince: number | null = null;
  let lastHealth: BackendHealthSnapshot | null = null;

  while (now() < deadline) {
    if (backend.exitCode !== null || backend.signalCode !== null)
      throw new Error('Backend process exited before becoming ready.');
    const health = await probeBackendHealth(
      origin,
      token,
      fetchImpl,
      probeTimeoutMs,
    );
    if (health) {
      lastHealth = health;
      if (
        health.ready &&
        health.database === 'ready' &&
        health.worker === 'ready'
      ) {
        return { ready: true, degraded: false, health };
      }
      if (health.api === 'ready' && health.database === 'ready') {
        coreReadySince ??= now();
        if (now() - coreReadySince >= workerGraceMs) {
          return { ready: false, degraded: true, health };
        }
      } else {
        coreReadySince = null;
      }
    } else {
      coreReadySince = null;
    }
    await sleep(pollIntervalMs);
  }
  if (
    lastHealth &&
    lastHealth.api === 'ready' &&
    lastHealth.database === 'ready'
  ) {
    return { ready: false, degraded: true, health: lastHealth };
  }
  if (lastHealth && lastHealth.database === 'unavailable') {
    throw new Error(
      `Backend database at ${origin} remained unavailable after ${timeoutMs}ms.`,
    );
  }
  throw new Error(
    `Backend API at ${origin} did not become available within ${timeoutMs}ms.`,
  );
}

/**
 * Watches a degraded worker in the background until it recovers to `ready`
 * or the provided AbortSignal fires.
 */
export async function monitorWorkerRecovery(
  origin: string,
  token: string,
  signal: AbortSignal,
  onRecovered: (health: BackendHealthSnapshot) => void,
  options: {
    readonly pollIntervalMs?: number;
    readonly fetchImpl?: HealthFetchLike;
    readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  } = {},
): Promise<boolean> {
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep =
    options.sleep ??
    (async (ms: number, abortSignal?: AbortSignal) => {
      try {
        await delay(ms, undefined, { signal: abortSignal });
      } catch {
        // Stop cleanly on abort.
      }
    });

  while (!signal.aborted) {
    await sleep(pollIntervalMs, signal);
    if (signal.aborted) return false;
    const health = await probeBackendHealth(origin, token, fetchImpl);
    if (health && health.ready && health.worker === 'ready') {
      onRecovered(health);
      return true;
    }
  }
  return false;
}

function parsePort(raw: string, flag: string): number {
  if (!/^\d{1,5}$/.test(raw))
    throw new Error(`${flag} must be a valid TCP port number.`);
  const value = Number(raw);
  if (value < 1 || value > 65535)
    throw new Error(`${flag} must be between 1 and 65535.`);
  return value;
}

function parseArgs(
  argv: readonly string[],
  workspaceDir: string,
): StackOptions {
  let apiPort = Number(process.env.CODETHREAD_API_PORT ?? '8765');
  let webPort = Number(
    process.env.CODETHREAD_WORKSPACE_PORT ??
      process.env.CODETHREAD_WEB_PORT ??
      '3000',
  );
  let migrate = false;
  let mode: 'dev' | 'start' | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--migrate') {
      migrate = true;
    } else if (arg === '--dev') {
      mode = 'dev';
    } else if (arg === '--prod' || arg === '--start') {
      mode = 'start';
    } else if (arg === '--api-port' && argv[i + 1]) {
      apiPort = parsePort(argv[++i]!, '--api-port');
    } else if (arg === '--web-port' && argv[i + 1]) {
      webPort = parsePort(argv[++i]!, '--web-port');
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        [
          'Usage: pnpm stack:start [--migrate] [--dev|--start] [--api-port 8765] [--web-port 3000]',
          '',
          'Required environment variables:',
          '  CODETHREAD_DATABASE_URL         Loopback PostgreSQL 17 connection URL',
          '  CODETHREAD_ALLOWED_REPO_ROOT    Absolute path containing local Git repos to scan',
          '',
          'Optional environment variables:',
          '  CODETHREAD_API_TOKEN            32+ char token (ephemeral random token generated if omitted)',
          '  CODETHREAD_MIGRATION_DATABASE_URL  Used when --migrate is passed (defaults to CODETHREAD_DATABASE_URL)',
          '  CODETHREAD_AI_ENABLED=1         Opt in to optional evidence-bound AI notes (off by default)',
          '  CODETHREAD_AI_PROVIDER=gemini   Use Gemini API (also requires CODETHREAD_AI_ALLOW_REMOTE=1 and GEMINI_API_KEY)',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const hasProdBuild = existsSync(resolve(workspaceDir, '.next/BUILD_ID'));
  return {
    apiPort,
    webPort,
    migrate,
    mode: mode ?? (hasProdBuild ? 'start' : 'dev'),
  };
}

function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolvePromise();
      else
        reject(new Error(`${command} ${args.join(' ')} exited with ${code}`));
    });
  });
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = new Promise<void>((resolveExit) => {
    child.once('exit', () => resolveExit());
  });
  await Promise.race([exited, delay(5_000)]);
  if (child.exitCode === null && child.signalCode === null)
    child.kill('SIGKILL');
}

async function main(): Promise<void> {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const workspaceDir = resolve(repoRoot, 'packages/investigation-workspace');
  const options = parseArgs(process.argv.slice(2), workspaceDir);

  const databaseUrl = process.env.CODETHREAD_DATABASE_URL;
  const allowedRoot = process.env.CODETHREAD_ALLOWED_REPO_ROOT;
  if (!databaseUrl)
    throw new Error(
      'CODETHREAD_DATABASE_URL is required (must point to a disposable loopback PostgreSQL database).',
    );
  localPostgresConnection(databaseUrl, 'CODETHREAD_DATABASE_URL');
  if (!allowedRoot)
    throw new Error(
      'CODETHREAD_ALLOWED_REPO_ROOT is required (absolute path containing local Git repositories).',
    );

  const token =
    process.env.CODETHREAD_API_TOKEN &&
    process.env.CODETHREAD_API_TOKEN.length >= 32
      ? process.env.CODETHREAD_API_TOKEN
      : randomBytes(32).toString('hex');

  const apiOrigin = `http://127.0.0.1:${options.apiPort}`;
  const webOrigin = `http://127.0.0.1:${options.webPort}`;

  if (options.migrate) {
    const migrationUrl =
      process.env.CODETHREAD_MIGRATION_DATABASE_URL ?? databaseUrl;
    localPostgresConnection(migrationUrl, 'CODETHREAD_MIGRATION_DATABASE_URL');
    await runCommand(
      process.execPath,
      [resolve(repoRoot, 'scripts/backend/migrate.ts')],
      { ...process.env, CODETHREAD_MIGRATION_DATABASE_URL: migrationUrl },
      repoRoot,
    );
  }

  const backend = spawn(
    process.execPath,
    [resolve(repoRoot, 'scripts/backend/main.ts')],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        CODETHREAD_DATABASE_URL: databaseUrl,
        CODETHREAD_ALLOWED_REPO_ROOT: allowedRoot,
        CODETHREAD_API_TOKEN: token,
        CODETHREAD_API_PORT: String(options.apiPort),
      },
      stdio: 'inherit',
    },
  );

  let workspace: ChildProcess | undefined;
  let shuttingDown = false;
  const lifecycleAbort = new AbortController();
  const shutdown = async (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    lifecycleAbort.abort();
    await Promise.allSettled([stopChild(workspace), stopChild(backend)]);
    process.exit(exitCode);
  };

  process.once('SIGINT', () => void shutdown(0));
  process.once('SIGTERM', () => void shutdown(0));

  try {
    const startup = await waitForBackendReady(apiOrigin, token, backend);
    const nextBin = resolve(workspaceDir, 'node_modules/next/dist/bin/next');
    workspace = spawn(
      process.execPath,
      [
        nextBin,
        options.mode,
        '--hostname',
        '127.0.0.1',
        '--port',
        String(options.webPort),
      ],
      {
        cwd: workspaceDir,
        env: {
          ...process.env,
          CODETHREAD_API_ORIGIN: apiOrigin,
          CODETHREAD_API_TOKEN: token,
          CODETHREAD_WORKSPACE_PORT: String(options.webPort),
          NEXT_TELEMETRY_DISABLED: '1',
        },
        stdio: 'inherit',
      },
    );
    if (startup.degraded) {
      console.warn(
        `CodeThread local stack started in degraded mode (worker unavailable; API and database ready): workspace=${webOrigin} api=${apiOrigin} mode=${options.mode}`,
      );
      void monitorWorkerRecovery(
        apiOrigin,
        token,
        lifecycleAbort.signal,
        () => {
          console.log(
            `CodeThread backend worker recovered and is now ready at ${apiOrigin}.`,
          );
        },
      );
    } else {
      console.log(
        `CodeThread local stack ready: workspace=${webOrigin} api=${apiOrigin} mode=${options.mode}`,
      );
    }
    backend.once('exit', (code) => {
      if (!shuttingDown) {
        console.error(`Backend exited unexpectedly with code ${code}.`);
        void shutdown(code ?? 1);
      }
    });
    workspace.once('exit', (code) => {
      if (!shuttingDown) {
        console.error(`Workspace exited unexpectedly with code ${code}.`);
        void shutdown(code ?? 1);
      }
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    await shutdown(1);
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === resolve(currentFile)) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
