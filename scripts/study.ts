import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  loadStudyTaskDataset,
  studyTaskDatasetSchema,
  validateStudyTaskDataset,
  type StudyTaskDataset,
} from './study-tasks.ts';
import {
  scoreStudyResults,
  StudyResultError,
  type StudyResultDataset,
} from './study-results.ts';

const MAX_RESULT_FILE_BYTES = 8 * 1024 * 1024;

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
    schemaVersion: 1,
    studyVersion: 'CT-EVAL-001A-v1',
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
  if (!command || !['validate', 'score', 'demo'].includes(command)) {
    throw new StudyCommandError('USAGE', [
      'Use validate, score <result-file>, or demo',
    ]);
  }
  if (command === 'validate' && rest.length !== 0) {
    throw new StudyCommandError('USAGE', ['validate takes no arguments']);
  }
  if (command === 'demo' && rest.length !== 0) {
    throw new StudyCommandError('USAGE', ['demo takes no arguments']);
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
  if (command === 'demo') {
    return {
      notice: 'SYNTHETIC DRY RUN — NOT EMPIRICAL DATA',
      report: scoreStudyResults(syntheticDemo(tasks), tasks),
    };
  }
  const input = await loadResultFile(rest[0]!);
  try {
    return scoreStudyResults(input, tasks);
  } catch (error) {
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
