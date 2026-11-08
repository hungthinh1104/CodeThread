import {
  getSourceEvidenceRequestSchema,
  parseGetSourceEvidenceResult,
} from '@codethread/contracts';
import type { VerifiedSourceReader } from '@codethread/code-model';
import type { InvestigationContext } from './context.js';
import { sameRange } from './fact-integrity.js';
import { createMetadata } from './projection.js';

export function sourceEvidence(
  context: InvestigationContext,
  requestInput: unknown,
) {
  const { scope, facts, evidence, files, retained, readEvidence } = context;
  const request = getSourceEvidenceRequestSchema.parse(requestInput);
  scope(request.snapshotId);
  const items = request.evidenceIds.map((id) => {
    const unavailable = (
      code: 'EVIDENCE_NOT_FOUND' | 'EVIDENCE_TOO_LARGE' | 'SOURCE_UNAVAILABLE',
    ) => ({
      status: 'unavailable' as const,
      snapshotId: facts.snapshotId,
      evidenceId: id,
      code,
    });
    const expected = evidence.get(id);
    if (!expected) return unavailable('EVIDENCE_NOT_FOUND');
    if (expected.range.end.offset - expected.range.start.offset > 65536)
      return unavailable('EVIDENCE_TOO_LARGE');
    const file = files.get(expected.fileId)!,
      original = retained.get(file.id)!;
    const text = original.text.slice(
      expected.range.start.offset,
      expected.range.end.offset,
    );
    let result: ReturnType<VerifiedSourceReader['readEvidence']>;
    try {
      result = readEvidence(id);
    } catch {
      return unavailable('SOURCE_UNAVAILABLE');
    }
    if (result.status !== 'available')
      return result.snapshotId === facts.snapshotId && result.evidenceId === id
        ? result
        : unavailable('SOURCE_UNAVAILABLE');
    const actual = result.evidence;
    if (
      actual.id !== expected.id ||
      actual.snapshotId !== expected.snapshotId ||
      actual.fileId !== expected.fileId ||
      actual.contentHash !== expected.contentHash ||
      actual.kind !== expected.kind ||
      actual.extractor.name !== expected.extractor.name ||
      actual.extractor.version !== expected.extractor.version ||
      !sameRange(actual.range, expected.range) ||
      result.filePath !== file.path ||
      result.text !== text
    )
      return unavailable('SOURCE_UNAVAILABLE');
    return {
      status: 'available' as const,
      evidence: expected,
      filePath: file.path,
      text,
    };
  });
  return parseGetSourceEvidenceResult(request, {
    meta: createMetadata(context, { evidence: 100 }, new Set()),
    items,
  });
}
