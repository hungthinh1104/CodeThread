import {
  listTestsRequestSchema,
  listTestsResponseSchema,
  relatedProductionSymbolsRequestSchema,
  relatedProductionSymbolsResponseSchema,
  findTestsForSymbolRequestSchema,
  findTestsForSymbolResponseSchema,
  getTestTraceRequestSchema,
  getTestTraceResponseSchema,
} from './test-queries.js';
import { pageChecks, ensure, snapshot, applied } from './result-common.js';
import { z } from 'zod';
import { testStepSchema, sourceEvidenceSchema } from '@codethread/code-model';
import type {
  TestCodeLink,
  CodeSymbol,
  TestCase,
} from '@codethread/code-model';
import {
  checkUnique,
  checkStepHierarchy,
  indexEvidence,
  checkDeclaration,
  checkSite,
} from './integrity.js';

export function parseListTestsResult(
  requestInput: unknown,
  responseInput: unknown,
) {
  const request = listTestsRequestSchema.parse(requestInput),
    response = listTestsResponseSchema.parse(responseInput);
  pageChecks(
    request,
    response,
    'list_tests',
    request.filters,
    response.items.map((test) => ({
      filePath: test.filePath,
      offset: test.range.start.offset,
      key: test.key,
    })),
  );
  return response;
}

const linkContextSchema = z.strictObject({
  steps: z.array(testStepSchema).max(1000),
  evidenceRefs: z.array(sourceEvidenceSchema).max(5000),
});

export type LinkValidationContext = z.infer<typeof linkContextSchema>;

function supportingLinks(
  input: unknown,
  snapshotId: string,
  links: readonly TestCodeLink[],
  declarations: readonly (CodeSymbol | TestCase)[],
): void {
  linkContextSchema
    .superRefine((support, context) => {
      checkUnique(support.steps, context, ['steps']);
      checkStepHierarchy(support.steps, context);
      const evidence = indexEvidence(support.evidenceRefs, snapshotId, context);
      const steps = new Map(support.steps.map((step) => [step.id, step]));
      for (const declaration of declarations) {
        checkDeclaration(declaration, evidence, context, [
          'declarations',
          declaration.id,
        ]);
        if (
          'evidenceIds' in declaration &&
          declaration.evidenceIds.some((id) => !evidence.has(id))
        )
          context.addIssue({
            code: 'custom',
            message: 'Missing supporting declaration evidence',
          });
      }
      for (const step of support.steps) {
        if (
          step.snapshotId !== snapshotId ||
          step.evidenceIds.some((id) => !evidence.has(id))
        )
          context.addIssue({
            code: 'custom',
            path: ['steps', step.id],
            message: 'Invalid supporting step snapshot/evidence',
          });
        const parent =
          step.parentStepId === null ? undefined : steps.get(step.parentStepId);
        if (parent && parent.testId !== step.testId)
          context.addIssue({
            code: 'custom',
            path: ['steps', step.id],
            message: 'Invalid supporting parent step ownership',
          });
      }
      for (const link of links) {
        const step = steps.get(link.stepId);
        if (!step || step.testId !== link.testId)
          context.addIssue({
            code: 'custom',
            path: ['links', link.id, 'stepId'],
            message: 'Invalid link step ownership',
          });
        if (link.resolution.evidenceIds.some((id) => !evidence.has(id)))
          context.addIssue({
            code: 'custom',
            path: ['links', link.id],
            message: 'Missing supporting link evidence',
          });
        if (step)
          checkSite(
            link.siteEvidenceId,
            step.sourceEvidenceId,
            evidence,
            context,
            ['links', link.id, 'siteEvidenceId'],
          );
      }
    })
    .parse(input);
}

export function parseRelatedProductionSymbolsResult(
  requestInput: unknown,
  responseInput: unknown,
  context: unknown,
) {
  const request = relatedProductionSymbolsRequestSchema.parse(requestInput),
    response = relatedProductionSymbolsResponseSchema.parse(responseInput);
  ensure(
    request.testId === response.testId,
    'Related test selection does not match request',
    ['testId'],
  );
  pageChecks(
    request,
    response,
    'related_symbols',
    { testId: request.testId },
    response.items.map(({ symbol }) => ({
      filePath: symbol.filePath,
      offset: symbol.range.start.offset,
      key: symbol.key,
    })),
  );
  supportingLinks(
    context,
    request.snapshotId,
    response.items.flatMap((item) => item.links),
    response.items.map((item) => item.symbol),
  );
  return response;
}

export function parseFindTestsForSymbolResult(
  requestInput: unknown,
  responseInput: unknown,
  context: unknown,
) {
  const request = findTestsForSymbolRequestSchema.parse(requestInput),
    response = findTestsForSymbolResponseSchema.parse(responseInput);
  ensure(
    request.symbolId === response.symbolId,
    'Reverse symbol selection does not match request',
    ['symbolId'],
  );
  pageChecks(
    request,
    response,
    'tests_for_symbol',
    { symbolId: request.symbolId },
    response.items.map(({ test }) => ({
      filePath: test.filePath,
      offset: test.range.start.offset,
      key: test.key,
    })),
  );
  supportingLinks(
    context,
    request.snapshotId,
    response.items.flatMap((item) => item.links),
    response.items.map((item) => item.test),
  );
  return response;
}

export function parseGetTestTraceResult(
  requestInput: unknown,
  responseInput: unknown,
) {
  const request = getTestTraceRequestSchema.parse(requestInput),
    response = getTestTraceResponseSchema.parse(responseInput);
  snapshot(request.snapshotId, response.meta);
  ensure(
    request.testId === response.test.id,
    'Trace test selection does not match request',
    ['test', 'id'],
  );
  applied(response.meta, 'steps', request.stepLimit, response.steps.length);
  applied(
    response.meta,
    'symbols',
    request.symbolLimit,
    response.symbols.length,
  );
  applied(
    response.meta,
    'relationships',
    request.relationLimit,
    response.links.length + response.relations.length,
  );
  return response;
}
