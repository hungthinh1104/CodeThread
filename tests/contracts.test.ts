import { describe, expect, it } from 'vitest';
import {
  decodeCursor,
  encodeCursor,
  filterKey,
  findSymbolPathsRequestSchema,
  findSymbolPathsResponseSchema,
  findTestsForSymbolRequestSchema,
  findTestsForSymbolResponseSchema,
  getDiagnosticsRequestSchema,
  getDiagnosticsResponseSchema,
  getSourceEvidenceRequestSchema,
  getSourceEvidenceResponseSchema,
  getTestTraceRequestSchema,
  getTestTraceResponseSchema,
  graphNeighborsRequestSchema,
  graphNeighborsResponseSchema,
  listTestsRequestSchema,
  listTestsResponseSchema,
  relatedProductionSymbolsRequestSchema,
  relatedProductionSymbolsResponseSchema,
} from '@codethread/contracts';
import { id, range, snapshotId, traceFixture } from './fixtures/trace.ts';

describe('CT-DB-012 query inputs and scoped cursors', () => {
  it('applies bounded defaults to all primary requests', () => {
    expect(listTestsRequestSchema.parse({ snapshotId }).limit).toBe(50);
    expect(
      getTestTraceRequestSchema.parse({ snapshotId, testId: id(3) }).stepLimit,
    ).toBe(500);
    expect(
      relatedProductionSymbolsRequestSchema.parse({ snapshotId, testId: id(3) })
        .limit,
    ).toBe(50);
    expect(
      findTestsForSymbolRequestSchema.parse({ snapshotId, symbolId: id(7) })
        .limit,
    ).toBe(50);
    expect(getDiagnosticsRequestSchema.parse({ snapshotId }).filters).toEqual(
      {},
    );
    expect(
      getSourceEvidenceRequestSchema.parse({ snapshotId, evidenceIds: [id(5)] })
        .evidenceIds,
    ).toHaveLength(1);
    expect(
      graphNeighborsRequestSchema.parse({ snapshotId, symbolId: id(7) }).depth,
    ).toBe(2);
    expect(
      findSymbolPathsRequestSchema.parse({
        snapshotId,
        fromSymbolId: id(7),
        toSymbolId: id(8),
      }).pathLimit,
    ).toBe(20);
  });
  it('rejects unbounded pages, batches, traces and traversal', () => {
    expect(
      listTestsRequestSchema.safeParse({ snapshotId, limit: 201 }).success,
    ).toBe(false);
    expect(
      getTestTraceRequestSchema.safeParse({
        snapshotId,
        testId: id(3),
        stepLimit: 501,
      }).success,
    ).toBe(false);
    expect(
      getSourceEvidenceRequestSchema.safeParse({
        snapshotId,
        evidenceIds: [id(5), id(5)],
      }).success,
    ).toBe(false);
    expect(
      getSourceEvidenceRequestSchema.safeParse({
        snapshotId,
        evidenceIds: Array.from({ length: 101 }, (_, index) => id(index + 100)),
      }).success,
    ).toBe(false);
    expect(
      graphNeighborsRequestSchema.safeParse({
        snapshotId,
        symbolId: id(7),
        depth: 6,
      }).success,
    ).toBe(false);
    expect(
      findSymbolPathsRequestSchema.safeParse({
        snapshotId,
        fromSymbolId: id(7),
        toSymbolId: id(8),
        pathLimit: 21,
      }).success,
    ).toBe(false);
  });
  it('round-trips Unicode cursors and rejects reuse across snapshot, filters, query or ordering', () => {
    const payload = {
      version: 1 as const,
      snapshotId,
      query: 'list_tests' as const,
      filterKey: filterKey({ text: 'café 😀' }),
      order: 'source-v1' as const,
      position: { filePath: 'café.test.ts', offset: 4, key: 'test:😀' },
    };
    const cursor = encodeCursor(payload);
    expect(decodeCursor(cursor)).toEqual(payload);
    expect(() =>
      encodeCursor({ ...payload, filterKey: '界'.repeat(4096) }),
    ).toThrow('INVALID_CURSOR');
    expect(
      listTestsRequestSchema.safeParse({
        snapshotId,
        filters: { text: 'café 😀' },
        cursor,
      }).success,
    ).toBe(true);
    expect(
      listTestsRequestSchema.safeParse({
        snapshotId: id(2),
        filters: { text: 'café 😀' },
        cursor,
      }).success,
    ).toBe(false);
    expect(
      listTestsRequestSchema.safeParse({ snapshotId, cursor }).success,
    ).toBe(false);
    expect(
      getDiagnosticsRequestSchema.safeParse({ snapshotId, cursor }).success,
    ).toBe(false);
    expect(() =>
      encodeCursor({ ...payload, order: 'other' } as never),
    ).toThrow();
    expect(() => decodeCursor('not_a_cursor')).toThrow('INVALID_CURSOR');
    expect(filterKey({ b: 1, a: 2 })).toBe(filterKey({ a: 2, b: 1 }));
  });
});

describe('CT-DB-002 / CT-TRACE-001 shared trace projection', () => {
  it('accepts partial static coverage and preserves separate call occurrences', () => {
    const trace = traceFixture();
    trace.relations.push({
      ...trace.relations[0]!,
      id: id(12),
      key: 'call:site:1',
      siteEvidenceId: id(13),
      resolution: { status: 'exact', targetId: id(8), evidenceIds: [id(13)] },
    });
    trace.evidenceRefs.push({
      ...trace.evidenceRefs[0]!,
      id: id(13),
      range: {
        start: { offset: 4, line: 1, column: 5 },
        end: { offset: 7, line: 1, column: 8 },
      },
    });
    expect(getTestTraceResponseSchema.parse(trace).relations).toHaveLength(2);
    expect(getTestTraceResponseSchema.parse(trace).meta.coverage).toBe(
      'partial',
    );
  });
  it('rejects cross-snapshot facts and dangling targets even on truncated responses', () => {
    const trace = traceFixture();
    trace.symbols[0]!.snapshotId = id(2);
    expect(getTestTraceResponseSchema.safeParse(trace).success).toBe(false);
    const truncated = traceFixture();
    truncated.meta.truncated = true;
    truncated.meta.truncationReasons = ['result_limit'];
    truncated.symbols.pop();
    expect(getTestTraceResponseSchema.safeParse(truncated).success).toBe(false);
  });
  it('requires evidence, diagnostics and valid step ownership', () => {
    const missingEvidence = traceFixture();
    missingEvidence.evidenceRefs.pop();
    expect(getTestTraceResponseSchema.safeParse(missingEvidence).success).toBe(
      false,
    );
    const wrongOwner = traceFixture();
    wrongOwner.steps[0]!.testId = id(99);
    expect(getTestTraceResponseSchema.safeParse(wrongOwner).success).toBe(
      false,
    );
    const cycle = traceFixture();
    cycle.steps[0]!.parentStepId = id(6);
    expect(getTestTraceResponseSchema.safeParse(cycle).success).toBe(false);
    const unresolved = traceFixture();
    unresolved.links[0]!.resolution = {
      status: 'unresolved',
      targetId: null,
      evidenceIds: [id(5)],
      diagnosticIds: [id(14)],
    };
    expect(getTestTraceResponseSchema.safeParse(unresolved).success).toBe(
      false,
    );
    unresolved.diagnostics.push({
      snapshotId,
      id: id(14),
      code: 'TARGET_UNRESOLVED',
      severity: 'warning',
      message: 'No exact target',
      fileId: id(4),
      range,
    });
    expect(getTestTraceResponseSchema.safeParse(unresolved).success).toBe(true);
  });
  it('does not accept fabricated runtime or passing-assertion fields', () => {
    const trace = traceFixture();
    expect(
      getTestTraceResponseSchema.safeParse({ ...trace, passed: true }).success,
    ).toBe(false);
    expect(
      getTestTraceResponseSchema.safeParse({
        ...trace,
        meta: { ...trace.meta, evidenceBasis: 'runtime' },
      }).success,
    ).toBe(false);
    expect(
      getTestTraceResponseSchema.safeParse({
        ...trace,
        steps: [{ ...trace.steps[0], executed: true }],
      }).success,
    ).toBe(false);
    expect(
      getTestTraceResponseSchema.safeParse({
        ...trace,
        meta: { ...trace.meta, truncated: true },
      }).success,
    ).toBe(false);
  });
});

describe('Primary response schemas and bounded traversal', () => {
  it('enforces declared result budgets and unique identities rather than just array maxima', () => {
    const trace = traceFixture();
    expect(
      getTestTraceResponseSchema.safeParse({
        ...trace,
        meta: {
          ...trace.meta,
          appliedLimits: { ...trace.meta.appliedLimits, relationships: 1 },
        },
      }).success,
    ).toBe(false);
    const meta = { ...trace.meta, appliedLimits: { pageSize: 1 } };
    expect(
      listTestsResponseSchema.safeParse({
        meta,
        items: [trace.test, { ...trace.test, id: id(100), key: 'test:100' }],
        nextCursor: null,
      }).success,
    ).toBe(false);
    expect(
      listTestsResponseSchema.safeParse({
        meta: { ...meta, appliedLimits: { pageSize: 50 } },
        items: [trace.test, trace.test],
        nextCursor: null,
      }).success,
    ).toBe(false);
    expect(
      getSourceEvidenceResponseSchema.safeParse({
        meta: { ...meta, appliedLimits: { evidence: 100 } },
        items: [
          {
            status: 'available',
            evidence: trace.evidenceRefs[0],
            filePath: 'example.test.ts',
            text: 'abc',
          },
          {
            status: 'unavailable',
            snapshotId,
            evidenceId: trace.evidenceRefs[0]!.id,
            code: 'SOURCE_UNAVAILABLE',
          },
        ],
      }).success,
    ).toBe(false);
  });
  it('requires a scoped continuation and explicit truncation when returning another page', () => {
    const trace = traceFixture();
    const payload = {
      version: 1 as const,
      snapshotId,
      query: 'list_tests' as const,
      filterKey: filterKey({}),
      order: 'source-v1' as const,
      position: {
        filePath: trace.test.filePath,
        offset: 0,
        key: trace.test.key,
      },
    };
    const response = {
      meta: {
        ...trace.meta,
        truncated: true,
        truncationReasons: ['result_limit'],
        appliedLimits: { pageSize: 1 },
      },
      items: [trace.test],
      nextCursor: encodeCursor(payload),
    };
    expect(listTestsResponseSchema.safeParse(response).success).toBe(true);
    expect(
      listTestsResponseSchema.safeParse({
        ...response,
        meta: { ...response.meta, truncated: false, truncationReasons: [] },
      }).success,
    ).toBe(false);
    expect(
      listTestsResponseSchema.safeParse({
        ...response,
        nextCursor: encodeCursor({ ...payload, snapshotId: id(99) }),
      }).success,
    ).toBe(false);
    expect(
      listTestsResponseSchema.safeParse({ ...response, items: [] }).success,
    ).toBe(false);
  });
  it('validates list, reverse, diagnostics and source results independently of a service', () => {
    const trace = traceFixture();
    const pageMeta = {
      ...trace.meta,
      appliedLimits: { pageSize: 50, relationships: 1000 },
    };
    expect(
      listTestsResponseSchema.safeParse({
        meta: pageMeta,
        items: [trace.test],
        nextCursor: null,
      }).success,
    ).toBe(true);
    const link = trace.links[0]!;
    expect(
      relatedProductionSymbolsResponseSchema.safeParse({
        meta: pageMeta,
        testId: trace.test.id,
        items: [{ symbol: trace.symbols[0], links: [link] }],
        nextCursor: null,
      }).success,
    ).toBe(true);
    expect(
      findTestsForSymbolResponseSchema.safeParse({
        meta: pageMeta,
        symbolId: id(7),
        items: [{ test: trace.test, links: [link] }],
        nextCursor: null,
      }).success,
    ).toBe(true);
    expect(
      findTestsForSymbolResponseSchema.safeParse({
        meta: pageMeta,
        symbolId: id(8),
        items: [{ test: trace.test, links: [link] }],
        nextCursor: null,
      }).success,
    ).toBe(false);
    expect(
      getDiagnosticsResponseSchema.safeParse({
        meta: pageMeta,
        items: [],
        nextCursor: null,
      }).success,
    ).toBe(true);
    expect(
      getSourceEvidenceResponseSchema.safeParse({
        meta: { ...trace.meta, appliedLimits: { evidence: 100 } },
        items: [
          {
            status: 'available',
            evidence: trace.evidenceRefs[0],
            filePath: 'example.test.ts',
            text: 'abc',
          },
          {
            status: 'unavailable',
            snapshotId,
            evidenceId: id(100),
            code: 'SOURCE_UNAVAILABLE',
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      getSourceEvidenceResponseSchema.safeParse({
        meta: trace.meta,
        items: [
          {
            status: 'available',
            evidence: trace.evidenceRefs[0],
            filePath: 'example.test.ts',
            text: 'wrong length',
          },
        ],
      }).success,
    ).toBe(false);
  });
  it('rejects disconnected paths, cycles, absent relations and missing graph roots', () => {
    const trace = traceFixture();
    const graph = {
      meta: {
        ...trace.meta,
        appliedLimits: {
          ...trace.meta.appliedLimits,
          depth: 2,
          nodes: 200,
          paths: 20,
          expansions: 10000,
        },
      },
      symbols: trace.symbols,
      relations: trace.relations,
      evidenceRefs: trace.evidenceRefs,
      diagnostics: trace.diagnostics,
    };
    expect(
      graphNeighborsResponseSchema.safeParse({ ...graph, rootSymbolId: id(7) })
        .success,
    ).toBe(true);
    expect(
      graphNeighborsResponseSchema.safeParse({ ...graph, rootSymbolId: id(99) })
        .success,
    ).toBe(false);
    const response = {
      ...graph,
      fromSymbolId: id(7),
      toSymbolId: id(8),
      paths: [{ symbolIds: [id(7), id(8)], relationIds: [id(9)] }],
    };
    expect(findSymbolPathsResponseSchema.safeParse(response).success).toBe(
      true,
    );
    expect(
      findSymbolPathsResponseSchema.safeParse({
        ...response,
        paths: [{ symbolIds: [id(7), id(8)], relationIds: [id(99)] }],
      }).success,
    ).toBe(false);
    expect(
      findSymbolPathsResponseSchema.safeParse({
        ...response,
        paths: [{ symbolIds: [id(8), id(7)], relationIds: [id(9)] }],
      }).success,
    ).toBe(false);
    expect(
      findSymbolPathsResponseSchema.safeParse({
        ...response,
        paths: [
          { symbolIds: [id(7), id(8), id(7)], relationIds: [id(9), id(9)] },
        ],
      }).success,
    ).toBe(false);
  });
});
