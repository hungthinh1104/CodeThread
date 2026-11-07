import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  deadlineMs,
  deepDirectoryDepth,
  sourceText,
  stdoutLimit,
  wideDirectoryLimit,
} from './config.ts';
import type { BenchmarkShape } from './config.ts';

export interface SyntheticRepository {
  root: string;
  globalConfig: string;
  commit: string;
  paths: string[];
  treeEntries: number;
}
interface TreeNode {
  files: string[];
  directories: Map<string, TreeNode>;
}

function gitEnvironment(globalConfig: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(environment))
    if (key.startsWith('GIT_')) delete environment[key];
  environment.GIT_CONFIG_GLOBAL = globalConfig;
  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_OPTIONAL_LOCKS = '0';
  environment.GIT_TERMINAL_PROMPT = '0';
  environment.GIT_AUTHOR_NAME = 'CodeThread benchmark';
  environment.GIT_AUTHOR_EMAIL = 'benchmark@example.invalid';
  environment.GIT_COMMITTER_NAME = environment.GIT_AUTHOR_NAME;
  environment.GIT_COMMITTER_EMAIL = environment.GIT_AUTHOR_EMAIL;
  environment.GIT_AUTHOR_DATE = '2000-01-01T00:00:00Z';
  environment.GIT_COMMITTER_DATE = environment.GIT_AUTHOR_DATE;
  return environment;
}

export async function runGit(
  cwd: string,
  globalConfig: string,
  args: readonly string[],
  input?: Buffer,
): Promise<Buffer> {
  return await new Promise((resolveOutput, reject) => {
    const child = spawn('git', [...args], {
      cwd,
      env: gitEnvironment(globalConfig),
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    let retained = 0,
      stderrBytes = 0;
    const timer = setTimeout(() => child.kill(), deadlineMs);
    child.stdout.on('data', (chunk: Buffer) => {
      retained += chunk.length;
      if (retained > stdoutLimit) child.kill();
      else stdout.push(Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > stdoutLimit) child.kill();
    });
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('Trusted local Git failed to start.'));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || retained > stdoutLimit || stderrBytes > stdoutLimit)
        reject(new Error('Synthetic benchmark Git operation failed.'));
      else resolveOutput(Buffer.concat(stdout));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

function benchmarkPaths(shape: BenchmarkShape, entries: number): string[] {
  if (shape === 'flat')
    return Array.from(
      { length: entries - 1 },
      (_, index) => `flat/item-${String(index).padStart(5, '0')}.ts`,
    );
  if (shape === 'deep') {
    const depth = Math.min(deepDirectoryDepth, entries - 1);
    const directory = Array.from(
      { length: depth },
      (_, index) => `d${String(index).padStart(3, '0')}`,
    ).join('/');
    return Array.from(
      { length: entries - depth },
      (_, index) => `${directory}/item-${String(index).padStart(5, '0')}.ts`,
    );
  }
  const directories = Math.min(
    wideDirectoryLimit,
    Math.floor((entries - 14) / 2),
  );
  const files = entries - directories;
  return Array.from({ length: files }, (_, index) => {
    const group = index < 15 ? 0 : 1 + ((index - 15) % (directories - 1));
    return `module-${String(group).padStart(3, '0')}/item-${String(index).padStart(5, '0')}.ts`;
  });
}

function countTreeEntries(paths: readonly string[]): number {
  const directories = new Set<string>();
  for (const path of paths) {
    const components = path.split('/');
    for (let count = 1; count < components.length; count++)
      directories.add(components.slice(0, count).join('/'));
  }
  return paths.length + directories.size;
}

function addPath(root: TreeNode, path: string): void {
  const [file, ...reverseDirectories] = path.split('/').reverse();
  let current = root;
  for (const directory of reverseDirectories.reverse()) {
    let child = current.directories.get(directory);
    if (!child) {
      child = { files: [], directories: new Map() };
      current.directories.set(directory, child);
    }
    current = child;
  }
  current.files.push(file!);
}

async function writeTree(
  node: TreeNode,
  repository: string,
  globalConfig: string,
  blobId: string,
): Promise<string> {
  const records: Buffer[] = [];
  for (const [name, child] of [...node.directories].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const oid = await writeTree(child, repository, globalConfig, blobId);
    records.push(Buffer.from(`40000 tree ${oid}\t${name}\0`, 'utf8'));
  }
  for (const name of node.files.sort())
    records.push(Buffer.from(`100644 blob ${blobId}\t${name}\0`, 'utf8'));
  const output = await runGit(
    repository,
    globalConfig,
    ['mktree', '-z'],
    Buffer.concat(records),
  );
  const oid = output.toString('ascii').trim();
  if (!/^[0-9a-f]{40}$/.test(oid))
    throw new Error('Git returned an invalid tree ID.');
  return oid;
}

export async function createRepository(
  base: string,
  shape: BenchmarkShape,
  entries: number,
): Promise<{
  root: string;
  globalConfig: string;
  commit: string;
  paths: string[];
  treeEntries: number;
}> {
  const root = resolve(base, `${shape}-${entries}`),
    globalConfig = resolve(base, 'empty.gitconfig');
  await Promise.all([
    mkdir(root, { recursive: true }),
    writeFile(globalConfig, ''),
  ]);
  await runGit(root, globalConfig, [
    'init',
    '--quiet',
    '--initial-branch=main',
  ]);
  const blobId = (
    await runGit(
      root,
      globalConfig,
      ['hash-object', '-w', '--stdin'],
      Buffer.from(sourceText),
    )
  )
    .toString('ascii')
    .trim();
  const paths = benchmarkPaths(shape, entries),
    treeEntries = countTreeEntries(paths),
    tree: TreeNode = { files: [], directories: new Map() };
  if (treeEntries !== entries)
    throw new Error(
      `Generated ${treeEntries} tree entries for a requested size of ${entries}.`,
    );
  for (const path of paths) addPath(tree, path);
  const rootTree = await writeTree(tree, root, globalConfig, blobId);
  const commit = (
    await runGit(root, globalConfig, [
      'commit-tree',
      rootTree,
      '-m',
      `synthetic ${shape} ${entries} entries`,
    ])
  )
    .toString('ascii')
    .trim();
  await runGit(root, globalConfig, ['update-ref', 'refs/heads/main', commit]);
  return { root, globalConfig, commit, paths, treeEntries };
}
