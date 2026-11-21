import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  hashSchema,
  snapshotPathSchema,
  sourceRangeSchema,
  sourcePositionSchema,
} from '@codethread/code-model';
import { z } from 'zod';

export const repositoryGoldAnchorSchema = z
  .strictObject({
    file: snapshotPathSchema,
    sourceSha256: hashSchema,
    start: sourcePositionSchema,
    end: sourcePositionSchema,
  })
  .superRefine((value, context) => {
    if (
      !sourceRangeSchema.safeParse({ start: value.start, end: value.end })
        .success
    )
      context.addIssue({
        code: 'custom',
        message: 'Invalid gold source range',
      });
  });
const label = z
  .strictObject({
    repository: z.enum(['ufo', 'sourcemaps']),
    revision: z.string().regex(/^[a-f0-9]{40}$/),
    configPath: snapshotPathSchema,
    owner: repositoryGoldAnchorSchema,
    site: repositoryGoldAnchorSchema,
    expression: z.string().min(1).max(256),
    status: z.enum(['exact', 'unresolved', 'unsupported', 'ambiguous']),
    target: repositoryGoldAnchorSchema.nullable(),
  })
  .superRefine((value, context) => {
    if (
      (value.status === 'exact') !== (value.target !== null) ||
      value.owner.file !== value.site.file ||
      value.owner.sourceSha256 !== value.site.sourceSha256
    )
      context.addIssue({
        code: 'custom',
        message: 'Invalid gold relationship or owner',
      });
  });
export const repositoryGoldSchema = z.strictObject({
  version: z.literal(2),
  author: z.literal('Codex'),
  reviewStatus: z.literal('not_independently_reviewed'),
  authoredBeforePredictions: z.boolean(),
  originalLabelsAuthoredBeforePredictions: z.literal(true),
  corrections: z
    .array(
      z.strictObject({
        repository: z.enum(['ufo', 'sourcemaps']),
        configPath: snapshotPathSchema,
        site: repositoryGoldAnchorSchema,
        previousStatus: z.literal('exact'),
        revisedStatus: z.literal('unsupported'),
        previousTarget: repositoryGoldAnchorSchema,
        overloadSignatures: z.literal(2),
        trigger: z.literal('post_prediction_source_review'),
        reason: z.string().min(1).max(512),
      }),
    )
    .max(1000),
  closedOwners: z
    .array(
      z.strictObject({
        repository: z.enum(['ufo', 'sourcemaps']),
        configPath: snapshotPathSchema,
        owner: repositoryGoldAnchorSchema,
      }),
    )
    .min(1)
    .max(100),
  labels: z.array(label).min(1).max(1000),
});
export type RepositoryGold = z.infer<typeof repositoryGoldSchema>;
export type RepositoryGoldAnchor = z.infer<typeof repositoryGoldAnchorSchema>;
export type RepositoryGoldLabel = z.infer<typeof label>;

// Preserve the original labels and exclusions as a single historical record.
export const historicalRepositoryGoldSha256 =
  '98eae570e125786f542a1b8ea6adc6bdf083075f0c7c94fafaa9fc3ea24a7cc2';

export function verifyHistoricalRepositoryGold(input: unknown): RepositoryGold {
  const gold = repositoryGoldSchema.parse(input);
  const digest = createHash('sha256')
    .update(JSON.stringify(gold))
    .digest('hex');
  if (digest !== historicalRepositoryGoldSha256)
    throw new Error('Historical gold or its correction denominator changed');
  return gold;
}

export async function loadRepositoryGold(): Promise<RepositoryGold> {
  return verifyHistoricalRepositoryGold(
    JSON.parse(
      await readFile('fixtures/external/repository-gold.json', 'utf8'),
    ),
  );
}
