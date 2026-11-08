import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

export function gitFixtureEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
  };
  for (const key of Object.keys(env))
    if (key.startsWith('GIT_') && key !== 'GIT_TERMINAL_PROMPT')
      delete env[key];
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  env.GIT_NO_LAZY_FETCH = '1';
  return env;
}

export async function runGitFixture(
  cwd: string,
  args: readonly string[],
  input?: string | Buffer,
) {
  const env = gitFixtureEnvironment();
  const child = spawn('git', [...args], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });
  let stdout = '',
    stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.end(input);
  const code = await new Promise<number>((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Git fixture command exceeded its deadline.'));
    }, 10_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (exitCode) => {
      clearTimeout(timer);
      resolveExit(exitCode ?? -1);
    });
  });
  if (code !== 0)
    throw new Error(`Git fixture setup failed (${args[0]}): ${stderr}`);
  return stdout;
}

export async function createGitRepository(
  files: readonly { path: string; source: string }[],
  temporaryDirectories: string[],
  objectFormat: 'sha1' | 'sha256' = 'sha1',
): Promise<{ directory: string; revision: string }> {
  const directory = await mkdtemp(resolve(tmpdir(), 'codethread-git-source-'));
  temporaryDirectories.push(directory);
  for (const file of files) {
    const absolute = resolve(directory, file.path);
    await mkdir(resolve(absolute, '..'), { recursive: true });
    await writeFile(absolute, file.source, 'utf8');
  }
  await runGitFixture(directory, [
    'init',
    '--quiet',
    `--object-format=${objectFormat}`,
  ]);
  await runGitFixture(directory, [
    '-c',
    'user.name=CodeThread Test',
    '-c',
    'user.email=codethread-test@example.invalid',
    'add',
    '--',
    ...files.map((file) => file.path),
  ]);
  await runGitFixture(directory, [
    '-c',
    'user.name=CodeThread Test',
    '-c',
    'user.email=codethread-test@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'committed source fixture',
  ]);
  const revision = (
    await runGitFixture(directory, ['rev-parse', 'HEAD'])
  ).trim();
  return { directory, revision };
}

export async function writeFixtureTree(
  directory: string,
  entries: readonly { mode: string; type: string; oid: string; name: string }[],
): Promise<string> {
  const sorted = [...entries].sort((left, right) =>
    Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)),
  );
  const input = Buffer.concat(
    sorted.map((entry) =>
      Buffer.concat([
        Buffer.from(`${entry.mode} ${entry.type} ${entry.oid}\t`, 'ascii'),
        Buffer.from(entry.name, 'utf8'),
        Buffer.from([0]),
      ]),
    ),
  );
  return (await runGitFixture(directory, ['mktree', '-z'], input)).trim();
}

export async function commitFixtureTree(
  directory: string,
  treeId: string,
): Promise<string> {
  return (
    await runGitFixture(directory, [
      '-c',
      'user.name=CodeThread Test',
      '-c',
      'user.email=codethread-test@example.invalid',
      'commit-tree',
      treeId,
      '-m',
      'inventory fixture',
    ])
  ).trim();
}
