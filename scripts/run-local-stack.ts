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

async function waitForBackendReady(
  origin: string,
  token: string,
  backend: ChildProcess,
  timeoutMs = 25_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (backend.exitCode !== null || backend.signalCode !== null)
      throw new Error('Backend process exited before becoming ready.');
    try {
      const response = await fetch(`${origin}/v1/health`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.ok) {
        const body = (await response.json()) as { ready?: boolean };
        if (body.ready === true) return;
      }
    } catch {
      // Wait for listener bind.
    }
    await delay(250);
  }
  throw new Error(
    `Backend at ${origin} did not become ready within ${timeoutMs}ms.`,
  );
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
  const shutdown = async (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await Promise.allSettled([stopChild(workspace), stopChild(backend)]);
    process.exit(exitCode);
  };

  process.once('SIGINT', () => void shutdown(0));
  process.once('SIGTERM', () => void shutdown(0));

  try {
    await waitForBackendReady(apiOrigin, token, backend);
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
    console.log(
      `CodeThread local stack ready: workspace=${webOrigin} api=${apiOrigin} mode=${options.mode}`,
    );
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

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
