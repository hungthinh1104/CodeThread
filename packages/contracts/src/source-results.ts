import {
  getSourceEvidenceRequestSchema,
  getSourceEvidenceResponseSchema,
  getDiagnosticsRequestSchema,
  getDiagnosticsResponseSchema,
  listSymbolsRequestSchema,
  listSymbolsResponseSchema,
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

function compareText(left: string, right: string): number {
  const a = new TextEncoder().encode(left),
    b = new TextEncoder().encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

export function parseListSymbolsResult(
  requestInput: unknown,
  responseInput: unknown,
) {
  const request = listSymbolsRequestSchema.parse(requestInput),
    response = listSymbolsResponseSchema.parse(responseInput),
    end = request.offset + response.items.length,
    hasMore = response.total > end;
  snapshot(request.snapshotId, response.meta);
  applied(response.meta, 'pageSize', request.limit, response.items.length);
  ensure(
    response.total >= end &&
      response.nextOffset === (hasMore ? end : null) &&
      response.meta.truncated === hasMore &&
      response.meta.truncationReasons.join(',') ===
        (hasMore ? 'result_limit' : ''),
    'Symbol page continuation and truncation metadata are inconsistent',
    ['nextOffset'],
  );
  let previous: (typeof response.items)[number] | undefined;
  for (const [index, item] of response.items.entries()) {
    ensure(
      item.name.toLowerCase().includes(request.query.toLowerCase()) ||
        item.filePath.toLowerCase().includes(request.query.toLowerCase()),
      'Symbol does not match the requested filter',
      ['items', index],
    );
    if (previous)
      ensure(
        compareText(previous.filePath, item.filePath) < 0 ||
          (previous.filePath === item.filePath &&
            (previous.range.start.offset < item.range.start.offset ||
              (previous.range.start.offset === item.range.start.offset &&
                compareText(previous.key, item.key) < 0))),
        'Symbols must follow deterministic source order',
        ['items', index],
      );
    previous = item;
  }
  return response;
}
