import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function containerEnvironment(env: NodeJS.ProcessEnv): string[] {
  // The explicit Docker path is for disposable loopback integration databases.
  // Use the container's local superuser socket without forwarding URL passwords.
  const database = env.PGDATABASE;
  if (!database) throw new Error('PostgreSQL database is required');
  return [
    '--env',
    'PGHOST=/var/run/postgresql',
    '--env',
    `PGUSER=${env.PGUSER ?? 'postgres'}`,
    '--env',
    `PGDATABASE=${database}`,
    '--env',
    'PGSSLMODE=disable',
  ];
}

function containerName(): string | undefined {
  const name = process.env.CODETHREAD_PG_TOOLS_CONTAINER;
  if (!name) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name))
    throw new Error('Invalid CODETHREAD_PG_TOOLS_CONTAINER name');
  return name;
}

export async function runPgDump(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const container = containerName();
  if (!container) {
    await execFileAsync(binary, args, {
      env,
      timeout: 120_000,
      windowsHide: true,
    });
    return;
  }
  const output = args
    .find((argument) => argument.startsWith('--file='))
    ?.slice(7);
  if (!output) throw new Error('pg_dump output path is missing');
  const remoteFile = `/tmp/codethread-backup-${randomUUID()}.dump`;
  try {
    await execFileAsync(
      'docker',
      [
        'exec',
        ...containerEnvironment(env),
        container,
        'pg_dump',
        ...args.filter((argument) => !argument.startsWith('--file=')),
        `--file=${remoteFile}`,
      ],
      { timeout: 120_000, windowsHide: true },
    );
    await execFileAsync(
      'docker',
      ['cp', `${container}:${remoteFile}`, output],
      {
        timeout: 120_000,
        windowsHide: true,
      },
    );
  } finally {
    await execFileAsync('docker', ['exec', container, 'rm', '-f', remoteFile], {
      timeout: 10_000,
      windowsHide: true,
    }).catch(() => {});
  }
}

export async function runPgRestore(
  binary: string,
  args: string[],
  archive: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const container = containerName();
  if (!container) {
    await execFileAsync(binary, [...args, archive], {
      env,
      timeout: 180_000,
      windowsHide: true,
    });
    return;
  }
  const remoteFile = `/tmp/codethread-restore-${randomUUID()}.dump`;
  try {
    await execFileAsync(
      'docker',
      ['cp', archive, `${container}:${remoteFile}`],
      {
        timeout: 120_000,
        windowsHide: true,
      },
    );
    await execFileAsync(
      'docker',
      [
        'exec',
        ...containerEnvironment(env),
        container,
        'pg_restore',
        ...args,
        remoteFile,
      ],
      { timeout: 180_000, windowsHide: true },
    );
  } finally {
    await execFileAsync('docker', ['exec', container, 'rm', '-f', remoteFile], {
      timeout: 10_000,
      windowsHide: true,
    }).catch(() => {});
  }
}
