import { describe, expect, it } from 'vitest';
import * as contracts from '@codethread/contracts';
import {
  id,
  snapshotId,
  traceFixture,
  sourceExcerpt,
  graphFixture,
  chainGraphFixture,
  reverseCallRange,
  secondCallRange,
} from './fixtures/trace.ts';

function testPage() {
  const trace = traceFixture();
  return {
    meta: {
      ...trace.meta,
      truncated: true,
      truncationReasons: ['result_limit'],
      appliedLimits: { pageSize: 1 },
    },
    items: [trace.test],
    nextCursor: contracts.encodeCursor({
      version: 1,
      snapshotId,
      query: 'list_tests',
      filterKey: contracts.filterKey({}),
      order: 'source-v1',
      position: {
        filePath: trace.test.filePath,
        offset: trace.test.range.start.offset,
        key: trace.test.key,
      },
    }),
  };
}

describe('CT-FIX-001 request-aware pagination', () => {
  it('accepts a valid continuation and rejects changed filters, snapshots and overlapping pages', () => {
    const page = testPage();
    expect(
      contracts.parseListTestsResult({ snapshotId, limit: 1 }, page).items,
    ).toHaveLength(1);
    expect(() =>
      contracts.parseListTestsResult(
        { snapshotId, limit: 1, filters: { text: 'different' } },
        page,
      ),
    ).toThrow(/scope\/filter/i);
    expect(() =>
      contracts.parseListTestsResult({ snapshotId: id(99), limit: 1 }, page),
    ).toThrow(/snapshot/i);
    expect(() =>
      contracts.parseListTestsResult(
        { snapshotId, limit: 1, cursor: page.nextCursor },
        page,
      ),
    ).toThrow(/ordering/i);
    const previous = contracts.decodeCursor(page.nextCursor);
    const cursor = contracts.encodeCursor({
      ...previous,
      position: { ...previous.position, key: 'test:000' },
    });
    expect(
      contracts.parseListTestsResult({ snapshotId, limit: 1, cursor }, page)
        .items,
    ).toHaveLength(1);
  });
  it('uses UTF-8 byte order rather than UTF-16 or locale-dependent ordering', () => {
    const trace = traceFixture();
    const items = ['\uE000.ts', '\u{10000}.ts'].map((filePath, index) => ({
      ...trace.test,
      id: id(80 + index),
      fileId: id(82 + index),
      declarationEvidenceId: id(84 + index),
      key: 'test:' + index,
      filePath,
    }));
    const page = {
      meta: { ...trace.meta, appliedLimits: { pageSize: 2 } },
      items,
      nextCursor: null,
    };
    expect(
      contracts.parseListTestsResult({ snapshotId, limit: 2 }, page).items,
    ).toHaveLength(2);
    expect(() =>
      contracts.parseListTestsResult(
        { snapshotId, limit: 2 },
        { ...page, items: [...items].reverse() },
      ),
    ).toThrow(/ordering/i);
  });
  it('binds diagnostic continuations to the actual source-free row', () => {
    const trace = traceFixture();
    const diagnostic = {
      id: id(70),
      snapshotId,
      code: 'SOURCE_UNSUPPORTED',
      severity: 'warning',
      message: 'Unsupported source',
      fileId: null,
      filePath: null,
      range: null,
    };
    const cursor = contracts.encodeCursor({
      version: 1,
      snapshotId,
      query: 'diagnostics',
      filterKey: contracts.filterKey({}),
      order: 'source-v1',
      position: { filePath: '', offset: 0, key: id(71) },
    });
    const response = {
      meta: {
        ...trace.meta,
        truncated: true,
        truncationReasons: ['result_limit'],
        appliedLimits: { pageSize: 1 },
      },
      items: [diagnostic],
      nextCursor: cursor,
    };
    expect(() =>
      contracts.parseGetDiagnosticsResult({ snapshotId, limit: 1 }, response),
    ).toThrow(/continuation position/i);
  });
  it('rejects a continuation that skips beyond the last returned item', () => {
    const page = testPage();
    const payload = contracts.decodeCursor(page.nextCursor);
    page.nextCursor = contracts.encodeCursor({
      ...payload,
      position: { ...payload.position, offset: 999 },
    });
    expect(() =>
      contracts.parseListTestsResult({ snapshotId, limit: 1 }, page),
    ).toThrow(/continuation position/i);
  });
});

describe('CT-FIX-005 request-aware graph traversal', () => {
  it('rejects duplicate path sequences rather than counting them as alternatives', () => {
    const path = { symbolIds: [id(7), id(8)], relationIds: [id(9)] };
    expect(() =>
      contracts.parseFindSymbolPathsResult(
        { snapshotId, fromSymbolId: id(7), toSymbolId: id(8) },
        {
          ...graphFixture(),
          fromSymbolId: id(7),
          toSymbolId: id(8),
          paths: [path, path],
        },
      ),
    ).toThrow(/duplicate path/i);
  });
  it('preserves paths through distinct parallel call occurrences', () => {
    const graph = graphFixture();
    const source = graph.evidenceRefs.find((item) => item.id === id(20))!;
    graph.evidenceRefs.push({ ...source, id: id(13), range: secondCallRange });
    graph.relations.push({
      ...graph.relations[0]!,
      id: id(12),
      key: 'call:parallel',
      siteEvidenceId: id(13),
      resolution: { status: 'exact', targetId: id(8), evidenceIds: [id(13)] },
    });
    const paths = [id(9), id(12)].map((relation) => ({
      symbolIds: [id(7), id(8)],
      relationIds: [relation],
    }));
    expect(
      contracts.parseFindSymbolPathsResult(
        { snapshotId, fromSymbolId: id(7), toSymbolId: id(8) },
        { ...graph, fromSymbolId: id(7), toSymbolId: id(8), paths },
      ).paths,
    ).toHaveLength(2);
  });
  it('retains an unresolved outgoing site without inventing a neighbor or an incoming target', () => {
    const graph = graphFixture();
    graph.symbols = [graph.symbols[0]!];
    graph.relations[0]!.resolution = {
      status: 'unresolved',
      targetId: null,
      evidenceIds: [id(10)],
      diagnosticIds: [id(55)],
    };
    graph.diagnostics.push({
      id: id(55),
      snapshotId,
      code: 'TARGET_UNRESOLVED',
      severity: 'warning',
      message: 'Unknown target',
      fileId: id(40),
      filePath: 'example.ts',
      range: graph.evidenceRefs.find((item) => item.id === id(10))!.range,
    });
    const response = { ...graph, rootSymbolId: id(7) };
    expect(
      contracts.parseGraphNeighborsResult(
        { snapshotId, symbolId: id(7) },
        response,
      ).symbols,
    ).toHaveLength(1);
    expect(() =>
      contracts.parseGraphNeighborsResult(
        { snapshotId, symbolId: id(7), direction: 'incoming' },
        response,
      ),
    ).toThrow(/frontier/i);
  });
  it('rejects path dictionaries containing relationships outside the returned paths', () => {
    expect(() =>
      contracts.parseFindSymbolPathsResult(
        { snapshotId, fromSymbolId: id(7), toSymbolId: id(8) },
        {
          ...graphFixture(),
          fromSymbolId: id(7),
          toSymbolId: id(8),
          paths: [],
        },
      ),
    ).toThrow(/unrelated relation/i);
  });
  it('accepts code-only incoming, outgoing and bidirectional exploration', () => {
    expect(
      contracts.parseGraphNeighborsResult(
        { snapshotId, symbolId: id(7) },
        { ...graphFixture(), rootSymbolId: id(7) },
      ).symbols,
    ).toHaveLength(2);
    expect(
      contracts.parseGraphNeighborsResult(
        { snapshotId, symbolId: id(8), direction: 'incoming' },
        { ...graphFixture(), rootSymbolId: id(8) },
      ).symbols,
    ).toHaveLength(2);
    expect(
      contracts.parseGraphNeighborsResult(
        { snapshotId, symbolId: id(8), direction: 'both' },
        { ...graphFixture(), rootSymbolId: id(8) },
      ).symbols,
    ).toHaveLength(2);
  });
  it('rejects disconnected nodes even when truncation is visible', () => {
    const graph = graphFixture();
    graph.symbols.push({
      ...graph.symbols[0]!,
      id: id(90),
      key: 'symbol:disconnected',
    });
    graph.meta.truncated = true;
    graph.meta.truncationReasons = ['result_limit'];
    expect(() =>
      contracts.parseGraphNeighborsResult(
        { snapshotId, symbolId: id(7) },
        { ...graph, rootSymbolId: id(7) },
      ),
    ).toThrow(/reachable/i);
  });
  it('preserves parallel call sites and cycles, but rejects edges from an unexpanded depth frontier', () => {
    const graph = graphFixture();
    const original = graph.relations[0]!,
      source = graph.evidenceRefs.find((item) => item.id === id(20))!;
    graph.evidenceRefs.push(
      { ...source, id: id(13), range: secondCallRange },
      { ...source, id: id(24), range: reverseCallRange },
    );
    graph.relations.push(
      {
        ...original,
        id: id(12),
        key: 'call:parallel',
        siteEvidenceId: id(13),
        resolution: { status: 'exact', targetId: id(8), evidenceIds: [id(13)] },
      },
      {
        ...original,
        id: id(25),
        key: 'call:reverse',
        sourceSymbolId: id(8),
        siteEvidenceId: id(24),
        resolution: { status: 'exact', targetId: id(7), evidenceIds: [id(24)] },
      },
    );
    expect(
      contracts.parseGraphNeighborsResult(
        { snapshotId, symbolId: id(7) },
        { ...graph, rootSymbolId: id(7) },
      ).relations,
    ).toHaveLength(3);
    expect(() =>
      contracts.parseGraphNeighborsResult(
        { snapshotId, symbolId: id(7), depth: 1 },
        {
          ...graph,
          rootSymbolId: id(7),
          meta: {
            ...graph.meta,
            appliedLimits: { ...graph.meta.appliedLimits, depth: 1 },
          },
        },
      ),
    ).toThrow(/frontier/i);
  });
  it('accepts a connected bounded path and a valid zero-edge self path', () => {
    const graph = chainGraphFixture();
    const response = {
      ...graph,
      fromSymbolId: id(7),
      toSymbolId: id(42),
      paths: [
        { symbolIds: [id(7), id(8), id(42)], relationIds: [id(9), id(30)] },
      ],
    };
    expect(
      contracts.parseFindSymbolPathsResult(
        { snapshotId, fromSymbolId: id(7), toSymbolId: id(42) },
        response,
      ).paths,
    ).toHaveLength(1);
    const one = graphFixture();
    one.symbols = [one.symbols[0]!];
    one.relations = [];
    expect(
      contracts.parseFindSymbolPathsResult(
        { snapshotId, fromSymbolId: id(7), toSymbolId: id(7) },
        {
          ...one,
          fromSymbolId: id(7),
          toSymbolId: id(7),
          paths: [{ symbolIds: [id(7)], relationIds: [] }],
        },
      ).paths,
    ).toHaveLength(1);
  });
  it('rejects an otherwise connected path beyond the requested depth', () => {
    const graph = chainGraphFixture();
    const response = {
      ...graph,
      meta: {
        ...graph.meta,
        appliedLimits: { ...graph.meta.appliedLimits, depth: 1 },
      },
      fromSymbolId: id(7),
      toSymbolId: id(42),
      paths: [
        { symbolIds: [id(7), id(8), id(42)], relationIds: [id(9), id(30)] },
      ],
    };
    expect(() =>
      contracts.parseFindSymbolPathsResult(
        { snapshotId, fromSymbolId: id(7), toSymbolId: id(42), depth: 1 },
        response,
      ),
    ).toThrow(/path depth/i);
  });
  it('rejects nodes reachable only against the requested direction', () => {
    const response = { ...graphFixture(), rootSymbolId: id(8) };
    expect(() =>
      contracts.parseGraphNeighborsResult(
        { snapshotId, symbolId: id(8), direction: 'outgoing' },
        response,
      ),
    ).toThrow(/reachable/i);
  });
});

describe('Selection and source-batch boundaries', () => {
  it('accepts unavailable evidence only when it corresponds to the request', () => {
    const trace = traceFixture();
    expect(
      contracts.parseGetSourceEvidenceResult(
        { snapshotId, evidenceIds: [id(99)] },
        {
          meta: { ...trace.meta, appliedLimits: { evidence: 100 } },
          items: [
            {
              status: 'unavailable',
              snapshotId,
              evidenceId: id(99),
              code: 'EVIDENCE_NOT_FOUND',
            },
          ],
        },
      ).items,
    ).toHaveLength(1);
    expect(() =>
      contracts.parseGetSourceEvidenceResult(
        { snapshotId, evidenceIds: [id(99)] },
        {
          meta: { ...trace.meta, appliedLimits: { evidence: 100 } },
          items: [],
        },
      ),
    ).toThrow(/requested evidence/i);
  });
  it('rejects a trace selected for a different test', () => {
    expect(() =>
      contracts.parseGetTestTraceResult(
        { snapshotId, testId: id(99) },
        traceFixture(),
      ),
    ).toThrow(/test selection/i);
  });
  it('rejects conflicting immutable file hashes across a source batch', () => {
    const trace = traceFixture();
    const declaration = trace.evidenceRefs.find((item) => item.id === id(5))!;
    const step = trace.evidenceRefs.find((item) => item.id === id(22))!;
    const response = {
      meta: { ...trace.meta, appliedLimits: { evidence: 100 } },
      items: [
        {
          status: 'available',
          evidence: declaration,
          filePath: 'example.test.ts',
          text: sourceExcerpt,
        },
        {
          status: 'available',
          evidence: { ...step, contentHash: 'b'.repeat(64) },
          filePath: 'example.test.ts',
          text: 'first();',
        },
      ],
    };
    expect(() =>
      contracts.parseGetSourceEvidenceResult(
        { snapshotId, evidenceIds: [id(5), id(22)] },
        response,
      ),
    ).toThrow(/content hashes/i);
  });
  it('requires exactly the requested evidence IDs, including unavailable results', () => {
    const trace = traceFixture();
    const response = {
      meta: { ...trace.meta, appliedLimits: { evidence: 100 } },
      items: [
        {
          status: 'unavailable',
          snapshotId,
          evidenceId: id(99),
          code: 'SOURCE_UNAVAILABLE',
        },
      ],
    };
    expect(() =>
      contracts.parseGetSourceEvidenceResult(
        { snapshotId, evidenceIds: [id(5)] },
        response,
      ),
    ).toThrow(/requested evidence/i);
  });
});

describe('CT-FIX-003 request-aware occurrence ownership', () => {
  it('rejects a known cycle in supporting step context', () => {
    const trace = traceFixture();
    const response = {
      meta: {
        ...trace.meta,
        appliedLimits: { pageSize: 50, relationships: 1000 },
      },
      testId: trace.test.id,
      items: [{ symbol: trace.symbols[0], links: trace.links }],
      nextCursor: null,
    };
    trace.steps[0]!.parentStepId = trace.steps[0]!.id;
    expect(() =>
      contracts.parseRelatedProductionSymbolsResult(
        { snapshotId, testId: trace.test.id },
        response,
        { steps: trace.steps, evidenceRefs: trace.evidenceRefs },
      ),
    ).toThrow(/cyclic step/i);
  });
  it('preserves distinct test calls at different source sites in related and reverse results', () => {
    const trace = traceFixture(),
      context = { steps: trace.steps, evidenceRefs: trace.evidenceRefs };
    const meta = {
      ...trace.meta,
      appliedLimits: { pageSize: 50, relationships: 1000 },
    };
    expect(
      contracts.parseRelatedProductionSymbolsResult(
        { snapshotId, testId: trace.test.id },
        {
          meta,
          testId: trace.test.id,
          items: [{ symbol: trace.symbols[0], links: trace.links }],
          nextCursor: null,
        },
        context,
      ).items[0]!.links,
    ).toHaveLength(2);
    expect(
      contracts.parseFindTestsForSymbolResult(
        { snapshotId, symbolId: id(7) },
        {
          meta,
          symbolId: id(7),
          items: [{ test: trace.test, links: trace.links }],
          nextCursor: null,
        },
        context,
      ).items[0]!.links,
    ).toHaveLength(2);
  });
  it('rejects a reverse lookup returned for another selected symbol', () => {
    const trace = traceFixture();
    const response = {
      meta: {
        ...trace.meta,
        appliedLimits: { pageSize: 50, relationships: 1000 },
      },
      symbolId: id(7),
      items: [{ test: trace.test, links: trace.links }],
      nextCursor: null,
    };
    expect(() =>
      contracts.parseFindTestsForSymbolResult(
        { snapshotId, symbolId: id(8) },
        response,
        { steps: trace.steps, evidenceRefs: trace.evidenceRefs },
      ),
    ).toThrow(/symbol selection/i);
  });
  it('rejects a related-link step that belongs to another test', () => {
    const trace = traceFixture();
    const response = {
      meta: {
        ...trace.meta,
        appliedLimits: { pageSize: 50, relationships: 1000 },
      },
      testId: trace.test.id,
      items: [{ symbol: trace.symbols[0], links: trace.links }],
      nextCursor: null,
    };
    const context = {
      steps: [{ ...trace.steps[0], testId: id(99) }],
      evidenceRefs: trace.evidenceRefs,
    };
    expect(() =>
      contracts.parseRelatedProductionSymbolsResult(
        { snapshotId, testId: trace.test.id },
        response,
        context,
      ),
    ).toThrow(/step ownership/i);
  });
});
