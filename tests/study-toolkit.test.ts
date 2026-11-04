import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateStudyTaskDataset } from '../scripts/study-tasks.ts';
import {
  scoreStudyResults,
  StudyResultError,
} from '../scripts/study-results.ts';
import { runStudyCommand } from '../scripts/study.ts';

const taskPath = resolve('docs/evaluation/tasks.json');
const repositoryRoot = process.cwd();

function readTaskDataset(): Record<string, unknown> {
  return JSON.parse(readFileSync(taskPath, 'utf8')) as Record<string, unknown>;
}

function syntheticF2Result(): Record<string, unknown> {
  const dataset = readTaskDataset();
  const tasks = dataset['tasks'] as Array<Record<string, unknown>>;
  const task = tasks.find((candidate) => candidate['id'] === 'CTE-F2-001')!;
  const expectedAnswer = task['expectedAnswer'] as Record<string, unknown>;
  const assertions = expectedAnswer['assertions'] as Array<
    Record<string, unknown>
  >;
  const objectiveClaims = assertions.map((assertion) => ({
    assertionId: assertion['id'],
    kind: assertion['kind'],
    status: assertion['status'] ?? 'exact',
    site: assertion['site'],
    target: assertion['target'] ?? null,
  }));
  const evidenceReferences = assertions.flatMap((assertion) => {
    const site = assertion['site'] as Record<string, unknown>;
    const siteReference = {
      assertionId: assertion['id'],
      role: 'site',
      ...site,
    };
    const target = assertion['target'] as Record<string, unknown> | undefined;
    const candidate = assertion['candidateSourceDeclaration'] as
      Record<string, unknown> | undefined;
    const declaration = target ?? candidate;
    return [
      siteReference,
      ...(declaration
        ? [
            {
              assertionId: assertion['id'],
              role: target ? 'target' : 'candidate',
              path: declaration['path'],
              start: declaration['start'],
              end: declaration['end'],
            },
          ]
        : []),
    ];
  });
  return {
    schemaVersion: 1,
    studyVersion: 'CT-EVAL-001A-v1',
    results: [
      {
        participantToken: 'P-0123456789ABCDEF',
        taskId: 'CTE-F2-001',
        condition: 'textual',
        taskOrder: 1,
        durationMs: 120000,
        durationStatus: 'measured',
        submittedAnswer: 'Synthetic test answer; not participant data.',
        objectiveClaims,
        evidenceReferences,
        additionalClaims: [],
        confidence: null,
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

describe('CT-EVAL-001A offline study task validation', () => {
  it('validates all candidate and rejected task records against pinned bytes and anchors', async () => {
    const result = await validateStudyTaskDataset(readTaskDataset(), {
      repositoryRoot,
    });

    expect(result).toEqual({ valid: true, taskCount: 5, errors: [] });
  });

  it('rejects a source hash that does not match the pinned fixture bytes', async () => {
    const dataset = readTaskDataset();
    const tasks = dataset['tasks'] as Array<Record<string, unknown>>;
    const firstTask = tasks[0]!;
    const source = firstTask['source'] as Record<string, unknown>;
    const selectedFiles = source['selectedFiles'] as Array<
      Record<string, unknown>
    >;
    selectedFiles[0]!['sha256'] = '0'.repeat(64);

    const result = await validateStudyTaskDataset(dataset, { repositoryRoot });

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual({
      code: 'SOURCE_HASH_MISMATCH',
      taskId: 'CTE-F1-001',
      path: 'routes/index.ts',
    });
  });

  it('rejects a source anchor outside the selected file', async () => {
    const dataset = readTaskDataset();
    const tasks = dataset['tasks'] as Array<Record<string, unknown>>;
    const firstTask = tasks[0]!;
    const answer = firstTask['expectedAnswer'] as Record<string, unknown>;
    const assertions = answer['assertions'] as Array<Record<string, unknown>>;
    const site = assertions[0]!['site'] as Record<string, unknown>;
    site['start'] = [999, 1];

    const result = await validateStudyTaskDataset(dataset, { repositoryRoot });

    expect(result.errors).toContainEqual({
      code: 'SOURCE_EVIDENCE_MISMATCH',
      taskId: 'CTE-F1-001',
      path: 'routes/index.ts',
    });
  });

  it('returns a structured error for a mismatched anchor on the last source line', async () => {
    const dataset = readTaskDataset();
    const tasks = dataset['tasks'] as Array<Record<string, unknown>>;
    const rejectedTask = tasks[3]!;
    const source = rejectedTask['source'] as Record<string, unknown>;
    const selectedFiles = source['selectedFiles'] as Array<
      Record<string, unknown>
    >;
    const fixturePath = selectedFiles[0]!['fixturePath'] as string;
    const sourceText = readFileSync(
      resolve(repositoryRoot, fixturePath),
      'utf8',
    );
    const lastLine = sourceText.split(/\r\n|\r|\n|\u2028|\u2029/u).length;
    const anchors = rejectedTask['sourceAnchors'] as Array<
      Record<string, unknown>
    >;
    anchors[0]!['line'] = lastLine;
    anchors[0]!['text'] = 'not the source line';

    const result = await validateStudyTaskDataset(dataset, { repositoryRoot });

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual({
      code: 'SOURCE_EVIDENCE_MISMATCH',
      taskId: 'CTE-REJ-001',
      path: 'routes/todo.router.ts',
    });
  });

  it('rejects relationship kinds that conflict with the task family', async () => {
    const dataset = readTaskDataset();
    const tasks = dataset['tasks'] as Array<Record<string, unknown>>;
    const firstTask = tasks[0]!;
    const answer = firstTask['expectedAnswer'] as Record<string, unknown>;
    const assertions = answer['assertions'] as Array<Record<string, unknown>>;
    assertions[0]!['kind'] = 'REFERENCES';

    const result = await validateStudyTaskDataset(dataset, { repositoryRoot });

    expect(result.errors).toContainEqual({
      code: 'RELATION_KIND_MISMATCH',
      taskId: 'CTE-F1-001',
      path: 'routes/index.ts',
    });
  });

  it('rejects duplicate IDs and conflicting task definitions', async () => {
    const duplicateId = readTaskDataset();
    const tasks = duplicateId['tasks'] as Array<Record<string, unknown>>;
    tasks[1]!['id'] = tasks[0]!['id'];
    const duplicateReport = await validateStudyTaskDataset(duplicateId, {
      repositoryRoot,
    });
    expect(duplicateReport.errors).toContainEqual({
      code: 'DUPLICATE_TASK_ID',
      taskId: 'CTE-F1-001',
    });

    const duplicateDefinition = readTaskDataset();
    const duplicateDefinitionTasks = duplicateDefinition['tasks'] as Array<
      Record<string, unknown>
    >;
    const repeatedTask = structuredClone(duplicateDefinitionTasks[0]!);
    repeatedTask['id'] = 'CTE-F1-002';
    duplicateDefinitionTasks.push(repeatedTask);
    const repeatedReport = await validateStudyTaskDataset(duplicateDefinition, {
      repositoryRoot,
    });
    expect(repeatedReport.errors).toContainEqual({
      code: 'DUPLICATE_TASK_DEFINITION',
      taskId: 'CTE-F1-002',
    });

    const conflicting = readTaskDataset();
    const conflictingTasks = conflicting['tasks'] as Array<
      Record<string, unknown>
    >;
    const sourceTask = structuredClone(conflictingTasks[0]!);
    sourceTask['id'] = 'CTE-F1-002';
    const answer = sourceTask['expectedAnswer'] as Record<string, unknown>;
    answer['summary'] = 'Conflicting expected answer';
    conflictingTasks.push(sourceTask);

    const conflictReport = await validateStudyTaskDataset(conflicting, {
      repositoryRoot,
    });
    expect(conflictReport.errors).toContainEqual({
      code: 'CONFLICTING_TASK_DEFINITION',
      taskId: 'CTE-F1-002',
    });
  });

  it('rejects missing fixture bytes rather than accepting a partial task bank', async () => {
    const dataset = readTaskDataset();
    const tasks = dataset['tasks'] as Array<Record<string, unknown>>;
    const source = tasks[0]!['source'] as Record<string, unknown>;
    const selectedFiles = source['selectedFiles'] as Array<
      Record<string, unknown>
    >;
    selectedFiles[0]!['fixturePath'] = 'fixtures/external/todo/missing.ts';

    const result = await validateStudyTaskDataset(dataset, { repositoryRoot });

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual({
      code: 'SOURCE_FILE_MISSING',
      taskId: 'CTE-F1-001',
      path: 'routes/index.ts',
    });
  });

  it('rejects traversal fixture paths and unsupported expected exact targets', async () => {
    const unsafePath = readTaskDataset();
    const tasks = unsafePath['tasks'] as Array<Record<string, unknown>>;
    const source = tasks[0]!['source'] as Record<string, unknown>;
    const files = source['selectedFiles'] as Array<Record<string, unknown>>;
    files[0]!['fixturePath'] = '../../package.json';
    const unsafeReport = await validateStudyTaskDataset(unsafePath, {
      repositoryRoot,
    });
    expect(
      unsafeReport.errors.some((entry) => entry.code === 'TASK_SCHEMA_INVALID'),
    ).toBe(true);

    const unsupportedTarget = readTaskDataset();
    const unsupportedTasks = unsupportedTarget['tasks'] as Array<
      Record<string, unknown>
    >;
    const f3Answer = unsupportedTasks[2]!['expectedAnswer'] as Record<
      string,
      unknown
    >;
    const assertions = f3Answer['assertions'] as Array<Record<string, unknown>>;
    assertions[1]!['status'] = 'unsupported';
    assertions[1]!['target'] = assertions[1]!['candidateSourceDeclaration'];
    const unsupportedReport = await validateStudyTaskDataset(
      unsupportedTarget,
      {
        repositoryRoot,
      },
    );
    expect(
      unsupportedReport.errors.some(
        (entry) => entry.code === 'TASK_SCHEMA_INVALID',
      ),
    ).toBe(true);
  });

  it('rejects a rejected task assigned to a study condition', async () => {
    const dataset = readTaskDataset();
    const tasks = dataset['tasks'] as Array<Record<string, unknown>>;
    tasks[3]!['conditionEligibility'] = ['visual'];

    const result = await validateStudyTaskDataset(dataset, { repositoryRoot });

    expect(
      result.errors.some((entry) => entry.code === 'TASK_SCHEMA_INVALID'),
    ).toBe(true);
  });

  it('rejects a candidate task with no allowed study condition', async () => {
    const dataset = readTaskDataset();
    const tasks = dataset['tasks'] as Array<Record<string, unknown>>;
    tasks[0]!['conditionEligibility'] = [];

    const result = await validateStudyTaskDataset(dataset, { repositoryRoot });

    expect(
      result.errors.some((entry) => entry.code === 'TASK_SCHEMA_INVALID'),
    ).toBe(true);
  });

  it('rejects missing source evidence and parity claims that contradict feasibility', async () => {
    const missingEvidence = readTaskDataset();
    const tasks = missingEvidence['tasks'] as Array<Record<string, unknown>>;
    const task = tasks[1]!;
    const source = task['source'] as Record<string, unknown>;
    const files = source['selectedFiles'] as Array<Record<string, unknown>>;
    files.pop();
    const evidenceReport = await validateStudyTaskDataset(missingEvidence, {
      repositoryRoot,
    });
    expect(evidenceReport.errors).toContainEqual({
      code: 'EVIDENCE_FILE_NOT_SELECTED',
      taskId: 'CTE-F2-001',
      path: 'controllers/todo.controller.ts',
    });

    const mismatch = readTaskDataset();
    const mismatchTasks = mismatch['tasks'] as Array<Record<string, unknown>>;
    mismatchTasks[0]!['informationParity'] = 'PARITY_VERIFIED';
    const parityReport = await validateStudyTaskDataset(mismatch, {
      repositoryRoot,
    });
    expect(
      parityReport.errors.some((entry) => entry.code === 'TASK_SCHEMA_INVALID'),
    ).toBe(true);
  });

  it('scores exact source-pinned claims without scoring free text', () => {
    const report = scoreStudyResults(
      syntheticF2Result(),
      JSON.parse(readFileSync(taskPath, 'utf8')),
    );

    expect(report.groups).toMatchObject([
      {
        taskId: 'CTE-F2-001',
        condition: 'textual',
        objectiveEarned: 12,
        objectiveAvailable: 12,
        objectiveAccuracy: 1,
        usabilityRatingCounts: { 4: 1 },
        awaitingHumanScoring: 1,
      },
    ]);
    expect(JSON.stringify(report)).not.toContain('P-0123456789ABCDEF');
    expect(JSON.stringify(report)).not.toContain('Synthetic test answer');

    const lowUsabilityRating = syntheticF2Result();
    const records = lowUsabilityRating['results'] as Array<
      Record<string, unknown>
    >;
    records[0]!['usabilityRating'] = 1;
    const lowRatingReport = scoreStudyResults(
      lowUsabilityRating,
      readTaskDataset(),
    );
    expect(lowRatingReport.groups[0]).toMatchObject({
      objectiveEarned: report.groups[0]!.objectiveEarned,
      objectiveAvailable: report.groups[0]!.objectiveAvailable,
      usabilityRatingCounts: { 1: 1 },
    });
  });

  it('counts a wrong exact target as both an incorrect exact claim and a missed answer', () => {
    const input = syntheticF2Result();
    const results = input['results'] as Array<Record<string, unknown>>;
    const claims = results[0]!['objectiveClaims'] as Array<
      Record<string, unknown>
    >;
    const firstTarget = claims[0]!['target'] as Record<string, unknown>;
    claims[0]!['target'] = { ...firstTarget, name: 'differentMethod' };

    const report = scoreStudyResults(
      input,
      JSON.parse(readFileSync(taskPath, 'utf8')),
    );

    expect(report.groups[0]).toMatchObject({
      falsePositiveExactClaims: 1,
      missedExpectedAssertions: 1,
      objectiveEarned: 11,
      objectiveAvailable: 12,
    });
  });

  it('gives partial credit only for submitted, source-checkable components', () => {
    const input = syntheticF2Result();
    const results = input['results'] as Array<Record<string, unknown>>;
    const record = results[0]!;
    record['completionStatus'] = 'partial';
    const claims = record['objectiveClaims'] as Array<Record<string, unknown>>;
    record['objectiveClaims'] = [claims[0]!];
    const references = record['evidenceReferences'] as Array<
      Record<string, unknown>
    >;
    record['evidenceReferences'] = references.filter(
      (reference) => reference['assertionId'] === 'F2-A1',
    );

    const report = scoreStudyResults(input, readTaskDataset());

    expect(report.groups[0]).toMatchObject({
      objectiveEarned: 4,
      objectiveAvailable: 12,
      missedExpectedAssertions: 2,
      completionCounts: { partial: 1 },
    });
  });

  it('records timeout duration as censored and leaves no human score behind', () => {
    const input = syntheticF2Result();
    const results = input['results'] as Array<Record<string, unknown>>;
    results[0]!['completionStatus'] = 'timeout';
    results[0]!['durationStatus'] = 'censored';

    const report = scoreStudyResults(input, readTaskDataset());

    expect(report.groups[0]).toMatchObject({
      censoredTimeouts: 1,
      completionCounts: { timeout: 1 },
      awaitingHumanScoring: 1,
    });
    expect(report.humanScoringStatus).toBe('AWAITING_HUMAN_SCORING');
  });

  it('records missing responses separately and awards no objective points', () => {
    const input = syntheticF2Result();
    const record = (input['results'] as Array<Record<string, unknown>>)[0]!;
    record['durationMs'] = null;
    record['durationStatus'] = 'missing';
    record['submittedAnswer'] = null;
    record['objectiveClaims'] = [];
    record['evidenceReferences'] = [];
    record['additionalClaims'] = [];
    record['confidence'] = null;
    record['usabilityRating'] = null;
    record['completionStatus'] = 'missing';
    record['missingReasonCode'] = 'NOT_COLLECTED';

    const report = scoreStudyResults(input, readTaskDataset());

    expect(report.groups[0]).toMatchObject({
      completionCounts: { missing: 1 },
      objectiveEarned: 0,
      objectiveAvailable: 12,
    });
  });

  it('reports unsupported tasks separately from participant correctness', () => {
    const input = syntheticF2Result();
    const record = (input['results'] as Array<Record<string, unknown>>)[0]!;
    record['durationMs'] = null;
    record['durationStatus'] = 'missing';
    record['submittedAnswer'] = null;
    record['objectiveClaims'] = [];
    record['evidenceReferences'] = [];
    record['additionalClaims'] = [];
    record['confidence'] = null;
    record['usabilityRating'] = null;
    record['completionStatus'] = 'unsupported_task';
    record['unsupportedReasonCode'] = 'CAPABILITY_NOT_ANALYZED';

    const report = scoreStudyResults(input, readTaskDataset());

    expect(report.groups[0]).toMatchObject({
      completionCounts: { unsupported_task: 1 },
      objectiveEarned: 0,
      objectiveAvailable: 0,
    });
  });

  it('rejects missing confidence or usability and invalid durations or evidence', () => {
    const withoutConfidence = syntheticF2Result();
    const missingRecord = (
      withoutConfidence['results'] as Array<Record<string, unknown>>
    )[0]!;
    delete missingRecord['confidence'];
    expect(() =>
      scoreStudyResults(withoutConfidence, readTaskDataset()),
    ).toThrow(StudyResultError);

    const withoutUsabilityRating = syntheticF2Result();
    delete (
      withoutUsabilityRating['results'] as Array<Record<string, unknown>>
    )[0]!['usabilityRating'];
    expect(() =>
      scoreStudyResults(withoutUsabilityRating, readTaskDataset()),
    ).toThrow(StudyResultError);

    for (const usabilityRating of [0, 6, 2.5]) {
      const invalidUsability = syntheticF2Result();
      const invalidRecord = (
        invalidUsability['results'] as Array<Record<string, unknown>>
      )[0]!;
      invalidRecord['usabilityRating'] = usabilityRating;
      expect(() =>
        scoreStudyResults(invalidUsability, readTaskDataset()),
      ).toThrow(StudyResultError);
    }

    for (const durationMs of [Number.NaN, -1, 24 * 60 * 60 * 1000 + 1]) {
      const invalidDuration = syntheticF2Result();
      const record = (
        invalidDuration['results'] as Array<Record<string, unknown>>
      )[0]!;
      record['durationMs'] = durationMs;
      expect(() =>
        scoreStudyResults(invalidDuration, readTaskDataset()),
      ).toThrow(StudyResultError);
    }

    const invalidEvidence = syntheticF2Result();
    const invalidRecord = (
      invalidEvidence['results'] as Array<Record<string, unknown>>
    )[0]!;
    const references = invalidRecord['evidenceReferences'] as Array<
      Record<string, unknown>
    >;
    references[0]!['start'] = [999, 1];
    expect(() => scoreStudyResults(invalidEvidence, readTaskDataset())).toThrow(
      expect.objectContaining({ code: 'EVIDENCE_REFERENCE_NOT_IN_TASK' }),
    );
  });

  it('rejects participant identifiers outside the pseudonymous token format', () => {
    const input = syntheticF2Result();
    const record = (input['results'] as Array<Record<string, unknown>>)[0]!;
    record['email'] = 'participant@example.test';

    expect(() => scoreStudyResults(input, readTaskDataset())).toThrow(
      StudyResultError,
    );
  });

  it('rejects a result assigned to a task-ineligible condition', () => {
    const tasks = readTaskDataset();
    const taskRecords = tasks['tasks'] as Array<Record<string, unknown>>;
    taskRecords[1]!['conditionEligibility'] = ['ide'];

    expect(() => scoreStudyResults(syntheticF2Result(), tasks)).toThrow(
      expect.objectContaining({ code: 'CONDITION_NOT_ELIGIBLE' }),
    );
  });

  it('produces the same aggregate when input records arrive in a different order', () => {
    const input = syntheticF2Result();
    const records = input['results'] as Array<Record<string, unknown>>;
    const second = structuredClone(records[0]!);
    second['participantToken'] = 'P-1111111111111111';
    second['taskOrder'] = 2;
    records.push(second);
    const reordered = structuredClone(input);
    (reordered['results'] as unknown[]).reverse();

    expect(scoreStudyResults(input, readTaskDataset())).toEqual(
      scoreStudyResults(reordered, readTaskDataset()),
    );
  });

  it('scores a local result file without writing participant-level output', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'codethread-study-'));
    const resultPath = join(folder, 'synthetic-results.json');
    try {
      await writeFile(resultPath, JSON.stringify(syntheticF2Result()), 'utf8');

      const before = readFileSync(resultPath, 'utf8');
      const processResult = spawnSync(
        process.execPath,
        ['scripts/study.ts', 'score', resultPath],
        { cwd: repositoryRoot, encoding: 'utf8' },
      );
      const output = processResult.stdout;

      expect(processResult.status).toBe(0);
      expect(output).toContain('CTE-F2-001');
      expect(output).not.toContain('P-0123456789ABCDEF');
      expect(output).not.toContain('Synthetic test answer');
      expect(readFileSync(resultPath, 'utf8')).toBe(before);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('runs an explicitly labeled scoring demonstration without writing results', async () => {
    const result = await runStudyCommand(['demo']);

    expect(result).toMatchObject({
      notice: 'SYNTHETIC DRY RUN — NOT EMPIRICAL DATA',
      report: {
        groups: [
          {
            taskId: 'CTE-F2-001',
            objectiveEarned: 12,
            objectiveAvailable: 12,
            awaitingHumanScoring: 1,
          },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain('P-0000000000000000');
  });
});
