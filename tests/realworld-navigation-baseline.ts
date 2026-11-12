import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

type Anchor = { path: string; symbol: string; declarationLine: number };
type Label = {
  id: string;
  expected: 'exact' | 'non_exact' | 'no_exact_relation';
  source?: Anchor;
  sourceCandidate?: Anchor;
  outerFunction?: Anchor;
  target?: Anchor;
  targetCandidate?: Anchor;
  targetName?: string;
  targetDeclaration?: { path: string; line: number; form?: string };
  memberExpression?: string;
  siteLine: number;
};
type Task = { id: string; repository: string; labels: Label[] };
type Repository = {
  key: string;
  commit: string;
  sourceFiles: { path: string; sha256: string }[];
};

const git = (repositoryPath: string, args: string[]): string =>
  execFileSync('git', ['-C', repositoryPath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 8 * 1024 * 1024,
  });

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sourceOf(label: Label): Anchor {
  return label.source ?? label.sourceCandidate ?? label.outerFunction!;
}

function pinnedFileHash(repository: Repository, path: string): string {
  const file = repository.sourceFiles.find((item) => item.path === path);
  assert.ok(file, `frozen manifest must include ${path}`);
  return file.sha256;
}

async function main(): Promise<void> {
  const taskBytes = await readFile(
    'docs/evaluation/ct-realworld-001/tasks.json',
  );
  const manifestBytes = await readFile(
    'docs/evaluation/ct-realworld-001/repositories.json',
  );
  const tasks = (JSON.parse(taskBytes.toString('utf8')) as { tasks: Task[] })
    .tasks;
  const repositories = (
    JSON.parse(manifestBytes.toString('utf8')) as {
      externalRepositories: Repository[];
    }
  ).externalRepositories;
  const root = resolve(
    process.env.CT_REALWORLD_SOURCE_ROOT ??
      resolve(process.cwd(), '..', 'ct-realworld-sources'),
  );
  const runs = [] as unknown[];
  let gitCommandCount = 0;
  for (const repository of repositories) {
    const repositoryPath = resolve(root, repository.key);
    assert.equal(
      git(repositoryPath, [
        'rev-parse',
        '--verify',
        `${repository.commit}^{commit}`,
      ]).trim(),
      repository.commit,
    );
    gitCommandCount++;
    const repoTasks = tasks.filter(
      (task) => task.repository === repository.key,
    );
    const startedAt = new Date().toISOString();
    const repoStarted = performance.now();
    const sourceCache = new Map<string, string[]>();
    const labels = [] as unknown[];
    const taskRuns = [] as unknown[];
    for (const task of repoTasks) {
      const taskStarted = performance.now();
      const taskLabels = [] as unknown[];
      for (const label of task.labels) {
        const lookupStarted = performance.now();
        const source = sourceOf(label);
        const grep = git(repositoryPath, [
          'grep',
          '-n',
          '-F',
          '-e',
          source.symbol,
          repository.commit,
          '--',
          '*.ts',
        ]);
        gitCommandCount++;
        const sourceFound = grep
          .split(/\r?\n/)
          .some((line) => line.includes(`:${source.path}:`));
        const readFileAtCommit = (path: string): string[] => {
          let lines = sourceCache.get(path);
          if (!lines) {
            const text = git(repositoryPath, [
              'show',
              `${repository.commit}:${path}`,
            ]);
            gitCommandCount++;
            lines = text.split(/\r?\n/);
            sourceCache.set(path, lines);
          }
          return lines;
        };
        const sourceLines = readFileAtCommit(source.path);
        const declarationText = sourceLines[source.declarationLine - 1] ?? '';
        const siteText = sourceLines[label.siteLine - 1] ?? '';
        const sourceDeclarationFound = declarationText.includes(source.symbol);
        const target = label.target;
        const targetName =
          target?.symbol ??
          label.targetCandidate?.symbol ??
          label.targetName ??
          label.memberExpression;
        const siteContainsTarget = targetName
          ? label.memberExpression
            ? siteText.includes(label.memberExpression)
            : new RegExp(`(^|[^\\w$])${escapeRegExp(targetName)}\\s*\\(`).test(
                siteText,
              )
          : false;
        const targetDeclaration = target
          ? { path: target.path, line: target.declarationLine }
          : (label.targetDeclaration ??
            (label.targetCandidate
              ? {
                  path: label.targetCandidate.path,
                  line: label.targetCandidate.declarationLine,
                }
              : undefined));
        let targetDeclarationFound: boolean | null = null;
        if (targetDeclaration) {
          const targetLines = readFileAtCommit(targetDeclaration.path);
          targetDeclarationFound = Boolean(
            targetLines[targetDeclaration.line - 1]?.includes(
              target?.symbol ??
                label.targetCandidate?.symbol ??
                label.targetName ??
                '',
            ),
          );
        }
        const navigationComplete = Boolean(
          sourceFound && sourceDeclarationFound && siteContainsTarget,
        );
        const row = {
          id: label.id,
          expected: label.expected,
          sourceLookupFound: sourceFound,
          sourceDeclarationFound,
          siteContainsExpectedExpression: siteContainsTarget,
          targetDeclarationFound,
          sourceEvidenceSha256: pinnedFileHash(repository, source.path),
          durationMs: Math.round(performance.now() - lookupStarted),
          navigationComplete,
        };
        labels.push(row);
        taskLabels.push(row);
      }
      taskRuns.push({
        id: task.id,
        durationMs: Math.round(performance.now() - taskStarted),
        completed: taskLabels.every(
          (label) =>
            (label as { navigationComplete: boolean }).navigationComplete,
        ),
        labels: taskLabels,
      });
    }
    runs.push({
      key: repository.key,
      commit: repository.commit,
      taskCount: repoTasks.length,
      labelCount: labels.length,
      startedAt,
      elapsedMs: Math.round(performance.now() - repoStarted),
      tasks: taskRuns,
    });
  }
  const taskRuns = runs.flatMap(
    (run) => (run as { tasks: { completed: boolean }[] }).tasks,
  );
  const labelRuns = runs.flatMap((run) =>
    (
      run as { tasks: { labels: { navigationComplete: boolean }[] }[] }
    ).tasks.flatMap((task) => task.labels),
  );
  const testedHeadSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const harnessWorkingTreeClean =
    execFileSync('git', ['status', '--short'], { encoding: 'utf8' }).trim() ===
    '';
  const output = {
    format: 'codethread-ct-realworld-001-navigation-baseline-v1',
    testedHeadSha,
    harnessWorkingTreeClean,
    method:
      'single-operator, scripted Git CLI navigation using git grep and git show at pinned commits',
    independentHumanStudy: false,
    labelsUsedForAnchorValidation: true,
    timingBoundary:
      'wall time for local Git grep/show commands and anchor checks; excludes human reading and comprehension time',
    baselineLimitation:
      'The frozen labels supply source and site anchors for lookup/scoring. This is a reproducible terminal navigation baseline, not an independent answer-generation or human productivity comparison.',
    taskBankSha256: sha256(taskBytes),
    repositoryManifestSha256: sha256(manifestBytes),
    gitCommandCount,
    tasksCompleted: taskRuns.filter((task) => task.completed).length,
    taskCount: taskRuns.length,
    navigationLabelsCompleted: labelRuns.filter(
      (label) => label.navigationComplete,
    ).length,
    labelCount: labelRuns.length,
    repositories: runs,
  };
  const serialized = JSON.stringify(output, null, 2) + '\n';
  if (process.env.CT_REALWORLD_OUTPUT_PATH)
    await writeFile(
      resolve(process.env.CT_REALWORLD_OUTPUT_PATH),
      serialized,
      'utf8',
    );
  if (process.env.CT_REALWORLD_QUIET !== '1') process.stdout.write(serialized);
  if (
    output.tasksCompleted !== output.taskCount ||
    output.navigationLabelsCompleted !== output.labelCount
  )
    process.exitCode = 1;
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
