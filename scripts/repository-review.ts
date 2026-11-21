import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  codeRelationKindSchema,
  hashSchema,
  idSchema,
  snapshotPathSchema,
} from '@codethread/code-model';
import ts from 'typescript';
import { z } from 'zod';
import type { RepositoryCorpus } from './repository-corpus.ts';
import {
  historicalRepositoryGoldSha256,
  repositoryGoldAnchorSchema,
  verifyHistoricalRepositoryGold,
} from './repository-gold.ts';
import type { RepositoryGold } from './repository-gold.ts';
import {
  equalGoldRange,
  goldSiteKey,
  inventoryGoldOwner,
  pinnedSourceExcerpt,
  verifyGoldDeclarationAnchor,
} from './repository-gold-source.ts';
import type { GoldOwnerInventory } from './repository-gold-source.ts';

const repository = z.enum(['ufo', 'sourcemaps']);
const frozenReviewInputSha256 =
  '9a88d0bb205710558445ebf380dc7ffb69d05b226e3627d3f863e56cb4f9ed45';
// Public Ed25519 keys are pinned by a reviewed change after confirming ownership.
const trustedMaintainerKeys: ReadonlyMap<string, string> = new Map();
const revision = z.string().regex(/^[a-f0-9]{40}$/);
const location = { repository, configPath: snapshotPathSchema };
const scopeId = z.string().regex(/^[a-z0-9-]{1,80}$/);
const reviewerAlias = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine(
    (name) => name.toLowerCase() !== 'codex',
    'An independent reviewer must differ from the original author',
  );
const scopeSchema = z.strictObject({
  id: scopeId,
  ...location,
  owner: repositoryGoldAnchorSchema,
  inventorySha256: hashSchema,
  occurrences: z.number().int().min(0).max(200),
});
const contextSchema = z.strictObject({
  ...location,
  projectId: z.string().regex(/^project:[a-f0-9]{24}$/),
  configurationHash: hashSchema,
  sourceFingerprint: hashSchema,
});
const freezeSchema = z.strictObject({
  frozenAt: z.iso.date(),
  baselineSha: revision,
  worksheetSha256: hashSchema,
  compilerVersion: z.literal('6.0.3'),
  repositoryId: idSchema,
  sources: z
    .array(z.strictObject({ repository, revision, manifestSha256: hashSchema }))
    .length(2),
  contexts: z.array(contextSchema).min(1).max(32),
  scopes: z.array(scopeSchema).min(1).max(32),
  inventoryVersion: z.literal(2),
  supersedesFrozenInputSha256: z.literal(
    'ee9aa1c3e0d7aee70301119d8eb53c3ac470a7a5b74cdbfe3bd62cf67a0de526',
  ),
});

const responseSchema = z.strictObject({
  site: repositoryGoldAnchorSchema,
  excerpt: z.string().min(1).max(16384),
  kind: codeRelationKindSchema,
  direction: z.literal('owner_to_target').nullable(),
  status: z.enum(['exact', 'unresolved', 'ambiguous', 'unsupported', 'absent']),
  target: repositoryGoldAnchorSchema.nullable(),
  rationale: z.string().trim().min(1).max(2048),
});

const attestationSchema = z.strictObject({
  maintainerKeyId: hashSchema,
  reviewerAccountId: z.string().regex(/^[1-9][0-9]{0,19}$/),
  responseSha256: hashSchema,
  verifiedAt: z.iso.date(),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});
type ReviewAttestation = z.infer<typeof attestationSchema>;

const recordSchema = z.strictObject({
  scopeId,
  frozenInputSha256: hashSchema,
  reviewerAlias,
  reviewerDidNotAuthorLabels: z.literal(true),
  reviewedAt: z.iso.date(),
  method: z.enum(['review_existing', 'blind_authored']),
  exposure: z.enum(['none', 'labels_only', 'predictions', 'unknown']),
  disposition: z.enum(['accepted', 'disputed', 'excluded']),
  answers: z.array(responseSchema).max(200),
  disagreements: z.array(z.string().trim().min(1).max(2048)).max(200),
  adjudication: z
    .strictObject({
      reviewerAlias,
      decidedAt: z.iso.date(),
      decision: z.enum(['accept_recorded_answers', 'exclude', 'pending']),
      rationale: z.string().trim().min(1).max(2048),
    })
    .nullable(),
  recordSha256: hashSchema,
  maintainerAttestation: attestationSchema.optional(),
});

const reviewSchema = z.strictObject({
  version: z.literal(2),
  historicalGoldSha256: z.literal(historicalRepositoryGoldSha256),
  freeze: freezeSchema,
  frozenInputSha256: hashSchema,
  records: z.array(recordSchema).max(32),
});
export type RepositoryReview = z.infer<typeof reviewSchema>;
export type ScopedReviewRecord = z.infer<typeof recordSchema>;

const hash = (data: string | Uint8Array) =>
  createHash('sha256').update(data).digest('hex');
const jsonHash = (value: unknown) => hash(JSON.stringify(value));

export function verifyReviewMaintainerSignature(
  recordSha256: string,
  attestation: ReviewAttestation,
  publicKeyPem: string,
): boolean {
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') return false;
  const keyId = hash(key.export({ format: 'der', type: 'spki' }));
  if (attestation.maintainerKeyId !== keyId) return false;
  const message = Buffer.from(
    JSON.stringify([
      'codethread/repository-review/v2',
      recordSha256,
      keyId,
      attestation.reviewerAccountId,
      attestation.responseSha256,
      attestation.verifiedAt,
    ]),
  );
  return verify(
    null,
    message,
    key,
    Buffer.from(attestation.signature, 'base64url'),
  );
}

function assertUnique(keys: readonly string[], message: string): void {
  assert.equal(new Set(keys).size, keys.length, message);
}

export function verifyReviewManifest(input: unknown): RepositoryReview {
  const manifest = reviewSchema.parse(input);
  const { freeze, frozenInputSha256, records } = manifest;
  assert.equal(
    frozenInputSha256,
    frozenReviewInputSha256,
    'Review ledger does not name the pinned input freeze',
  );
  assert.equal(
    jsonHash(freeze),
    frozenInputSha256,
    'Frozen review input changed',
  );
  assert.equal(
    ts.version,
    freeze.compilerVersion,
    'Review compiler version changed',
  );
  assertUnique(
    freeze.sources.map((source) => source.repository),
    'Duplicate review source',
  );
  assertUnique(
    freeze.contexts.map((context) =>
      JSON.stringify([context.repository, context.configPath]),
    ),
    'Duplicate review compiler context',
  );
  assertUnique(
    freeze.scopes.map((scope) => scope.id),
    'Duplicate review scope',
  );
  assertUnique(
    freeze.scopes.map((scope) =>
      JSON.stringify([
        scope.repository,
        scope.configPath,
        goldSiteKey(scope.owner.file, scope.owner),
      ]),
    ),
    'Duplicate review owner',
  );
  assertUnique(
    records.map((record) => record.scopeId),
    'Duplicate review disposition',
  );
  for (const { recordSha256, maintainerAttestation, ...record } of records) {
    assert(
      freeze.scopes.some((scope) => scope.id === record.scopeId),
      'Review has no frozen scope',
    );
    assert.equal(
      record.frozenInputSha256,
      frozenInputSha256,
      'Review is for different frozen inputs',
    );
    assert.equal(
      jsonHash(record),
      recordSha256,
      'Review evidence or provenance changed',
    );
    assert(
      record.reviewedAt >= freeze.frozenAt,
      'Review predates the input freeze',
    );
    if (maintainerAttestation) {
      const key = trustedMaintainerKeys.get(
        maintainerAttestation.maintainerKeyId,
      );
      assert(key, 'Review attestation uses an untrusted maintainer key');
      assert(
        maintainerAttestation.verifiedAt >=
          (record.adjudication?.decidedAt ?? record.reviewedAt) &&
          verifyReviewMaintainerSignature(
            recordSha256,
            maintainerAttestation,
            key,
          ),
        'Review attestation does not bind the verified response and record',
      );
    }
    if (record.disposition !== 'accepted') continue;
    assert(
      record.exposure === 'none' ||
        (record.method === 'review_existing' &&
          record.exposure === 'labels_only'),
      'Accepted review was exposed to predictions or cannot establish its exposure',
    );
    if (record.disagreements.length || record.adjudication)
      assert(
        record.adjudication?.decision === 'accept_recorded_answers' &&
          record.adjudication.reviewerAlias.toLowerCase() !==
            record.reviewerAlias.toLowerCase() &&
          record.adjudication.decidedAt >= record.reviewedAt,
        'Accepted disagreements require a dated independent adjudication',
      );
  }
  return manifest;
}

export async function loadRepositoryReview(): Promise<RepositoryReview> {
  const [worksheet, ledger] = await Promise.all([
    readFile('fixtures/external/BLIND-REVIEW-v2.md'),
    readFile('fixtures/external/repository-review-v2.json', 'utf8'),
  ]);
  const review = verifyReviewManifest(JSON.parse(ledger));
  assert.equal(
    hash(worksheet),
    review.freeze.worksheetSha256,
    'Blind review worksheet changed',
  );
  assert(
    review.records.every(
      ({ disposition, maintainerAttestation }) =>
        disposition !== 'accepted' || maintainerAttestation !== undefined,
    ),
    'Canonical accepted review requires a trusted maintainer attestation',
  );
  return review;
}

export function verifyRepositoryReview(
  input: RepositoryReview,
  corpus: RepositoryCorpus,
  historical: RepositoryGold,
) {
  const review = verifyReviewManifest(input);
  const gold = verifyHistoricalRepositoryGold(historical);
  const frozen = review.freeze.sources.find(
    (source) => source.repository === corpus.name,
  );
  assert(
    frozen?.revision === corpus.manifest.revision &&
      frozen.manifestSha256 === corpus.manifestSha256,
    'Pinned source manifest differs from the review inputs',
  );
  const scopes = review.freeze.scopes
    .filter((scope) => scope.repository === corpus.name)
    .map((scope) => {
      assert(
        review.freeze.contexts.some(
          (context) =>
            context.repository === scope.repository &&
            context.configPath === scope.configPath,
        ),
        'Review scope has no frozen compiler context',
      );
      const inventory = inventoryGoldOwner(corpus, scope.owner);
      assert.equal(
        inventory.sites.length,
        scope.occurrences,
        'Frozen occurrence denominator changed',
      );
      assert.equal(
        jsonHash(inventory.sites),
        scope.inventorySha256,
        'Frozen occurrence anchors changed',
      );
      const record = review.records.find((item) => item.scopeId === scope.id);
      const accepted = record?.disposition === 'accepted' ? record : undefined;
      if (accepted)
        verifyAcceptedAnswers(accepted, scope, inventory.sites, corpus, gold);
      return { ...scope, inventory, record, accepted };
    });
  return { review, scopes, gold };
}

function verifyAcceptedAnswers(
  record: ScopedReviewRecord,
  scope: z.infer<typeof scopeSchema>,
  inventory: GoldOwnerInventory['sites'],
  corpus: RepositoryCorpus,
  gold: RepositoryGold,
): void {
  assert.equal(
    record.answers.length,
    inventory.length,
    'Reviewed denominator does not cover the complete owner',
  );
  assertUnique(
    record.answers.map((answer) => goldSiteKey(answer.site.file, answer.site)),
    'Duplicate reviewed occurrence',
  );
  for (const answer of record.answers) {
    assert(
      inventory.some(
        ({ site, kind }) =>
          kind === answer.kind &&
          site.file === answer.site.file &&
          site.sourceSha256 === answer.site.sourceSha256 &&
          equalGoldRange(site, answer.site),
      ),
      'Reviewed occurrence is outside the frozen syntax inventory',
    );
    assert.equal(
      pinnedSourceExcerpt(corpus, answer.site),
      answer.excerpt,
      'Reviewed occurrence excerpt differs from pinned source',
    );
    assert.equal(
      answer.target !== null,
      answer.status === 'exact',
      'Reviewed target and status disagree',
    );
    assert.equal(
      answer.direction,
      answer.target ? 'owner_to_target' : null,
      'Reviewed direction and status disagree',
    );
    if (answer.target) verifyGoldDeclarationAnchor(corpus, answer.target);
    if (record.method !== 'review_existing') continue;
    const sameSite = (item: {
      repository: string;
      configPath: string;
      site: typeof answer.site;
    }) =>
      item.repository === scope.repository &&
      item.configPath === scope.configPath &&
      item.site.file === answer.site.file &&
      equalGoldRange(item.site, answer.site);
    assert(
      !gold.corrections.some(sameSite),
      'Post-prediction corrections cannot be accepted as existing labels',
    );
    const original = gold.labels.find(sameSite);
    if (original) {
      assert.equal(
        answer.kind,
        'calls',
        'A reviewed existing label changed kind',
      );
      assert.equal(
        answer.status,
        original.status,
        'A reviewed existing label changed status',
      );
      assert.deepEqual(
        answer.target,
        original.target,
        'A reviewed existing label changed target',
      );
    }
  }
}
