import { z } from 'zod';
import {
  snapshotPathSchema,
  idSchema,
  testCaseSchema,
  testStepSchema,
  testCodeLinkSchema,
  symbolSchema,
} from '@codethread/code-model';
import {
  pageFields,
  checkCursor,
  scoped,
  queryMetaSchema,
  nextCursor,
} from './query-common.js';
import {
  graphFields,
  graphIntegrity,
  checkResolutionReferences,
} from './graph-integrity.js';
import {
  checkDeclaration,
  checkUnique,
  checkStepHierarchy,
  checkSite,
} from './integrity.js';

const testFiltersSchema = z.strictObject({
  text: z.string().min(1).max(256).optional(),
  filePath: snapshotPathSchema.optional(),
  suite: z.string().min(1).max(1024).optional(),
});

export const listTestsRequestSchema = z
  .strictObject({ ...pageFields, filters: testFiltersSchema.default({}) })
  .superRefine((request, context) =>
    checkCursor(
      request.cursor,
      request.snapshotId,
      'list_tests',
      request.filters,
      context,
    ),
  );

export const relatedProductionSymbolsRequestSchema = z
  .strictObject({ ...pageFields, testId: idSchema })
  .superRefine((request, context) =>
    checkCursor(
      request.cursor,
      request.snapshotId,
      'related_symbols',
      { testId: request.testId },
      context,
    ),
  );

export const findTestsForSymbolRequestSchema = z
  .strictObject({ ...pageFields, symbolId: idSchema })
  .superRefine((request, context) =>
    checkCursor(
      request.cursor,
      request.snapshotId,
      'tests_for_symbol',
      { symbolId: request.symbolId },
      context,
    ),
  );

export const getTestTraceRequestSchema = z.strictObject({
  snapshotId: idSchema,
  testId: idSchema,
  stepLimit: z.number().int().min(1).max(500).default(500),
  symbolLimit: z.number().int().min(1).max(200).default(200),
  relationLimit: z.number().int().min(1).max(1000).default(1000),
});

export const listTestsResponseSchema = scoped(
  z.strictObject({
    meta: queryMetaSchema,
    items: z.array(testCaseSchema).max(200),
    nextCursor,
  }),
  'list_tests',
);

export const getTestTraceResponseSchema = scoped(
  z
    .strictObject({
      meta: queryMetaSchema,
      test: testCaseSchema,
      steps: z.array(testStepSchema).max(500),
      links: z.array(testCodeLinkSchema).max(1000),
      ...graphFields,
    })
    .superRefine((trace, context) => {
      graphIntegrity(trace, context);
      const evidence = new Map(
        trace.evidenceRefs.map((item) => [item.id, item]),
      );
      checkDeclaration(trace.test, evidence, context, ['test']);
      const evidenceIds = new Set(trace.evidenceRefs.map((item) => item.id));
      const diagnosticIds = new Set(trace.diagnostics.map((item) => item.id));
      const symbolIds = new Set(trace.symbols.map((item) => item.id));
      const stepIds = new Set(trace.steps.map((item) => item.id));
      checkUnique(trace.steps, context, ['steps']);
      checkUnique(trace.links, context, ['links']);
      if (!evidenceIds.has(trace.test.declarationEvidenceId))
        context.addIssue({
          code: 'custom',
          message: 'Missing test declaration evidence',
        });
      const steps = new Map(trace.steps.map((step) => [step.id, step]));
      checkStepHierarchy(trace.steps, context);
      for (const step of trace.steps) {
        if (
          step.testId !== trace.test.id ||
          (step.parentStepId !== null && !stepIds.has(step.parentStepId)) ||
          step.evidenceIds.some((id) => !evidenceIds.has(id))
        ) {
          context.addIssue({
            code: 'custom',
            message: 'Invalid step ownership or evidence',
          });
        }
      }
      for (const link of trace.links) {
        const step = steps.get(link.stepId);
        if (step)
          checkSite(
            link.siteEvidenceId,
            step.sourceEvidenceId,
            evidence,
            context,
            ['links', link.id, 'siteEvidenceId'],
          );
        if (
          link.testId !== trace.test.id ||
          !stepIds.has(link.stepId) ||
          (link.resolution.status === 'exact' &&
            !symbolIds.has(link.resolution.targetId))
        ) {
          context.addIssue({
            code: 'custom',
            message: 'Invalid test-link ownership or endpoint',
          });
        }
        checkResolutionReferences(
          link.resolution,
          evidenceIds,
          diagnosticIds,
          context,
        );
      }
    }),
);

export const relatedProductionSymbolsResponseSchema = scoped(
  z
    .strictObject({
      meta: queryMetaSchema,
      testId: idSchema,
      items: z
        .array(
          z.strictObject({
            symbol: symbolSchema,
            links: z.array(testCodeLinkSchema).min(1).max(1000),
          }),
        )
        .max(200),
      nextCursor,
    })
    .superRefine((response, context) => {
      checkUnique(
        response.items.flatMap((item) => item.links),
        context,
        ['items', 'links'],
      );
      for (const item of response.items) {
        if (
          item.links.some(
            (link) =>
              link.testId !== response.testId ||
              link.resolution.status !== 'exact' ||
              link.resolution.targetId !== item.symbol.id,
          )
        ) {
          context.addIssue({
            code: 'custom',
            message: 'Related symbol requires matching exact test links',
          });
        }
      }
    }),
  'related_symbols',
);

export const findTestsForSymbolResponseSchema = scoped(
  z
    .strictObject({
      meta: queryMetaSchema,
      symbolId: idSchema,
      items: z
        .array(
          z.strictObject({
            test: testCaseSchema,
            links: z.array(testCodeLinkSchema).min(1).max(1000),
          }),
        )
        .max(200),
      nextCursor,
    })
    .superRefine((response, context) => {
      checkUnique(
        response.items.flatMap((item) => item.links),
        context,
        ['items', 'links'],
      );
      for (const item of response.items) {
        if (
          item.links.some(
            (link) =>
              link.testId !== item.test.id ||
              link.resolution.status !== 'exact' ||
              link.resolution.targetId !== response.symbolId,
          )
        ) {
          context.addIssue({
            code: 'custom',
            message: 'Reverse lookup requires matching exact test links',
          });
        }
      }
    }),
  'tests_for_symbol',
);

export type ListTestsRequest = z.infer<typeof listTestsRequestSchema>;

export type TestTrace = z.infer<typeof getTestTraceResponseSchema>;

export type GetTestTraceRequest = z.infer<typeof getTestTraceRequestSchema>;

export type RelatedProductionSymbolsRequest = z.infer<
  typeof relatedProductionSymbolsRequestSchema
>;

export type RelatedProductionSymbolsResponse = z.infer<
  typeof relatedProductionSymbolsResponseSchema
>;

export type FindTestsForSymbolRequest = z.infer<
  typeof findTestsForSymbolRequestSchema
>;

export type FindTestsForSymbolResponse = z.infer<
  typeof findTestsForSymbolResponseSchema
>;

export type ListTestsResponse = z.infer<typeof listTestsResponseSchema>;
