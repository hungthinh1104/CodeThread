import { z } from 'zod';

export const idSchema = z.uuid().transform((id) => id.toLowerCase());
export const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const canonicalKeySchema = z.string().min(1).max(1024);

export function isSnapshotPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 1024 &&
    !/[\\:]/.test(path) &&
    ![...path].some((character) => character.charCodeAt(0) < 32) &&
    path
      .split('/')
      .every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

export const snapshotPathSchema = z
  .string()
  .refine(isSnapshotPath, 'Unsafe snapshot path');
export const coverageSchema = z.enum([
  'complete',
  'partial',
  'not_analyzed',
  'unsupported',
]);
export type CoverageStatus = z.infer<typeof coverageSchema>;
export const coverageByCapabilitySchema = z
  .record(
    z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_.-]*\.v[1-9][0-9]*$/),
    coverageSchema,
  )
  .refine(
    (coverage) =>
      Object.keys(coverage).length >= 1 && Object.keys(coverage).length <= 32,
    'One to thirty-two versioned capabilities are required',
  );

export function summarizeCoverage(
  coverage: Readonly<Record<string, CoverageStatus>>,
): CoverageStatus {
  const states = new Set(Object.values(coverage));
  if (states.size === 0)
    throw new RangeError('Coverage requires at least one capability');
  return states.size === 1 ? states.values().next().value! : 'partial';
}
export const resolutionStatusSchema = z.enum([
  'exact',
  'ambiguous',
  'unresolved',
  'unsupported',
]);
export const snapshotIdentitySchema = z.strictObject({
  repositoryId: idSchema,
  sourceFingerprint: hashSchema,
  analyzerVersion: z.string().min(1).max(128),
  analyzerBuildHash: hashSchema,
  configurationHash: hashSchema,
});
export type SnapshotIdentity = z.infer<typeof snapshotIdentitySchema>;

export const sourcePositionSchema = z
  .strictObject({
    offset: z.number().int().nonnegative(),
    line: z.number().int().positive(),
    column: z.number().int().positive(),
  })
  .refine(
    (position) =>
      position.line <= position.offset + 1 &&
      position.column <= position.offset - position.line + 2 &&
      (position.line !== 1 || position.column === position.offset + 1),
    'Inconsistent absolute source position',
  );
export const sourceRangeSchema = z
  .strictObject({ start: sourcePositionSchema, end: sourcePositionSchema })
  .superRefine(({ start, end }, context) => {
    if (
      end.offset < start.offset ||
      end.line < start.line ||
      (end.line === start.line &&
        end.offset - start.offset !== end.column - start.column) ||
      (end.line > start.line &&
        end.offset - start.offset < end.line - start.line + end.column - 1) ||
      (end.line === start.line && end.column < start.column) ||
      (end.offset === start.offset &&
        (end.line !== start.line || end.column !== start.column))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Inconsistent half-open source range',
      });
    }
  });
export type SourceRange = z.infer<typeof sourceRangeSchema>;

/** Positions follow TypeScript's UTF-16 line map; CRLF is one line break. */
export function positionAt(
  source: string,
  offset: number,
): z.infer<typeof sourcePositionSchema> {
  if (!Number.isInteger(offset) || offset < 0 || offset > source.length) {
    throw new RangeError('Offset is outside the UTF-16 source');
  }
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < source.length; index++) {
    const character = source.charCodeAt(index);
    if (character === 13 && source.charCodeAt(index + 1) === 10) index++;
    if (
      character === 13 ||
      character === 10 ||
      character === 0x2028 ||
      character === 0x2029
    ) {
      if (index + 1 > offset) break;
      line++;
      lineStart = index + 1;
    }
    if (index >= offset) break;
  }
  return { offset, line, column: offset - lineStart + 1 };
}

/** Structural validation alone cannot establish that a span matches a file. */
export function validateSourceRange(
  source: string,
  range: SourceRange,
): boolean {
  if (
    !sourceRangeSchema.safeParse(range).success ||
    range.end.offset > source.length
  )
    return false;
  return [range.start, range.end].every((position) => {
    const actual = positionAt(source, position.offset);
    return actual.line === position.line && actual.column === position.column;
  });
}

const evidenceIds = z
  .array(idSchema)
  .min(1)
  .max(100)
  .refine(unique, 'Duplicate evidence IDs');
function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}
const unresolvedFields = {
  targetId: z.null(),
  evidenceIds,
  diagnosticIds: z
    .array(idSchema)
    .min(1)
    .max(100)
    .refine(unique, 'Duplicate diagnostic IDs'),
};
export const resolutionSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('exact'),
    targetId: idSchema,
    evidenceIds,
  }),
  z.strictObject({ status: z.literal('ambiguous'), ...unresolvedFields }),
  z.strictObject({ status: z.literal('unresolved'), ...unresolvedFields }),
  z.strictObject({ status: z.literal('unsupported'), ...unresolvedFields }),
]);
export type Resolution = z.infer<typeof resolutionSchema>;

export const sourceEvidenceSchema = z.strictObject({
  snapshotId: idSchema,
  id: idSchema,
  fileId: idSchema,
  contentHash: hashSchema,
  range: sourceRangeSchema,
  kind: z.literal('static_source'),
  extractor: z.strictObject({
    name: z.string().min(1).max(128),
    version: z.string().min(1).max(128),
  }),
});

const entityFields = {
  snapshotId: idSchema,
  id: idSchema,
  key: canonicalKeySchema,
};
export const symbolSchema = z
  .strictObject({
    ...entityFields,
    fileId: idSchema,
    filePath: snapshotPathSchema,
    name: z.string().min(1).max(1024),
    kind: z.enum([
      'function',
      'method',
      'class',
      'constructor',
      'field',
      'interface',
      'type',
      'variable',
      'module',
    ]),
    range: sourceRangeSchema,
    declarationEvidenceId: idSchema,
    evidenceIds,
  })
  .refine(
    (symbol) => symbol.evidenceIds.includes(symbol.declarationEvidenceId),
    'Declaration evidence must support the symbol',
  );
export const testCaseSchema = z
  .strictObject({
    ...entityFields,
    fileId: idSchema,
    filePath: snapshotPathSchema,
    name: z.string().min(1).max(1024),
    suitePath: z.array(z.string().min(1).max(1024)).max(64),
    range: sourceRangeSchema,
    declarationEvidenceId: idSchema,
    parameterization: z.enum(['none', 'static', 'dynamic']),
    caseKey: z.string().min(1).max(1024).nullable(),
  })
  .refine(
    (test) => test.parameterization !== 'none' || test.caseKey === null,
    'Non-parameterized test has a case key',
  );

export const testStepSchema = z
  .strictObject({
    ...entityFields,
    testId: idSchema,
    parentStepId: idSchema.nullable(),
    kind: z.enum([
      'setup',
      'input',
      'action',
      'mock',
      'assertion',
      'condition',
      'teardown',
    ]),
    phase: z.enum([
      'beforeAll',
      'beforeEach',
      'testBody',
      'afterEach',
      'afterAll',
    ]),
    syntaxOrdinal: z.number().int().nonnegative(),
    sourceEvidenceId: idSchema,
    evidenceIds,
  })
  .refine(
    (step) => step.evidenceIds.includes(step.sourceEvidenceId),
    'Source evidence must support the step',
  );
export const codeRelationSchema = z
  .strictObject({
    ...entityFields,
    sourceSymbolId: idSchema,
    kind: z.enum(['calls', 'constructs', 'references']),
    siteEvidenceId: idSchema,
    resolution: resolutionSchema,
  })
  .refine(
    (relation) =>
      relation.resolution.evidenceIds.includes(relation.siteEvidenceId),
    'Call-site evidence must support the relation',
  );
export const testCodeLinkSchema = z
  .strictObject({
    ...entityFields,
    testId: idSchema,
    stepId: idSchema,
    kind: z.enum([
      'calls',
      'constructs',
      'references',
      'mocks',
      'asserts_about',
    ]),
    siteEvidenceId: idSchema,
    resolution: resolutionSchema,
  })
  .refine(
    (link) => link.resolution.evidenceIds.includes(link.siteEvidenceId),
    'Call-site evidence must support the test link',
  );

export const diagnosticSchema = z
  .strictObject({
    snapshotId: idSchema,
    id: idSchema,
    code: z.string().regex(/^[A-Z][A-Z0-9_]{1,127}$/),
    severity: z.enum(['info', 'warning', 'error']),
    message: z.string().min(1).max(4096),
    fileId: idSchema.nullable(),
    filePath: snapshotPathSchema.nullable(),
    range: sourceRangeSchema.nullable(),
  })
  .refine(
    (diagnostic) =>
      (diagnostic.range === null || diagnostic.fileId !== null) &&
      (diagnostic.fileId === null) === (diagnostic.filePath === null),
    'Diagnostic source coordinates require a consistent file and path',
  );

export type CodeSymbol = z.infer<typeof symbolSchema>;
export type CodeRelation = z.infer<typeof codeRelationSchema>;
export type SourceEvidence = z.infer<typeof sourceEvidenceSchema>;
export type TestCase = z.infer<typeof testCaseSchema>;
export type TestStep = z.infer<typeof testStepSchema>;
export type TestCodeLink = z.infer<typeof testCodeLinkSchema>;
export type Diagnostic = z.infer<typeof diagnosticSchema>;
