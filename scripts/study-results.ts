import { z } from 'zod';
import {
  studyTaskDatasetSchema,
  type StudyCondition,
  type StudyTask,
  type StudyTaskDataset,
} from './study-tasks.ts';

const coordinateSchema = z.tuple([
  z.number().int().positive(),
  z.number().int().positive(),
]);
const sourceSpanSchema = z.strictObject({
  path: z.string().min(1).max(1024),
  start: coordinateSchema,
  end: coordinateSchema,
});
const declarationSpanSchema = sourceSpanSchema.extend({
  name: z.string().min(1).max(256),
  owner: z.string().min(1).max(256).optional(),
});
const resolutionSchema = z.enum([
  'exact',
  'unresolved',
  'ambiguous',
  'unsupported',
]);
const completionStatusSchema = z.enum([
  'completed',
  'partial',
  'timeout',
  'abandoned',
  'tool_failure',
  'missing',
  'unsupported_task',
]);
const toolFailureCodeSchema = z.enum([
  'INPUT_REJECTED',
  'ANALYSIS_FAILED',
  'QUERY_FAILED',
  'PRESENTATION_FAILED',
  'OTHER',
]);
const missingReasonCodeSchema = z.enum([
  'NOT_COLLECTED',
  'PARTICIPANT_DECLINED',
  'LOGGING_FAILURE',
  'OTHER',
]);
const unsupportedReasonCodeSchema = z.enum([
  'CAPABILITY_NOT_ANALYZED',
  'NO_EXACT_TARGET',
  'PARITY_FAILURE',
  'RESOURCE_LIMIT',
  'OTHER',
]);

const objectiveClaimSchema = z
  .strictObject({
    assertionId: z.string().regex(/^F[1-3]-A[1-9][0-9]*$/),
    kind: z.enum(['CALLS', 'REFERENCES']),
    status: resolutionSchema,
    site: sourceSpanSchema,
    target: declarationSpanSchema.nullable(),
  })
  .superRefine((claim, context) => {
    if ((claim.status === 'exact') !== (claim.target !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['target'],
        message: 'Only exact claims may name a target declaration',
      });
    }
  });

const evidenceReferenceSchema = z.strictObject({
  assertionId: z.string().regex(/^F[1-3]-A[1-9][0-9]*$/),
  role: z.enum(['site', 'target', 'candidate']),
  path: z.string().min(1).max(1024),
  start: coordinateSchema,
  end: coordinateSchema,
});

const studyResultRecordSchema = z
  .strictObject({
    participantToken: z.string().regex(/^P-[A-F0-9]{16}$/),
    taskId: z.string().regex(/^CTE-(?:F[1-3]|REJ)-[0-9]{3}$/),
    condition: z.enum(['ide', 'textual', 'visual']),
    taskOrder: z.number().int().positive().max(1000),
    durationMs: z
      .number()
      .finite()
      .int()
      .min(0)
      .max(24 * 60 * 60 * 1000)
      .nullable(),
    durationStatus: z.enum(['measured', 'censored', 'missing']),
    submittedAnswer: z.string().max(20000).nullable(),
    objectiveClaims: z.array(objectiveClaimSchema).max(100),
    evidenceReferences: z.array(evidenceReferenceSchema).max(300),
    additionalClaims: z.array(z.string().min(1).max(2048)).max(50),
    confidence: z.number().finite().int().min(1).max(5).nullable(),
    usabilityRating: z.number().finite().int().min(1).max(5).nullable(),
    completionStatus: completionStatusSchema,
    toolFailureCode: toolFailureCodeSchema.nullable(),
    missingReasonCode: missingReasonCodeSchema.nullable(),
    unsupportedReasonCode: unsupportedReasonCodeSchema.nullable(),
    humanScoringStatus: z.literal('AWAITING_HUMAN_SCORING'),
  })
  .superRefine((record, context) => {
    if (
      (record.durationStatus === 'missing') !==
      (record.durationMs === null)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['durationMs'],
        message:
          'Missing duration must be explicitly null; other duration states require milliseconds',
      });
    }
    if (
      record.completionStatus === 'timeout' &&
      record.durationStatus !== 'censored'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['durationStatus'],
        message: 'Timeout duration must be marked censored',
      });
    }
    if (
      record.durationStatus === 'censored' &&
      record.completionStatus !== 'timeout'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['durationStatus'],
        message: 'Only timeouts may use a censored duration',
      });
    }
    if (
      (record.completionStatus === 'tool_failure') !==
      (record.toolFailureCode !== null)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['toolFailureCode'],
        message:
          'Tool failures require a code and other outcomes must not carry one',
      });
    }
    if (
      (record.completionStatus === 'missing') !==
      (record.missingReasonCode !== null)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['missingReasonCode'],
        message: 'Missing results require an explicit missing-data reason',
      });
    }
    if (
      (record.completionStatus === 'unsupported_task') !==
      (record.unsupportedReasonCode !== null)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['unsupportedReasonCode'],
        message: 'Unsupported tasks require an explicit reason code',
      });
    }
    if (record.completionStatus === 'missing') {
      if (
        record.submittedAnswer !== null ||
        record.objectiveClaims.length > 0 ||
        record.evidenceReferences.length > 0 ||
        record.additionalClaims.length > 0 ||
        record.confidence !== null ||
        record.usabilityRating !== null
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Missing results cannot contain participant responses',
        });
      }
    }
    if (record.completionStatus === 'unsupported_task') {
      if (
        record.submittedAnswer !== null ||
        record.objectiveClaims.length > 0 ||
        record.evidenceReferences.length > 0 ||
        record.additionalClaims.length > 0 ||
        record.confidence !== null ||
        record.usabilityRating !== null
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'Unsupported tasks are recorded before collecting task answers',
        });
      }
    }
    const assertionIds = record.objectiveClaims.map(
      (claim) => claim.assertionId,
    );
    if (new Set(assertionIds).size !== assertionIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['objectiveClaims'],
        message: 'An assertion can be answered only once',
      });
    }
    const evidenceKeys = record.evidenceReferences.map(evidenceKey);
    if (new Set(evidenceKeys).size !== evidenceKeys.length) {
      context.addIssue({
        code: 'custom',
        path: ['evidenceReferences'],
        message: 'Duplicate evidence references are not allowed',
      });
    }
  });

export const studyResultDatasetSchema = z.strictObject({
  schemaVersion: z.literal(1),
  studyVersion: z.string().regex(/^CT-EVAL-001A-v[1-9][0-9]*$/),
  results: z.array(studyResultRecordSchema).max(1000),
});

export type StudyResultRecord = z.infer<typeof studyResultRecordSchema>;
export type StudyResultDataset = z.infer<typeof studyResultDatasetSchema>;

export type StudyScoreGroup = Readonly<{
  taskId: string;
  condition: StudyCondition;
  submissions: number;
  completionCounts: Readonly<
    Record<z.infer<typeof completionStatusSchema>, number>
  >;
  objectiveEarned: number;
  objectiveAvailable: number;
  objectiveAccuracy: number | null;
  falsePositiveExactClaims: number;
  missedExpectedAssertions: number;
  measuredDurationCount: number;
  meanMeasuredDurationMs: number | null;
  censoredTimeouts: number;
  confidenceCount: number;
  meanConfidence: number | null;
  usabilityRatingCounts: Readonly<{
    1: number;
    2: number;
    3: number;
    4: number;
    5: number;
  }>;
  awaitingHumanScoring: number;
}>;

export type StudyScoreReport = Readonly<{
  schemaVersion: 1;
  scoringPolicy: 'objective-source-anchors-v1';
  resultCount: number;
  groups: readonly StudyScoreGroup[];
  humanScoringStatus: 'AWAITING_HUMAN_SCORING';
  participantIdentifiersEmitted: false;
  submittedAnswersEmitted: false;
}>;

export class StudyResultError extends Error {
  readonly code: string;
  readonly details: readonly string[];

  constructor(code: string, details: readonly string[] = []) {
    super(code);
    this.name = 'StudyResultError';
    this.code = code;
    this.details = [...details];
  }
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function evidenceKey(
  reference: z.infer<typeof evidenceReferenceSchema>,
): string {
  return [
    reference.assertionId,
    reference.role,
    reference.path,
    reference.start.join(','),
    reference.end.join(','),
  ].join('|');
}

function spanKey(span: {
  path: string;
  start: readonly [number, number];
  end: readonly [number, number];
}): string {
  return `${span.path}|${span.start.join(',')}|${span.end.join(',')}`;
}

function targetKey(
  target: z.infer<typeof declarationSpanSchema> | null | undefined,
): string | null {
  return target
    ? `${spanKey(target)}|${target.name}|${target.owner ?? ''}`
    : null;
}

function expectedEvidence(task: StudyTask): Map<string, string> {
  const result = new Map<string, string>();
  for (const assertion of task.expectedAnswer?.assertions ?? []) {
    result.set(`${assertion.id}|site`, spanKey(assertion.site));
    if (assertion.target) {
      result.set(`${assertion.id}|target`, spanKey(assertion.target));
    }
    if (assertion.candidateSourceDeclaration) {
      result.set(
        `${assertion.id}|candidate`,
        spanKey(assertion.candidateSourceDeclaration),
      );
    }
  }
  return result;
}

function validateStudyResults(
  input: unknown,
  tasksInput: unknown,
): { results: StudyResultDataset; tasks: StudyTaskDataset } {
  const taskResult = studyTaskDatasetSchema.safeParse(tasksInput);
  if (!taskResult.success) {
    throw new StudyResultError(
      'INVALID_TASK_DATASET',
      taskResult.error.issues.map((entry) => entry.path.join('.')),
    );
  }
  const result = studyResultDatasetSchema.safeParse(input);
  if (!result.success) {
    throw new StudyResultError(
      'INVALID_STUDY_RESULTS',
      result.error.issues.map((entry) => entry.path.join('.')),
    );
  }
  const taskById = new Map(
    taskResult.data.tasks.map((task) => [task.id, task]),
  );
  const seenParticipantTasks = new Set<string>();
  const seenParticipantOrders = new Set<string>();
  for (const [index, record] of result.data.results.entries()) {
    const task = taskById.get(record.taskId);
    if (
      !task ||
      task.feasibility === 'REJECTED' ||
      task.expectedAnswer === null
    ) {
      throw new StudyResultError('TASK_NOT_SCORABLE', [
        `results.${index}.taskId`,
      ]);
    }
    if (!task.conditionEligibility.includes(record.condition)) {
      throw new StudyResultError('CONDITION_NOT_ELIGIBLE', [
        `results.${index}.condition`,
      ]);
    }
    const participantTask = `${record.participantToken}|${record.taskId}`;
    if (seenParticipantTasks.has(participantTask)) {
      throw new StudyResultError('DUPLICATE_RESULT_RECORD', [
        `results.${index}`,
      ]);
    }
    seenParticipantTasks.add(participantTask);
    const participantOrder = `${record.participantToken}|${record.taskOrder}`;
    if (seenParticipantOrders.has(participantOrder)) {
      throw new StudyResultError('DUPLICATE_TASK_ORDER', [
        `results.${index}.taskOrder`,
      ]);
    }
    seenParticipantOrders.add(participantOrder);

    const assertionIds = new Set(
      task.expectedAnswer.assertions.map((assertion) => assertion.id),
    );
    for (const claim of record.objectiveClaims) {
      if (!assertionIds.has(claim.assertionId)) {
        throw new StudyResultError('UNKNOWN_ASSERTION', [
          `results.${index}.objectiveClaims`,
        ]);
      }
    }
    const allowedEvidence = expectedEvidence(task);
    for (const reference of record.evidenceReferences) {
      const expected = allowedEvidence.get(
        `${reference.assertionId}|${reference.role}`,
      );
      if (!expected || expected !== spanKey(reference)) {
        throw new StudyResultError('EVIDENCE_REFERENCE_NOT_IN_TASK', [
          `results.${index}.evidenceReferences`,
        ]);
      }
    }
  }
  return { results: result.data, tasks: taskResult.data };
}

type MutableGroup = {
  taskId: string;
  condition: StudyCondition;
  submissions: number;
  completionCounts: Record<z.infer<typeof completionStatusSchema>, number>;
  objectiveEarned: number;
  objectiveAvailable: number;
  falsePositiveExactClaims: number;
  missedExpectedAssertions: number;
  durationTotal: number;
  measuredDurationCount: number;
  censoredTimeouts: number;
  confidenceTotal: number;
  confidenceCount: number;
  usabilityRatingCounts: Record<1 | 2 | 3 | 4 | 5, number>;
  awaitingHumanScoring: number;
};

function newGroup(taskId: string, condition: StudyCondition): MutableGroup {
  return {
    taskId,
    condition,
    submissions: 0,
    completionCounts: {
      completed: 0,
      partial: 0,
      timeout: 0,
      abandoned: 0,
      tool_failure: 0,
      missing: 0,
      unsupported_task: 0,
    },
    objectiveEarned: 0,
    objectiveAvailable: 0,
    falsePositiveExactClaims: 0,
    missedExpectedAssertions: 0,
    durationTotal: 0,
    measuredDurationCount: 0,
    censoredTimeouts: 0,
    confidenceTotal: 0,
    confidenceCount: 0,
    usabilityRatingCounts: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    awaitingHumanScoring: 0,
  };
}

function addRecordScore(
  group: MutableGroup,
  record: StudyResultRecord,
  task: StudyTask,
): void {
  group.submissions++;
  group.completionCounts[record.completionStatus]++;
  group.awaitingHumanScoring++;
  if (record.durationStatus === 'measured' && record.durationMs !== null) {
    group.durationTotal += record.durationMs;
    group.measuredDurationCount++;
  }
  if (record.durationStatus === 'censored') group.censoredTimeouts++;
  if (record.confidence !== null) {
    group.confidenceTotal += record.confidence;
    group.confidenceCount++;
  }
  switch (record.usabilityRating) {
    case 1:
      group.usabilityRatingCounts[1]++;
      break;
    case 2:
      group.usabilityRatingCounts[2]++;
      break;
    case 3:
      group.usabilityRatingCounts[3]++;
      break;
    case 4:
      group.usabilityRatingCounts[4]++;
      break;
    case 5:
      group.usabilityRatingCounts[5]++;
      break;
  }
  if (record.completionStatus === 'unsupported_task') return;

  const claims = new Map(
    record.objectiveClaims.map((claim) => [claim.assertionId, claim]),
  );
  const references = new Set(record.evidenceReferences.map(evidenceKey));
  for (const assertion of task.expectedAnswer?.assertions ?? []) {
    const claim = claims.get(assertion.id);
    const expectedStatus = assertion.status ?? 'exact';
    const occurrenceCorrect =
      claim !== undefined &&
      claim.kind === assertion.kind &&
      spanKey(claim.site) === spanKey(assertion.site);
    const conclusionCorrect =
      claim !== undefined &&
      claim.status === expectedStatus &&
      (expectedStatus === 'exact'
        ? targetKey(claim.target) === targetKey(assertion.target)
        : claim.target === null);
    group.objectiveAvailable += 2;
    if (occurrenceCorrect) group.objectiveEarned++;
    if (conclusionCorrect) group.objectiveEarned++;
    if (!occurrenceCorrect || !conclusionCorrect)
      group.missedExpectedAssertions++;
    if (
      claim?.status === 'exact' &&
      (!occurrenceCorrect ||
        targetKey(claim.target) !== targetKey(assertion.target))
    ) {
      group.falsePositiveExactClaims++;
    }
    for (const [role, span] of [
      ['site', assertion.site],
      ...(assertion.target ? [['target', assertion.target] as const] : []),
      ...(assertion.candidateSourceDeclaration
        ? [['candidate', assertion.candidateSourceDeclaration] as const]
        : []),
    ] as const) {
      group.objectiveAvailable++;
      const reference: z.infer<typeof evidenceReferenceSchema> = {
        assertionId: assertion.id,
        role,
        ...span,
      };
      if (references.has(evidenceKey(reference))) group.objectiveEarned++;
    }
  }
}

function conditionOrder(condition: StudyCondition): number {
  return condition === 'ide' ? 0 : condition === 'textual' ? 1 : 2;
}

export function scoreStudyResults(
  input: unknown,
  tasksInput: unknown,
): StudyScoreReport {
  const { results, tasks } = validateStudyResults(input, tasksInput);
  const taskById = new Map(tasks.tasks.map((task) => [task.id, task]));
  const groups = new Map<string, MutableGroup>();
  for (const record of results.results) {
    const key = `${record.taskId}|${record.condition}`;
    let group = groups.get(key);
    if (!group) {
      group = newGroup(record.taskId, record.condition);
      groups.set(key, group);
    }
    const task = taskById.get(record.taskId)!;
    addRecordScore(group, record, task);
  }
  const sorted = [...groups.values()].sort(
    (left, right) =>
      compare(left.taskId, right.taskId) ||
      conditionOrder(left.condition) - conditionOrder(right.condition),
  );
  return {
    schemaVersion: 1,
    scoringPolicy: 'objective-source-anchors-v1',
    resultCount: results.results.length,
    groups: sorted.map((group) => ({
      taskId: group.taskId,
      condition: group.condition,
      submissions: group.submissions,
      completionCounts: group.completionCounts,
      objectiveEarned: group.objectiveEarned,
      objectiveAvailable: group.objectiveAvailable,
      objectiveAccuracy:
        group.objectiveAvailable > 0
          ? group.objectiveEarned / group.objectiveAvailable
          : null,
      falsePositiveExactClaims: group.falsePositiveExactClaims,
      missedExpectedAssertions: group.missedExpectedAssertions,
      measuredDurationCount: group.measuredDurationCount,
      meanMeasuredDurationMs:
        group.measuredDurationCount > 0
          ? group.durationTotal / group.measuredDurationCount
          : null,
      censoredTimeouts: group.censoredTimeouts,
      confidenceCount: group.confidenceCount,
      meanConfidence:
        group.confidenceCount > 0
          ? group.confidenceTotal / group.confidenceCount
          : null,
      usabilityRatingCounts: group.usabilityRatingCounts,
      awaitingHumanScoring: group.awaitingHumanScoring,
    })),
    humanScoringStatus: 'AWAITING_HUMAN_SCORING',
    participantIdentifiersEmitted: false,
    submittedAnswersEmitted: false,
  };
}
