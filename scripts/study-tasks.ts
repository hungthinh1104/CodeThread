import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  createSourcePositionIndex,
  snapshotPathSchema,
} from '@codethread/code-model';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { z } from 'zod';

const studyConditionSchema = z.enum(['ide', 'textual', 'visual']);
const coordinateSchema = z.tuple([
  z.number().int().positive(),
  z.number().int().positive(),
]);
const filePathSchema = z.string().min(1).max(1024).pipe(snapshotPathSchema);
const fixturePathSchema = filePathSchema.refine(
  (path) => path.startsWith('fixtures/external/'),
  'Fixture paths must be inside fixtures/external',
);

const sourceSpanSchema = z.strictObject({
  path: filePathSchema,
  start: coordinateSchema,
  end: coordinateSchema,
});
const declarationSpanSchema = sourceSpanSchema.extend({
  name: z.string().min(1).max(256),
  owner: z.string().min(1).max(256).optional(),
});
const expectedAssertionSchema = z
  .strictObject({
    id: z.string().regex(/^F[1-3]-A[1-9][0-9]*$/),
    call: z.string().min(1).max(2048).optional(),
    expression: z.string().min(1).max(2048).optional(),
    kind: z.enum(['CALLS', 'REFERENCES']),
    status: z
      .enum(['exact', 'unresolved', 'ambiguous', 'unsupported'])
      .optional(),
    site: sourceSpanSchema,
    target: declarationSpanSchema.optional(),
    candidateSourceDeclaration: declarationSpanSchema.optional(),
    diagnosticContext: z.string().max(4096).optional(),
  })
  .superRefine((assertion, context) => {
    if (Boolean(assertion.call) === Boolean(assertion.expression)) {
      context.addIssue({
        code: 'custom',
        message: 'Exactly one call or expression label is required',
      });
    }
    const status = assertion.status ?? 'exact';
    if (status === 'exact' && !assertion.target) {
      context.addIssue({
        code: 'custom',
        message: 'Exact assertions require a target declaration',
      });
    }
    if (status !== 'exact' && assertion.target) {
      context.addIssue({
        code: 'custom',
        message: 'Non-exact assertions cannot claim an exact target',
      });
    }
    if (status === 'exact' && assertion.candidateSourceDeclaration) {
      context.addIssue({
        code: 'custom',
        message: 'Exact assertions cannot also name a candidate declaration',
      });
    }
  });

const sourceAnchorSchema = z
  .strictObject({
    path: filePathSchema,
    line: z.number().int().positive().optional(),
    text: z.string().min(1).max(4096).optional(),
    start: coordinateSchema.optional(),
    end: coordinateSchema.optional(),
    name: z.string().min(1).max(256).optional(),
    note: z.string().min(1).max(4096).optional(),
  })
  .superRefine((anchor, context) => {
    const lineAnchor = anchor.line !== undefined || anchor.text !== undefined;
    const spanAnchor = anchor.start !== undefined || anchor.end !== undefined;
    if (
      lineAnchor &&
      (anchor.line === undefined || anchor.text === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Line anchors require both line and text',
      });
    }
    if (
      spanAnchor &&
      (anchor.start === undefined || anchor.end === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Range anchors require both start and end',
      });
    }
    if (!lineAnchor && !spanAnchor && !anchor.note) {
      context.addIssue({
        code: 'custom',
        message:
          'Source anchor requires a range, line text, or explanatory note',
      });
    }
  });

const selectedFileSchema = z.strictObject({
  path: filePathSchema,
  fixturePath: fixturePathSchema,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z
    .number()
    .int()
    .nonnegative()
    .max(2 * 1024 * 1024),
  gitBlob: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
});
const independentReviewSchema = z.strictObject({
  reviewer: z.string().min(1).max(128),
  reviewedAt: z.iso.date(),
  scope: z.enum([
    'source_anchors',
    'answer_key',
    'information_parity',
    'complete_task',
  ]),
});
const runCountsSchema = z.strictObject({
  manifestFiles: z.number().int().nonnegative(),
  declarations: z.number().int().nonnegative(),
  callSites: z.number().int().nonnegative(),
  exactCalls: z.number().int().nonnegative(),
  unresolvedCalls: z.number().int().nonnegative(),
  ambiguousCalls: z.number().int().nonnegative(),
  unsupportedCalls: z.number().int().nonnegative(),
});
const currentObservationSchema = z.union([
  z.strictObject({
    originalTwoFileManifest: z.string().min(1).max(2048),
    expandedFiveFileManifest: z.string().min(1).max(2048),
    recordedExpandedRun: runCountsSchema,
    scope: z.string().min(1).max(2048),
  }),
  z.strictObject({
    exactReferences: z.number().int().nonnegative(),
    exactCallsInSelectedTwoFileManifest: z.number().int().nonnegative(),
    unresolvedCalls: z.number().int().nonnegative(),
    ambiguousCalls: z.number().int().nonnegative(),
    unsupportedCalls: z.number().int().nonnegative(),
    evidence: z.string().min(1).max(2048),
    sourceGrounding: z.string().min(1).max(2048),
  }),
  z.strictObject({
    annotatedCalls: z.number().int().nonnegative(),
    eligibleCalls: z.number().int().nonnegative(),
    exact: z.number().int().nonnegative(),
    unresolved: z.number().int().nonnegative(),
    ambiguous: z.number().int().nonnegative(),
    unsupported: z.number().int().nonnegative(),
  }),
]);

const taskSchema = z
  .strictObject({
    id: z.string().regex(/^CTE-(?:F[1-3]|REJ)-[0-9]{3}$/),
    family: z.enum([
      'direct_and_cross_file_calls',
      'static_method_references_and_controller_relationships',
      'uncertainty_and_evidence_reliability',
      'runtime_framework_dispatch',
      'runtime_database_behavior',
    ]),
    researchQuestions: z.array(z.string().min(1).max(64)).max(8),
    feasibility: z.enum([
      'ELIGIBLE',
      'ELIGIBLE_WITH_LIMITATIONS',
      'EXPLORATORY_ONLY',
      'REJECTED',
    ]),
    informationParity: z.enum([
      'PARITY_VERIFIED',
      'PARITY_WITH_LIMITATIONS',
      'EXPLORATORY_ONLY',
      'PARITY_FAILED',
    ]),
    conditionEligibility: z.array(studyConditionSchema).max(3),
    independentReviewStatus: z.enum([
      'AWAITING_INDEPENDENT_REVIEW',
      'INDEPENDENTLY_REVIEWED',
    ]),
    independentReview: independentReviewSchema.optional(),
    difficulty: z.strictObject({
      estimate: z.enum(['low_to_medium', 'medium', 'not_applicable']),
      status: z.enum(['provisional', 'not_scored']),
      basis: z.string().min(1).max(512).optional(),
    }),
    source: z.strictObject({
      repository: z
        .string()
        .url()
        .refine((value) => {
          const url = new URL(value);
          return url.protocol === 'https:' && url.hostname === 'github.com';
        }),
      revision: z.string().regex(/^[0-9a-f]{40}$/),
      license: z.string().min(1).max(128),
      selectedFiles: z.array(selectedFileSchema).min(1).max(20),
      excludedInputs: z.array(z.string().min(1).max(512)).max(64).optional(),
    }),
    participantPrompt: z.string().min(1).max(8192),
    expectedAnswer: z
      .strictObject({
        summary: z.string().min(1).max(8192),
        assertions: z.array(expectedAssertionSchema).min(1).max(100),
        limits: z.array(z.string().min(1).max(2048)).min(1).max(64),
      })
      .nullable(),
    rejectionReason: z.string().min(1).max(4096).optional(),
    sourceAnchors: z.array(sourceAnchorSchema).min(1).max(100).optional(),
    requiredCapabilities: z.array(z.string().min(1).max(128)).min(1).max(64),
    currentCodeThreadObservation: currentObservationSchema.optional(),
    accessibility: z
      .strictObject({
        ide: z.string().min(1).max(4096),
        textual: z.string().min(1).max(4096),
        visual: z.string().min(1).max(4096),
        rq2Restriction: z.string().min(1).max(4096),
        interactionDifference: z.string().min(1).max(4096),
      })
      .optional(),
    potentialConfounders: z.array(z.string().min(1).max(1024)).max(64),
    reviewChecklist: z.array(z.string().min(1).max(1024)).min(1).max(64),
  })
  .superRefine((task, context) => {
    const rejected = task.feasibility === 'REJECTED';
    if (rejected !== (task.expectedAnswer === null)) {
      context.addIssue({
        code: 'custom',
        path: ['expectedAnswer'],
        message: 'Rejected tasks have no answer key; other tasks require one',
      });
    }
    if (rejected !== Boolean(task.rejectionReason)) {
      context.addIssue({
        code: 'custom',
        path: ['rejectionReason'],
        message: 'Only rejected tasks require a rejection reason',
      });
    }
    if (rejected === Boolean(task.accessibility)) {
      context.addIssue({
        code: 'custom',
        path: ['accessibility'],
        message:
          'Candidate tasks require accessibility notes; rejected tasks do not',
      });
    }
    const observationMatchesFamily =
      (task.family === 'direct_and_cross_file_calls' &&
        task.currentCodeThreadObservation !== undefined &&
        'originalTwoFileManifest' in task.currentCodeThreadObservation) ||
      (task.family ===
        'static_method_references_and_controller_relationships' &&
        task.currentCodeThreadObservation !== undefined &&
        'exactReferences' in task.currentCodeThreadObservation) ||
      (task.family === 'uncertainty_and_evidence_reliability' &&
        task.currentCodeThreadObservation !== undefined &&
        'annotatedCalls' in task.currentCodeThreadObservation) ||
      (rejected && task.currentCodeThreadObservation === undefined);
    if (!observationMatchesFamily) {
      context.addIssue({
        code: 'custom',
        path: ['currentCodeThreadObservation'],
        message: 'Recorded observations must match the task family',
      });
    }
    if (rejected && task.conditionEligibility.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['conditionEligibility'],
        message: 'Rejected tasks cannot be assigned to study conditions',
      });
    }
    if (!rejected && task.conditionEligibility.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['conditionEligibility'],
        message: 'Candidate tasks need at least one eligible condition',
      });
    }
    if (
      new Set(task.conditionEligibility).size !==
      task.conditionEligibility.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['conditionEligibility'],
        message: 'Condition assignments must be unique',
      });
    }
    if (rejected !== (task.informationParity === 'PARITY_FAILED')) {
      context.addIssue({
        code: 'custom',
        path: ['informationParity'],
        message:
          'Rejected tasks require PARITY_FAILED and candidates cannot use it',
      });
    }
    const expectedParity = {
      ELIGIBLE: 'PARITY_VERIFIED',
      ELIGIBLE_WITH_LIMITATIONS: 'PARITY_WITH_LIMITATIONS',
      EXPLORATORY_ONLY: 'EXPLORATORY_ONLY',
      REJECTED: 'PARITY_FAILED',
    }[task.feasibility];
    if (task.informationParity !== expectedParity) {
      context.addIssue({
        code: 'custom',
        path: ['informationParity'],
        message: 'Information parity must agree with the feasibility decision',
      });
    }
    if (
      (task.independentReviewStatus === 'INDEPENDENTLY_REVIEWED') !==
      Boolean(task.independentReview)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['independentReview'],
        message:
          'Reviewed tasks require review provenance; awaiting tasks do not',
      });
    }
    if (
      rejected &&
      !task.sourceAnchors?.some(
        (anchor) => anchor.line !== undefined || anchor.start !== undefined,
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['sourceAnchors'],
        message: 'Rejected tasks need source evidence for their boundary',
      });
    }
    if (
      (task.difficulty.status === 'provisional') !==
      Boolean(task.difficulty.basis)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['difficulty'],
        message:
          'Provisional difficulty requires its basis; unscored difficulty does not',
      });
    }
    const selected = task.source.selectedFiles;
    const paths = selected.map((file) => file.path);
    if (new Set(paths).size !== paths.length) {
      context.addIssue({
        code: 'custom',
        path: ['source', 'selectedFiles'],
        message: 'Selected source paths must be unique',
      });
    }
    if (
      new Set(paths.map((path) => path.toLowerCase())).size !== paths.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['source', 'selectedFiles'],
        message: 'Case-equivalent source paths are not allowed',
      });
    }
    const fixturePaths = selected.map((file) => file.fixturePath);
    if (
      new Set(fixturePaths.map((path) => path.toLowerCase())).size !==
      fixturePaths.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['source', 'selectedFiles'],
        message: 'Fixture paths must be unique and case-sensitive',
      });
    }
  });

export const studyTaskDatasetSchema = z.strictObject({
  schemaVersion: z.literal(1),
  assessment: z.strictObject({
    requirement: z.literal('CT-EVAL-001A'),
    baselineSha: z.string().regex(/^[0-9a-f]{40}$/),
    sourceLabelStatus: z.literal('AWAITING_INDEPENDENT_REVIEW'),
    provisionalTaskAnswerAuthor: z.string().min(1).max(256),
    coordinates: z.literal('one-based UTF-16 line and column; end-exclusive'),
    answerKeyPolicy: z.literal(
      'Expected answers are authored from pinned source, not from analyzer predictions.',
    ),
  }),
  tasks: z.array(taskSchema).min(1).max(100),
});

export type StudyCondition = z.infer<typeof studyConditionSchema>;
export type StudyTask = z.infer<typeof taskSchema>;
export type StudyTaskDataset = z.infer<typeof studyTaskDatasetSchema>;

export type StudyTaskValidationIssue = Readonly<{
  code: string;
  taskId?: string;
  path?: string;
}>;
export type StudyTaskValidationReport = Readonly<{
  valid: boolean;
  taskCount: number;
  errors: readonly StudyTaskValidationIssue[];
}>;

const MAX_TASK_DATASET_SOURCE_BYTES = 8 * 1024 * 1024;
const defaultRepositoryRoot = resolve(
  fileURLToPath(new URL('../', import.meta.url)),
);

function issue(
  code: string,
  taskId?: string,
  path?: string,
): StudyTaskValidationIssue {
  return {
    code,
    ...(taskId ? { taskId } : {}),
    ...(path ? { path } : {}),
  };
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) =>
      compare(left, right),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function taskDefinitionKey(task: StudyTask): string {
  return canonicalJson({
    family: task.family,
    source: {
      repository: task.source.repository,
      revision: task.source.revision,
      selectedFiles: task.source.selectedFiles
        .map(({ path, sha256 }) => ({ path, sha256 }))
        .sort((left, right) => compare(left.path, right.path)),
    },
    participantPrompt: task.participantPrompt,
  });
}

function taskDefinitionValue(task: StudyTask): string {
  return canonicalJson({
    expectedAnswer: task.expectedAnswer,
    feasibility: task.feasibility,
    informationParity: task.informationParity,
    conditionEligibility: [...task.conditionEligibility].sort(compare),
  });
}

function safeFixturePath(root: string, fixturePath: string): string | null {
  if (!fixturePathSchema.safeParse(fixturePath).success) return null;
  const absolutePath = resolve(root, ...fixturePath.split('/'));
  const relativePath = relative(root, absolutePath);
  if (
    relativePath === '' ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return null;
  }
  return absolutePath;
}

async function readFixture(
  root: string,
  fixturePath: string,
  declaredBytes: number,
): Promise<
  | { ok: true; bytes: Uint8Array; text: string; sourceFile: ts.SourceFile }
  | { ok: false; code: string }
> {
  const absolutePath = safeFixturePath(root, fixturePath);
  if (!absolutePath) return { ok: false, code: 'FIXTURE_PATH_UNSAFE' };
  let cursor = root;
  const parts = relative(root, absolutePath).split(sep);
  try {
    for (let index = 0; index < parts.length; index++) {
      cursor = resolve(cursor, parts[index]!);
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink())
        return { ok: false, code: 'FIXTURE_PATH_UNSAFE' };
      if (index < parts.length - 1 && !stat.isDirectory()) {
        return { ok: false, code: 'FIXTURE_PATH_UNSAFE' };
      }
      if (index === parts.length - 1 && !stat.isFile()) {
        return { ok: false, code: 'SOURCE_FILE_INVALID' };
      }
      if (index === parts.length - 1 && stat.size !== declaredBytes) {
        return { ok: false, code: 'SOURCE_SIZE_MISMATCH' };
      }
    }
    const bytes = await readFile(absolutePath);
    if (bytes.byteLength !== declaredBytes) {
      return { ok: false, code: 'SOURCE_SIZE_MISMATCH' };
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        bytes,
      );
    } catch {
      return { ok: false, code: 'SOURCE_INVALID_ENCODING' };
    }
    const sourceFile = ts.createSourceFile(
      fixturePath,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    return { ok: true, bytes, text, sourceFile };
  } catch (error) {
    const code =
      error !== null && typeof error === 'object' && 'code' in error
        ? error.code
        : undefined;
    return {
      ok: false,
      code:
        code === 'ENOENT' ? 'SOURCE_FILE_MISSING' : 'SOURCE_FILE_UNAVAILABLE',
    };
  }
}

function coordinateOffset(
  sourceFile: ts.SourceFile,
  coordinate: readonly [number, number],
): number | null {
  try {
    const offset = sourceFile.getPositionOfLineAndCharacter(
      coordinate[0] - 1,
      coordinate[1] - 1,
    );
    const actual = sourceFile.getLineAndCharacterOfPosition(offset);
    if (
      actual.line + 1 !== coordinate[0] ||
      actual.character + 1 !== coordinate[1]
    ) {
      return null;
    }
    return offset;
  } catch {
    return null;
  }
}

function anchorOffsets(
  source: string,
  sourceFile: ts.SourceFile,
  span: z.infer<typeof sourceSpanSchema>,
): { start: number; end: number } | null {
  const start = coordinateOffset(sourceFile, span.start);
  const end = coordinateOffset(sourceFile, span.end);
  if (start === null || end === null || end <= start) return null;
  const positionIndex = createSourcePositionIndex(source);
  const range = {
    start: { offset: start, line: span.start[0], column: span.start[1] },
    end: { offset: end, line: span.end[0], column: span.end[1] },
  };
  return positionIndex.validateRange(range) ? { start, end } : null;
}

function matchingDeclaration(
  sourceFile: ts.SourceFile,
  span: z.infer<typeof declarationSpanSchema>,
  expectedOffsets: { start: number; end: number },
): boolean {
  let matched = false;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
      const name = node.name?.getText(sourceFile);
      const owner =
        ts.isMethodDeclaration(node) && ts.isClassLike(node.parent)
          ? node.parent.name?.text
          : undefined;
      if (
        name === span.name &&
        node.getStart(sourceFile) === expectedOffsets.start &&
        node.getEnd() === expectedOffsets.end &&
        (span.owner === undefined || owner === span.owner)
      ) {
        matched = true;
      }
    }
    if (!matched) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return matched;
}

function validateSpan(
  span: z.infer<typeof sourceSpanSchema>,
  files: ReadonlyMap<string, { text: string; sourceFile: ts.SourceFile }>,
  expectedText?: string,
): { start: number; end: number } | null {
  const file = files.get(span.path);
  if (!file) return null;
  const offsets = anchorOffsets(file.text, file.sourceFile, span);
  if (!offsets) return null;
  if (
    expectedText !== undefined &&
    file.text.slice(offsets.start, offsets.end) !== expectedText
  ) {
    return null;
  }
  return offsets;
}

function validateDeclaration(
  task: StudyTask,
  span: z.infer<typeof declarationSpanSchema>,
  files: ReadonlyMap<string, { text: string; sourceFile: ts.SourceFile }>,
  errors: StudyTaskValidationIssue[],
): void {
  const file = files.get(span.path);
  const offsets = file ? anchorOffsets(file.text, file.sourceFile, span) : null;
  if (
    !file ||
    !offsets ||
    !matchingDeclaration(file.sourceFile, span, offsets)
  ) {
    errors.push(issue('DECLARATION_ANCHOR_MISMATCH', task.id, span.path));
  }
}

function validateTaskSemantics(
  task: StudyTask,
  files: ReadonlyMap<string, { text: string; sourceFile: ts.SourceFile }>,
  errors: StudyTaskValidationIssue[],
): void {
  const expectedKind =
    task.family === 'static_method_references_and_controller_relationships'
      ? 'REFERENCES'
      : task.family === 'runtime_framework_dispatch' ||
          task.family === 'runtime_database_behavior'
        ? undefined
        : 'CALLS';
  const selectedPaths = new Set(
    task.source.selectedFiles.map((file) => file.path),
  );
  for (const assertion of task.expectedAnswer?.assertions ?? []) {
    if (expectedKind && assertion.kind !== expectedKind) {
      errors.push(
        issue('RELATION_KIND_MISMATCH', task.id, assertion.site.path),
      );
    }
    const label = assertion.call ?? assertion.expression!;
    if (!selectedPaths.has(assertion.site.path)) {
      errors.push(
        issue('EVIDENCE_FILE_NOT_SELECTED', task.id, assertion.site.path),
      );
    } else if (!validateSpan(assertion.site, files, label)) {
      errors.push(
        issue('SOURCE_EVIDENCE_MISMATCH', task.id, assertion.site.path),
      );
    }
    if (assertion.target) {
      if (!selectedPaths.has(assertion.target.path)) {
        errors.push(
          issue('EVIDENCE_FILE_NOT_SELECTED', task.id, assertion.target.path),
        );
      } else {
        validateDeclaration(task, assertion.target, files, errors);
      }
    }
    if (assertion.candidateSourceDeclaration) {
      if (!selectedPaths.has(assertion.candidateSourceDeclaration.path)) {
        errors.push(
          issue(
            'EVIDENCE_FILE_NOT_SELECTED',
            task.id,
            assertion.candidateSourceDeclaration.path,
          ),
        );
      } else {
        validateDeclaration(
          task,
          assertion.candidateSourceDeclaration,
          files,
          errors,
        );
      }
    }
  }
  for (const anchor of task.sourceAnchors ?? []) {
    if (!selectedPaths.has(anchor.path)) {
      errors.push(issue('EVIDENCE_FILE_NOT_SELECTED', task.id, anchor.path));
      continue;
    }
    const file = files.get(anchor.path);
    if (!file) continue;
    if (anchor.line !== undefined && anchor.text !== undefined) {
      const start = coordinateOffset(file.sourceFile, [anchor.line, 1]);
      if (start === null) {
        errors.push(issue('SOURCE_ANCHOR_INVALID', task.id, anchor.path));
      } else {
        const end =
          coordinateOffset(file.sourceFile, [anchor.line + 1, 1]) ??
          file.text.length;
        const actual = file.text
          .slice(start, end)
          .replace(/[\r\n\u2028\u2029]+$/u, '')
          .trim();
        if (actual !== anchor.text.trim()) {
          errors.push(issue('SOURCE_EVIDENCE_MISMATCH', task.id, anchor.path));
        }
      }
    }
    if (anchor.start && anchor.end) {
      const declaration = anchor.name
        ? { ...anchor, start: anchor.start, end: anchor.end, name: anchor.name }
        : null;
      const span = { path: anchor.path, start: anchor.start, end: anchor.end };
      const offsets = validateSpan(span, files);
      if (!offsets) {
        errors.push(issue('SOURCE_ANCHOR_INVALID', task.id, anchor.path));
      } else if (declaration) {
        const target = declarationSpanSchema.safeParse(declaration);
        if (
          !target.success ||
          !matchingDeclaration(file.sourceFile, target.data, offsets)
        ) {
          errors.push(
            issue('DECLARATION_ANCHOR_MISMATCH', task.id, anchor.path),
          );
        }
      }
    }
  }
}

function sortIssues(
  issues: StudyTaskValidationIssue[],
): StudyTaskValidationIssue[] {
  return issues.sort(
    (left, right) =>
      compare(left.taskId ?? '', right.taskId ?? '') ||
      compare(left.path ?? '', right.path ?? '') ||
      compare(left.code, right.code),
  );
}

export async function validateStudyTaskDataset(
  input: unknown,
  options: { repositoryRoot?: string } = {},
): Promise<StudyTaskValidationReport> {
  const parsed = studyTaskDatasetSchema.safeParse(input);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((entry) =>
      issue('TASK_SCHEMA_INVALID', undefined, entry.path.join('.')),
    );
    return { valid: false, taskCount: 0, errors: sortIssues(errors) };
  }
  const dataset = parsed.data;
  const errors: StudyTaskValidationIssue[] = [];
  const ids = new Set<string>();
  const definitions = new Map<string, { taskId: string; value: string }>();
  let totalBytes = 0;

  for (const task of dataset.tasks) {
    if (ids.has(task.id)) errors.push(issue('DUPLICATE_TASK_ID', task.id));
    ids.add(task.id);
    const definitionKey = taskDefinitionKey(task);
    const definitionValue = taskDefinitionValue(task);
    const previous = definitions.get(definitionKey);
    if (previous) {
      errors.push(
        issue(
          previous.value === definitionValue
            ? 'DUPLICATE_TASK_DEFINITION'
            : 'CONFLICTING_TASK_DEFINITION',
          task.id,
        ),
      );
    } else {
      definitions.set(definitionKey, {
        taskId: task.id,
        value: definitionValue,
      });
    }
    for (const file of task.source.selectedFiles) totalBytes += file.bytes;
    if (task.expectedAnswer) {
      const assertionIds = task.expectedAnswer.assertions.map(
        (assertion) => assertion.id,
      );
      if (new Set(assertionIds).size !== assertionIds.length) {
        errors.push(issue('DUPLICATE_ASSERTION_ID', task.id));
      }
    }
  }
  if (totalBytes > MAX_TASK_DATASET_SOURCE_BYTES) {
    errors.push(issue('TASK_SOURCE_BUDGET_EXCEEDED'));
    return {
      valid: false,
      taskCount: dataset.tasks.length,
      errors: sortIssues(errors),
    };
  }

  const root = await realpath(
    options.repositoryRoot ?? defaultRepositoryRoot,
  ).catch(() => null);
  if (!root) {
    errors.push(issue('REPOSITORY_ROOT_UNAVAILABLE'));
    return {
      valid: false,
      taskCount: dataset.tasks.length,
      errors: sortIssues(errors),
    };
  }

  for (const task of dataset.tasks) {
    const files = new Map<
      string,
      { text: string; sourceFile: ts.SourceFile }
    >();
    for (const selected of task.source.selectedFiles) {
      const fixturePath = safeFixturePath(root, selected.fixturePath);
      if (!fixturePath) {
        errors.push(issue('FIXTURE_PATH_UNSAFE', task.id, selected.path));
        continue;
      }
      const loaded = await readFixture(
        root,
        selected.fixturePath,
        selected.bytes,
      );
      if (!loaded.ok) {
        errors.push(issue(loaded.code, task.id, selected.path));
        continue;
      }
      files.set(selected.path, {
        text: loaded.text,
        sourceFile: loaded.sourceFile,
      });
      if (
        createHash('sha256').update(loaded.bytes).digest('hex') !==
        selected.sha256
      ) {
        errors.push(issue('SOURCE_HASH_MISMATCH', task.id, selected.path));
      }
      if (selected.gitBlob) {
        const gitHash = createHash('sha1')
          .update(`blob ${loaded.bytes.byteLength}\0`)
          .update(loaded.bytes)
          .digest('hex');
        if (gitHash !== selected.gitBlob) {
          errors.push(issue('GIT_BLOB_MISMATCH', task.id, selected.path));
        }
      }
    }
    validateTaskSemantics(task, files, errors);
  }

  const sorted = sortIssues(errors);
  return {
    valid: sorted.length === 0,
    taskCount: dataset.tasks.length,
    errors: sorted,
  };
}

export async function loadStudyTaskDataset(
  path = resolve(defaultRepositoryRoot, 'docs/evaluation/tasks.json'),
): Promise<unknown> {
  const bytes = await readFile(path);
  if (bytes.byteLength > 2 * 1024 * 1024) {
    throw new Error('TASK_DATASET_TOO_LARGE');
  }
  const text = new TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('TASK_DATASET_INVALID_JSON');
  }
}
