import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { platform, release, tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { discoverGitFiles } from './git-source.ts';
import type { GitFileInventory } from './git-source.ts';

const benchmarkRepositoryId = '00000000-0000-4000-8000-000000000022';
const workloads = [
  { name: 'small', files: 24 },
  { name: 'medium', files: 240 },
  { name: 'large', files: 1_200 },
] as const;
const repetitions = 3;

interface DiscoveryMeasurement {
  name: string;
  sourceFilesCommitted: number;
  discoveryCounts: GitFileInventory['counts'];
  truncated: boolean;
  truncationReasons: GitFileInventory['truncationReasons'];
  repetitions: number;
  timingsMs: number[];
  medianMs: number;
}

function gitEnvironment(globalConfig: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(environment))
    if (key.startsWith('GIT_')) delete environment[key];
  environment.GIT_CONFIG_GLOBAL = globalConfig;
  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_OPTIONAL_LOCKS = '0';
  environment.GIT_TERMINAL_PROMPT = '0';
  return environment;
}

async function runGit(
  cwd: string,
  globalConfig: string,
  args: readonly string[],
): Promise<string> {
  return await new Promise((resolveOutput, reject) => {
    const child = spawn('git', [...args], {
      cwd,
      env: gitEnvironment(globalConfig),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    let byteCount = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Git benchmark setup timed out.'));
    }, 30_000);
    child.stdout.on('data', (chunk: Buffer) => {
      byteCount += chunk.byteLength;
      if (byteCount > 64 * 1024) {
        child.kill();
        reject(new Error('Git benchmark command exceeded its output bound.'));
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (Buffer.concat(stderr).byteLength < 8 * 1024)
        stderr.push(Buffer.from(chunk).subarray(0, 8 * 1024));
    });
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('Git is unavailable.'));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error('Git benchmark setup failed.'));
      else resolveOutput(Buffer.concat(stdout).toString('utf8'));
    });
  });
}

async function createRepository(
  base: string,
  count: number,
): Promise<{ root: string; globalConfig: string; commitId: string }> {
  const root = resolve(base, `repo-${count}`),
    globalConfig = resolve(base, 'empty.gitconfig'),
    hooks = resolve(base, 'empty-hooks');
  await Promise.all([
    mkdir(root, { recursive: true }),
    mkdir(hooks, { recursive: true }),
    writeFile(globalConfig, ''),
  ]);
  await runGit(root, globalConfig, [
    'init',
    '--quiet',
    '--initial-branch=main',
  ]);
  for (let index = 0; index < count; index++) {
    const group = Math.floor(index / 40),
      path = resolve(
        root,
        'src',
        `group-${String(group).padStart(4, '0')}`,
        `file-${String(index).padStart(5, '0')}.ts`,
      );
    await mkdir(resolve(path, '..'), { recursive: true });
    await writeFile(
      path,
      `export function item_${index}(): number { return ${index}; }\n`,
      'utf8',
    );
  }
  await writeFile(resolve(root, 'README.md'), 'Generated benchmark tree.\n');
  await runGit(root, globalConfig, ['add', '--', '.']);
  await runGit(root, globalConfig, [
    '-c',
    'user.name=CodeThread benchmark',
    '-c',
    'user.email=benchmark@example.invalid',
    '-c',
    `core.hooksPath=${hooks}`,
    'commit',
    '--quiet',
    '-m',
    'generated source inventory benchmark',
  ]);
  const commitId = (
    await runGit(root, globalConfig, ['rev-parse', 'HEAD'])
  ).trim();
  return { root, globalConfig, commitId };
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)]!;
}

async function main(): Promise<void> {
  const base = await mkdtemp(resolve(tmpdir(), 'codethread-discovery-bench-'));
  try {
    const gitVersion = (
      await runGit(base, resolve(base, 'empty.gitconfig'), ['--version'])
    ).trim();
    const results: DiscoveryMeasurement[] = [];
    for (const workload of workloads) {
      const repository = await createRepository(base, workload.files),
        timings: number[] = [];
      let expected = '',
        firstInventory: GitFileInventory | undefined;
      for (let repeat = 0; repeat < repetitions; repeat++) {
        const started = performance.now(),
          inventory = await discoverGitFiles({
            repositoryPath: repository.root,
            repositoryId: benchmarkRepositoryId,
            revision: repository.commitId,
          });
        timings.push(Number((performance.now() - started).toFixed(3)));
        const identity = JSON.stringify({
          paths: inventory.files.map((file) => [file.path, file.mode]),
          counts: inventory.counts,
          truncated: inventory.truncated,
          reasons: inventory.truncationReasons,
        });
        if (repeat === 0) {
          expected = identity;
          firstInventory = inventory;
        } else if (identity !== expected)
          throw new Error(
            'Repeated discovery produced nondeterministic results.',
          );
        if (inventory.commitId !== repository.commitId)
          throw new Error('Discovery changed the pinned commit identity.');
        if (inventory.counts.files !== Math.min(workload.files, 1_000))
          throw new Error('Discovery returned an unexpected number of paths.');
      }
      if (!firstInventory)
        throw new Error('Benchmark had no discovery measurements.');
      results.push({
        name: workload.name,
        sourceFilesCommitted: workload.files,
        discoveryCounts: firstInventory.counts,
        truncated: firstInventory.truncated,
        truncationReasons: firstInventory.truncationReasons,
        repetitions,
        timingsMs: timings,
        medianMs: median(timings),
      });
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          benchmark: 'CT-COMP-001 source discovery',
          environment: {
            node: process.version,
            platform: platform(),
            osRelease: release(),
            git: gitVersion,
            processors: process.env.NUMBER_OF_PROCESSORS ?? null,
          },
          limits: {
            listedFiles: 1_000,
            uniqueTrees: 128,
            treeVisits: 4_096,
            treeEntries: 10_000,
            pathComponents: 64,
            metadataObjectBytes: 1024 * 1024,
            metadataBytes: 4 * 1024 * 1024,
            deadlineMs: 10_000,
          },
          results,
          note: 'Synthetic generated trees; local timings only, not a scalability claim.',
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `Discovery benchmark failed: ${
      error instanceof Error ? error.message : 'unknown error'
    }\n`,
  );
  process.exitCode = 1;
});
