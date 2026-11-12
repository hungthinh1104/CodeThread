import { lstat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveStudyScorerRevision, StudyCommandError } from './study.ts';
import {
  EXPECTED_REPOSITORY_SET_SHA256,
  EXPECTED_TASK_BANK_SHA256,
  loadFrozenPacket,
  parseJson,
  readRegularFile,
  RealworldStudyError,
  sha256,
  type FrozenPacket,
} from './realworld-study-packet.ts';

const MAX_LOCAL_ARTIFACT_BYTES = 8 * 1024 * 1024;
const SCORING_POLICY = {
  format: 'codethread-ct-realworld-001-score-policy-v1',
  taskBankSha256: EXPECTED_TASK_BANK_SHA256,
  repositorySetSha256: EXPECTED_REPOSITORY_SET_SHA256,
  constraints: [
    'independent-review-must-match-frozen-task-bank',
    'human-study-amendment-must-be-configured-before-participant-scoring',
    'static-source-relationships-do-not-imply-execution',
  ],
} as const;
const SCORING_POLICY_SHA256 = sha256(
  Buffer.from(JSON.stringify(SCORING_POLICY)),
);

const STUDY_SCORING_DISABLED_CODE = 'PARTICIPANT_PROTOCOL_NOT_CONFIGURED';

const REALWORLD_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

export interface RealworldStudyCommandOptions {
  repositoryRoot?: string;
  studyDataRoot?: string;
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return (
    path === '' ||
    (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
  );
}

async function assertNoSymlinkComponents(
  root: string,
  candidate: string,
): Promise<void> {
  const relativePath = relative(root, candidate);
  if (!isWithin(root, candidate)) {
    throw new RealworldStudyError('RESULT_FILE_OUTSIDE_LOCAL_STUDY_DATA');
  }
  let current = root;
  const segments = relativePath.split(/[\\/]/u).filter(Boolean);
  for (let index = -1; index < segments.length; index += 1) {
    if (index >= 0) current = resolve(current, segments[index]!);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink())
        throw new RealworldStudyError('LOCAL_STUDY_PATH_INVALID');
    } catch (error) {
      if (error instanceof RealworldStudyError) throw error;
      return;
    }
  }
}

async function loadLocalJson(
  root: string,
  path: string,
  missingCode: string,
  invalidCode: string,
): Promise<{ bytes: Buffer; value: Record<string, unknown> }> {
  await assertNoSymlinkComponents(root, path);
  const bytes = await readRegularFile(
    path,
    MAX_LOCAL_ARTIFACT_BYTES,
    missingCode,
    invalidCode,
    'LOCAL_STUDY_ARTIFACT_TOO_LARGE',
  );
  return { bytes, value: parseJson(bytes, invalidCode) };
}

function expectedTaskIds(tasks: Record<string, unknown>): string[] {
  return (tasks['tasks'] as Array<Record<string, unknown>>)
    .map((task) => task['id'] as string)
    .sort();
}

function verifyReviewPacketProvenance(
  review: Record<string, unknown>,
  packet: FrozenPacket,
): void {
  if (
    review['taskBankSha256'] !== packet.taskBankSha256 ||
    review['repositorySetSha256'] !== packet.repositorySetSha256 ||
    review['scoringPolicySha256'] !== SCORING_POLICY_SHA256
  ) {
    throw new RealworldStudyError('REVIEW_PROVENANCE_INVALID');
  }
}

function verifyReviewRecord(
  review: Record<string, unknown>,
  scorerRevision: string,
): void {
  if (review['scorerRevision'] !== scorerRevision) {
    throw new RealworldStudyError('REVIEW_PROVENANCE_INVALID');
  }
}

function validateReviewRecordShape(
  review: Record<string, unknown>,
  tasks: Record<string, unknown>,
): void {
  const reviewedTaskIds = review['reviewedTaskIds'];
  const validTaskIds =
    Array.isArray(reviewedTaskIds) &&
    reviewedTaskIds.length === 15 &&
    reviewedTaskIds.every((id) => typeof id === 'string') &&
    [...reviewedTaskIds].sort().join('\n') ===
      expectedTaskIds(tasks).join('\n');
  const reviewTime = review['reviewCompletedAt'];
  if (
    review['format'] !== 'codethread-ct-realworld-001-independent-review-v1' ||
    review['reviewerDidNotAuthorLabels'] !== true ||
    review['predictionsNotSeenBeforeAnswers'] !== true ||
    !validTaskIds ||
    typeof reviewTime !== 'string' ||
    !Number.isFinite(Date.parse(reviewTime)) ||
    !/^[0-9a-f]{64}$/.test(String(review['independentAnswersSha256'])) ||
    !/^[0-9a-f]{64}$/.test(String(review['adjudicationSha256']))
  ) {
    throw new RealworldStudyError('REVIEW_PROVENANCE_INVALID');
  }
}

async function verifyReviewArtifacts(
  root: string,
  review: Record<string, unknown>,
): Promise<void> {
  for (const [fileName, digestField] of [
    ['independent-answers.json', 'independentAnswersSha256'],
    ['adjudication.json', 'adjudicationSha256'],
  ] as const) {
    const artifactPath = resolve(root, fileName);
    await assertNoSymlinkComponents(root, artifactPath);
    let artifact: Buffer;
    try {
      artifact = await readRegularFile(
        artifactPath,
        MAX_LOCAL_ARTIFACT_BYTES,
        'REVIEW_PROVENANCE_INVALID',
        'REVIEW_PROVENANCE_INVALID',
        'REVIEW_PROVENANCE_INVALID',
      );
    } catch (error) {
      if (error instanceof RealworldStudyError) throw error;
      throw new RealworldStudyError('REVIEW_PROVENANCE_INVALID');
    }
    if (sha256(artifact) !== review[digestField]) {
      throw new RealworldStudyError('REVIEW_PROVENANCE_INVALID');
    }
    parseJson(artifact, 'REVIEW_PROVENANCE_INVALID');
  }
}

function scorerRevision(repositoryRoot: string): string {
  try {
    return resolveStudyScorerRevision(repositoryRoot);
  } catch (error) {
    if (error instanceof StudyCommandError) {
      throw new RealworldStudyError(error.code, error.details);
    }
    throw new RealworldStudyError('SCORER_REVISION_UNAVAILABLE');
  }
}

export async function runRealworldStudyCommand(
  args: readonly string[],
  options: RealworldStudyCommandOptions = {},
): Promise<object> {
  const normalized = args[0] === '--' ? args.slice(1) : args;
  const [command, ...rest] = normalized;
  if (!command || !['validate', 'provenance', 'score'].includes(command)) {
    throw new RealworldStudyError('USAGE', [
      'Use validate, provenance, or score <local-result-file>',
    ]);
  }
  if (command !== 'score' && rest.length !== 0) {
    throw new RealworldStudyError('USAGE', [`${command} takes no arguments`]);
  }
  if (command === 'score' && (rest.length !== 1 || !rest[0])) {
    throw new RealworldStudyError('USAGE', ['score requires one result file']);
  }

  const repositoryRoot = resolve(options.repositoryRoot ?? REALWORLD_ROOT);
  const studyDataRoot = resolve(
    options.studyDataRoot ??
      resolve(repositoryRoot, 'local-study-data/ct-realworld-001'),
  );
  const packet = await loadFrozenPacket(repositoryRoot);
  const repositories = (
    packet.repositories['externalRepositories'] as Array<
      Record<string, unknown>
    >
  )
    .map((repository) => repository['key'] as string)
    .sort();

  if (command === 'validate') {
    return {
      valid: true,
      taskCount: packet.taskCount,
      labelCounts: packet.labelCounts,
      repositories,
      taskBankSha256: packet.taskBankSha256,
      repositorySetSha256: packet.repositorySetSha256,
      independentReviewRequired: true,
      participantScoringReady: false,
    };
  }

  if (command === 'provenance') {
    const revision = scorerRevision(repositoryRoot);
    return {
      format: 'codethread-ct-realworld-001-scorer-provenance-v1',
      study: 'CT-REALWORLD-001',
      taskBankSha256: packet.taskBankSha256,
      repositorySetSha256: packet.repositorySetSha256,
      scorerRevision: revision,
      scoringPolicySha256: SCORING_POLICY_SHA256,
      participantScoringReady: false,
      staticFactsImplyExecution: false,
    };
  }

  const resultPathInput = rest[0]!;
  const resultPath = isAbsolute(resultPathInput)
    ? resolve(resultPathInput)
    : resolve(studyDataRoot, resultPathInput);
  if (!isWithin(studyDataRoot, resultPath) || resultPath === studyDataRoot) {
    throw new RealworldStudyError('RESULT_FILE_OUTSIDE_LOCAL_STUDY_DATA');
  }
  const reviewPath = resolve(studyDataRoot, 'independent-review.json');
  const loadedReview = await loadLocalJson(
    studyDataRoot,
    reviewPath,
    'REVIEW_PROVENANCE_MISSING',
    'REVIEW_PROVENANCE_INVALID',
  );
  validateReviewRecordShape(loadedReview.value, packet.tasks);
  verifyReviewPacketProvenance(loadedReview.value, packet);
  const revision = scorerRevision(repositoryRoot);
  verifyReviewRecord(loadedReview.value, revision);
  await verifyReviewArtifacts(studyDataRoot, loadedReview.value);

  // The approved amendment's scoring, consent, and retention terms have not
  // been supplied, so participant records must not be read or scored yet.
  throw new RealworldStudyError(STUDY_SCORING_DISABLED_CODE);
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const output = await runRealworldStudyCommand(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    const failure =
      error instanceof RealworldStudyError
        ? error
        : new RealworldStudyError('REALWORLD_STUDY_COMMAND_FAILED');
    process.stderr.write(
      `${JSON.stringify({ error: { code: failure.code, details: failure.details } })}\n`,
    );
    process.exitCode = failure.code === 'USAGE' ? 2 : 1;
  }
}
