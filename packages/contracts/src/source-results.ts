import {
  getSourceEvidenceRequestSchema,
  getSourceEvidenceResponseSchema,
  getDiagnosticsRequestSchema,
  getDiagnosticsResponseSchema,
} from './source-queries.js';
import { snapshot, applied, ensure, pageChecks } from './result-common.js';

/** Checks correspondence and structure; source-byte authenticity belongs to a source adapter. */
export function parseGetSourceEvidenceResult(
  requestInput: unknown,
  responseInput: unknown,
) {
  const request = getSourceEvidenceRequestSchema.parse(requestInput),
    response = getSourceEvidenceResponseSchema.parse(responseInput);
  snapshot(request.snapshotId, response.meta);
  applied(response.meta, 'evidence', 100, response.items.length);
  const returned = response.items.map((item) =>
    item.status === 'available' ? item.evidence.id : item.evidenceId,
  );
  ensure(
    returned.length === request.evidenceIds.length &&
      returned.every((id, index) => id === request.evidenceIds[index]),
    'Results must match requested evidence IDs and order',
    ['items'],
  );
  return response;
}

export function parseGetDiagnosticsResult(
  requestInput: unknown,
  responseInput: unknown,
) {
  const request = getDiagnosticsRequestSchema.parse(requestInput),
    response = getDiagnosticsResponseSchema.parse(responseInput);
  pageChecks(
    request,
    response,
    'diagnostics',
    request.filters,
    response.items.map((diagnostic) => ({
      filePath: diagnostic.filePath ?? '',
      offset: diagnostic.range?.start.offset ?? 0,
      key: diagnostic.id,
    })),
  );
  return response;
}
