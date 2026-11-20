import { summarizeCoverage } from '@codethread/code-model';
import type { CodeSymbol } from '@codethread/code-model';
import {
  getSourceEvidenceRequestSchema,
  graphNeighborsRequestSchema,
  parseGetSourceEvidenceResult,
  parseGraphNeighborsResult,
  viewerGraphResponseSchema,
  viewerSessionResponseSchema,
  viewerSymbolSearchResponseSchema,
} from '@codethread/contracts';
import type { AnalysisSnapshot } from '@codethread/symbol-indexer';
import type { createInvestigation } from '@codethread/trace-engine';
import { z } from 'zod';
import { ViewerFailure } from './viewer-errors.ts';

const MAX_SYMBOLS_PER_PAGE = 50;
const MAX_GRAPH_DEPTH = 2;
const MAX_GRAPH_NODES = 50;
const MAX_UNKNOWN_ROWS = 50;
const ORDER = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left), Buffer.from(right));

export const sessionResponseSchema = viewerSessionResponseSchema;
const symbolSearchRequestSchema = z.strictObject({
  query: z.string().max(256).default(''),
  offset: z.number().int().min(0).max(20000).default(0),
});
export const symbolSearchResponseSchema = viewerSymbolSearchResponseSchema;

function compareSymbols(left: CodeSymbol, right: CodeSymbol): number {
  return (
    ORDER(left.filePath, right.filePath) ||
    left.range.start.offset - right.range.start.offset ||
    ORDER(left.key, right.key)
  );
}

export function querySnapshot(
  snapshot: AnalysisSnapshot,
  investigation: ReturnType<typeof createInvestigation>,
  pathname: string,
  body: unknown,
): unknown {
  if (pathname === '/api/session') {
    z.strictObject({}).parse(body);
    return sessionResponseSchema.parse({
      snapshotId: snapshot.facts.snapshotId,
      identity: snapshot.facts.identity,
      counts: snapshot.facts.counts,
      coverage: summarizeCoverage(snapshot.facts.coverageByCapability),
      coverageByCapability: snapshot.facts.coverageByCapability,
    });
  }
  if (pathname === '/api/symbols') {
    const query = symbolSearchRequestSchema.parse(body);
    const normalized = query.query.toLowerCase();
    const matches = [...snapshot.facts.symbols]
      .sort(compareSymbols)
      .filter(
        (symbol) =>
          normalized.length === 0 ||
          symbol.name.toLowerCase().includes(normalized) ||
          symbol.filePath.toLowerCase().includes(normalized),
      );
    const items = matches.slice(
      query.offset,
      query.offset + MAX_SYMBOLS_PER_PAGE,
    );
    const next = query.offset + items.length;
    const result = symbolSearchResponseSchema.parse({
      snapshotId: snapshot.facts.snapshotId,
      query: query.query,
      offset: query.offset,
      limit: MAX_SYMBOLS_PER_PAGE,
      total: matches.length,
      nextOffset: next < matches.length ? next : null,
      items,
    });
    return result;
  }
  if (pathname === '/api/neighbors') {
    const request = graphNeighborsRequestSchema.parse(body);
    if (
      request.depth > MAX_GRAPH_DEPTH ||
      request.nodeLimit > MAX_GRAPH_NODES ||
      request.relationKinds.some(
        (kind) => kind !== 'calls' && kind !== 'references',
      )
    )
      throw new ViewerFailure(
        'INVALID_REQUEST',
        'Graph request exceeds the visual investigation profile.',
        400,
      );
    const graph = parseGraphNeighborsResult(
      request,
      investigation.neighbors(request),
    );
    const owned = snapshot.facts.observations.filter(
      (item) =>
        item.ownerId === request.symbolId &&
        item.status !== 'exact' &&
        item.relationId === null,
    );
    const diagnostics = new Map(
      snapshot.facts.diagnostics.map((item) => [item.id, item]),
    );
    const unknowns = {
      total: owned.length,
      items: owned.slice(0, MAX_UNKNOWN_ROWS).map((item) => ({
        evidenceId: item.evidenceId,
        status: item.status,
        diagnostic: item.diagnosticId
          ? (diagnostics.get(item.diagnosticId) ?? null)
          : null,
      })),
    };
    const result = viewerGraphResponseSchema.parse({ graph, unknowns });
    return result;
  }
  if (pathname === '/api/evidence') {
    const evidenceRequest = getSourceEvidenceRequestSchema.parse(body);
    const result = parseGetSourceEvidenceResult(
      evidenceRequest,
      investigation.sourceEvidence(evidenceRequest),
    );
    return result;
  }

  throw new ViewerFailure('NOT_FOUND', 'Resource not found.', 404);
}
