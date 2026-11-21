import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  loadRepositoryReview,
  verifyReviewMaintainerSignature,
  verifyReviewManifest,
} from '../scripts/repository-review.ts';

it('checks the signature over the exact source response, reviewer and ledger record', async () => {
  const review = await loadRepositoryReview();
  const record = {
    scopeId: review.freeze.scopes[0]!.id,
    frozenInputSha256: review.frozenInputSha256,
    reviewerAlias: 'synthetic-signature-control',
    reviewerDidNotAuthorLabels: true,
    reviewedAt: review.freeze.frozenAt,
    method: 'blind_authored',
    exposure: 'none',
    disposition: 'accepted',
    answers: [],
    disagreements: [],
    adjudication: null,
  };
  const recordSha256 = createHash('sha256')
    .update(JSON.stringify(record))
    .digest('hex');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const maintainerKeyId = createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex');
  const attestation = {
    maintainerKeyId,
    reviewerAccountId: '12345',
    responseSha256: 'a'.repeat(64),
    verifiedAt: review.freeze.frozenAt,
    signature: '',
  };
  const message = Buffer.from(
    JSON.stringify([
      'codethread/repository-review/v2',
      recordSha256,
      maintainerKeyId,
      '12345',
      'a'.repeat(64),
      review.freeze.frozenAt,
    ]),
  );
  attestation.signature = sign(null, message, privateKey).toString('base64url');
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  expect(verifyReviewMaintainerSignature(recordSha256, attestation, pem)).toBe(
    true,
  );
  expect(
    verifyReviewMaintainerSignature('b'.repeat(64), attestation, pem),
  ).toBe(false);
  expect(
    verifyReviewMaintainerSignature(
      recordSha256,
      {
        ...attestation,
        responseSha256: 'c'.repeat(64),
      },
      pem,
    ),
  ).toBe(false);
  expect(
    verifyReviewMaintainerSignature(
      recordSha256,
      {
        ...attestation,
        reviewerAccountId: '12346',
      },
      pem,
    ),
  ).toBe(false);
  expect(() =>
    verifyReviewManifest({
      ...review,
      records: [
        {
          ...record,
          recordSha256,
          maintainerAttestation: attestation,
        },
      ],
    }),
  ).toThrow(/untrusted maintainer key/);
});
