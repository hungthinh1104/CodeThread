import { spawnSync } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  loadStudyTaskDataset,
  studyTaskDatasetSchema,
  validateStudyTaskDataset,
  type StudyTaskDataset,
} from './study-tasks.ts';
import {
  createStudyResultProvenance,
  scoreStudyResults,
  scoreSyntheticStudyResults,
  STUDY_RESULT_SCHEMA_VERSION,
  STUDY_VERSION,
  SYNTHETIC_SCORER_REVISION,
  StudyResultError,
  type StudyResultDataset,
} from './study-results.ts';

const MAX_RESULT_FILE_BYTES = 8 * 1024 * 1024;
const STUDY_REPOSITORY_ROOT = resolve(
  fileURLToPath(new URL('..', import.meta.url)),
);

export class StudyCommandError extends Error {
  readonly code: string;
  readonly details: readonly unknown[];

  constructor(code: string, details: readonly unknown[] = []) {
    super(code);
    this.name = 'StudyCommandError';
    this.code = code;
    this.details = details;
  }
}

export function resolveStudyScorerRevision(
  repositoryRoot = STUDY_REPOSITORY_ROOT,
): string {
  const env = { ...process.env };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_CONFIG_PARAMETERS',
    'GIT_CONFIG_COUNT',
    'GIT_NAMESPACE',
    'GIT_PREFIX',
    'GIT_CEILING_DIRECTORIES',
    'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  ]) {
    delete env[key];
  }
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_TRACE')) delete env[key];
  }
  env['GIT_OPTIONAL_LOCKS'] = '0';
  env['GIT_NO_REPLACE_OBJECTS'] = '1';
  env['GIT_TERMINAL_PROMPT'] = '0';
  env['GIT_CONFIG_NOSYSTEM'] = '1';
  env['GIT_CONFIG_GLOBAL'] = process.platform === 'win32' ? 'NUL' : '/dev/null';

  const gitPrefix = [
    '--no-optional-locks',
    '-C',
    repositoryRoot,
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.untrackedCache=false',
    '-c',
    'core.excludesFile=',
  ];
  const options = {
    cwd: repositoryRoot,
    encoding: 'utf8' as const,
    env,
    maxBuffer: 64 * 1024,
    timeout: 5000,
    windowsHide: true,
  };
  const revision = spawnSync(
    'git',
    [...gitPrefix, 'rev-parse', '--verify', 'HEAD^{commit}'],
    options,
  );
  if (revision.error || revision.status !== 0) {
    throw new StudyCommandError('SCORER_REVISION_UNAVAILABLE');
  }
  const rootRelativePath = spawnSync(
    'git',
    [...gitPrefix, 'rev-parse', '--show-cdup'],
    options,
  );
  if (
    rootRelativePath.error ||
    rootRelativePath.status !== 0 ||
    rootRelativePath.stdout.trim() !== ''
  ) {
    throw new StudyCommandError('SCORER_REPOSITORY_ROOT_INVALID');
  }
  const scorerRevision = revision.stdout.trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(scorerRevision)) {
    throw new StudyCommandError('SCORER_REVISION_INVALID');
  }

  const status = spawnSync(
    'git',
    [...gitPrefix, 'status', '--porcelain=v1', '--untracked-files=all'],
    options,
  );
  if (status.error || status.status !== 0) {
    throw new StudyCommandError('SCORER_WORKTREE_STATUS_UNAVAILABLE');
  }
  if (status.stdout.length > 0) {
    throw new StudyCommandError('SCORER_WORKTREE_DIRTY');
  }

  const indexEntries = spawnSync(
    'git',
    [...gitPrefix, 'ls-files', '-v', '-z'],
    options,
  );
  if (indexEntries.error || indexEntries.status !== 0) {
    throw new StudyCommandError('SCORER_INDEX_STATE_UNAVAILABLE');
  }
  // `git status` can hide tracked edits behind assume-unchanged or skip-worktree.
  if (
    indexEntries.stdout
      .split('\0')
      .some((entry) => entry.length > 0 && entry[0] !== 'H')
  ) {
    throw new StudyCommandError('SCORER_WORKTREE_DIRTY');
  }
  return scorerRevision;
}

async function loadResultFile(path: string): Promise<unknown> {
  const absolutePath = resolve(process.cwd(), path);
  let stat;
  try {
    stat = await lstat(absolutePath);
  } catch {
    throw new StudyCommandError('RESULT_FILE_UNAVAILABLE');
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new StudyCommandError('RESULT_FILE_INVALID');
  }
  if (stat.size > MAX_RESULT_FILE_BYTES) {
    throw new StudyCommandError('RESULT_FILE_TOO_LARGE');
  }
  let text: string;
  try {
    const bytes = await readFile(absolutePath);
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new StudyCommandError('RESULT_FILE_INVALID_ENCODING');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new StudyCommandError('RESULT_FILE_INVALID_JSON');
  }
}

function syntheticDemo(tasks: StudyTaskDataset): StudyResultDataset {
  const task = tasks.tasks.find((candidate) => candidate.id === 'CTE-F2-001');
  if (!task?.expectedAnswer)
    throw new StudyCommandError('DEMO_TASK_UNAVAILABLE');
  const objectiveClaims = task.expectedAnswer.assertions.map((assertion) => ({
    assertionId: assertion.id,
    kind: assertion.kind,
    status: assertion.status ?? 'exact',
    site: assertion.site,
    target: assertion.target ?? null,
  }));
  const evidenceReferences = task.expectedAnswer.assertions.flatMap(
    (assertion) => [
      {
        assertionId: assertion.id,
        role: 'site' as const,
        ...assertion.site,
      },
      ...(assertion.target
        ? [
            {
              assertionId: assertion.id,
              role: 'target' as const,
              path: assertion.target.path,
              start: assertion.target.start,
              end: assertion.target.end,
            },
          ]
        : []),
      ...(assertion.candidateSourceDeclaration
        ? [
            {
              assertionId: assertion.id,
              role: 'candidate' as const,
              path: assertion.candidateSourceDeclaration.path,
              start: assertion.candidateSourceDeclaration.start,
              end: assertion.candidateSourceDeclaration.end,
            },
          ]
        : []),
    ],
  );
  return {
    schemaVersion: STUDY_RESULT_SCHEMA_VERSION,
    studyVersion: STUDY_VERSION,
    provenance: createStudyResultProvenance(tasks, SYNTHETIC_SCORER_REVISION),
    results: [
      {
        participantToken: 'P-0000000000000000',
        taskId: task.id,
        condition: 'textual',
        taskOrder: 1,
        durationMs: 120000,
        durationStatus: 'measured',
        submittedAnswer: 'Synthetic demonstration only.',
        objectiveClaims,
        evidenceReferences,
        additionalClaims: [],
        confidence: 4,
        usabilityRating: 4,
        completionStatus: 'completed',
        toolFailureCode: null,
        missingReasonCode: null,
        unsupportedReasonCode: null,
        humanScoringStatus: 'AWAITING_HUMAN_SCORING',
      },
    ],
  };
}

export async function runStudyCommand(
  args: readonly string[],
): Promise<object> {
  const normalized = args[0] === '--' ? args.slice(1) : args;
  const [command, ...rest] = normalized;
  if (
    !command ||
    !['validate', 'provenance', 'score', 'demo'].includes(command)
  ) {
    throw new StudyCommandError('USAGE', [
      'Use validate, provenance, score <result-file>, or demo',
    ]);
  }
  if (command === 'validate' && rest.length !== 0) {
    throw new StudyCommandError('USAGE', ['validate takes no arguments']);
  }
  if (command === 'demo' && rest.length !== 0) {
    throw new StudyCommandError('USAGE', ['demo takes no arguments']);
  }
  if (command === 'provenance' && rest.length !== 0) {
    throw new StudyCommandError('USAGE', ['provenance takes no arguments']);
  }
  if (command === 'score' && (rest.length !== 1 || !rest[0])) {
    throw new StudyCommandError('USAGE', ['score requires one result file']);
  }

  const taskInput = await loadStudyTaskDataset();
  const validation = await validateStudyTaskDataset(taskInput);
  if (!validation.valid) {
    throw new StudyCommandError('TASK_DATASET_INVALID', validation.errors);
  }
  const parsedTasks = studyTaskDatasetSchema.safeParse(taskInput);
  if (!parsedTasks.success) throw new StudyCommandError('TASK_DATASET_INVALID');
  const tasks = parsedTasks.data;

  if (command === 'validate') return validation;
  if (command === 'provenance') {
    return {
      schemaVersion: STUDY_RESULT_SCHEMA_VERSION,
      studyVersion: STUDY_VERSION,
      provenance: createStudyResultProvenance(
        tasks,
        resolveStudyScorerRevision(),
      ),
    };
  }
  if (command === 'demo') {
    return {
      notice: 'SYNTHETIC DRY RUN — NOT EMPIRICAL DATA',
      report: scoreSyntheticStudyResults(
        syntheticDemo(tasks),
        tasks,
        SYNTHETIC_SCORER_REVISION,
      ),
    };
  }
  const input = await loadResultFile(rest[0]!);
  try {
    return scoreStudyResults(input, tasks, resolveStudyScorerRevision());
  } catch (error) {
    if (error instanceof StudyCommandError) throw error;
    if (error instanceof StudyResultError) {
      throw new StudyCommandError(error.code, error.details);
    }
    throw new StudyCommandError('STUDY_SCORING_FAILED');
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const output = await runStudyCommand(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    const failure =
      error instanceof StudyCommandError
        ? error
        : new StudyCommandError('STUDY_COMMAND_FAILED');
    process.stderr.write(
      `${JSON.stringify({ error: { code: failure.code, details: failure.details } })}\n`,
    );
    process.exitCode = failure.code === 'USAGE' ? 2 : 1;
  }
}
