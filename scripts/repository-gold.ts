import { readFile } from 'node:fs/promises';
import {
  hashSchema,
  snapshotPathSchema,
  sourceRangeSchema,
  sourcePositionSchema,
} from '@codethread/code-model';
import { z } from 'zod';

const anchor = z
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
    owner: anchor,
    site: anchor,
    expression: z.string().min(1).max(256),
    status: z.enum(['exact', 'unresolved', 'unsupported', 'ambiguous']),
    target: anchor.nullable(),
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
const schema = z.strictObject({
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
        site: anchor,
        previousStatus: z.literal('exact'),
        revisedStatus: z.literal('unsupported'),
        previousTarget: anchor,
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
        owner: anchor,
      }),
    )
    .min(1)
    .max(100),
  labels: z.array(label).min(1).max(1000),
});
export type RepositoryGold = z.infer<typeof schema>;
export type RepositoryGoldAnchor = z.infer<typeof anchor>;
export type RepositoryGoldLabel = z.infer<typeof label>;
export async function loadRepositoryGold(): Promise<RepositoryGold> {
  return schema.parse(
    JSON.parse(
      await readFile('fixtures/external/repository-gold.json', 'utf8'),
    ),
  );
}
