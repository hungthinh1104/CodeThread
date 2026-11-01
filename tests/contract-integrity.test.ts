import { describe, expect, it } from 'vitest';
import {
  getTestTraceResponseSchema,
  listTestsResponseSchema,
  relatedProductionSymbolsResponseSchema,
  findTestsForSymbolResponseSchema,
  queryMetaSchema,
  findSymbolPathsResponseSchema,
} from '@codethread/contracts';
import { id, traceFixture, graphFixture } from './fixtures/trace.ts';

describe('CT-FIX-002 canonical identities', () => {
  it('validates deep step containment at the trace bound and rejects a long cycle', () => {
    const trace = traceFixture();
    const prototype = trace.steps[0]!;
    trace.links = [];
    trace.steps = Array.from({ length: 500 }, (_, index) => ({
      ...prototype,
      id: id(1000 + index),
      key: 'step:' + index,
      syntaxOrdinal: index,
      parentStepId: index === 0 ? null : id(999 + index),
    }));
    expect(getTestTraceResponseSchema.safeParse(trace).success).toBe(true);
    trace.steps[0]!.parentStepId = trace.steps.at(-1)!.id;
    expect(getTestTraceResponseSchema.safeParse(trace).success).toBe(false);
  });
  it('rejects case-equivalent UUID identities before building graph maps', () => {
    const trace = traceFixture();
    const symbolId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    trace.symbols[0]!.id = symbolId;
    trace.links[0]!.resolution = {
      status: 'exact',
      targetId: symbolId,
      evidenceIds: [trace.links[0]!.siteEvidenceId],
    };
    trace.relations[0]!.sourceSymbolId = symbolId;
    trace.symbols.push({
      ...trace.symbols[0]!,
      id: symbolId.toUpperCase(),
      key: 'another-key',
    });
    expect(getTestTraceResponseSchema.safeParse(trace).success).toBe(false);
  });
  it.each(['symbols', 'relations', 'steps', 'links'])(
    'rejects conflicting %s canonical keys with distinct UUIDs',
    (kind) => {
      const trace = traceFixture();
      if (kind === 'symbols')
        trace.symbols.push({
          ...trace.symbols[0]!,
          id: id(20),
          name: 'conflict',
        });
      if (kind === 'relations')
        trace.relations.push({ ...trace.relations[0]!, id: id(20) });
      if (kind === 'steps')
        trace.steps.push({ ...trace.steps[0]!, id: id(20) });
      if (kind === 'links')
        trace.links.push({ ...trace.links[0]!, id: id(20) });
      expect(getTestTraceResponseSchema.safeParse(trace).success).toBe(false);
    },
  );
  it('rejects repeated test canonical keys across a page', () => {
    const trace = traceFixture();
    expect(
      listTestsResponseSchema.safeParse({
        meta: { ...trace.meta, appliedLimits: { pageSize: 50 } },
        items: [trace.test, { ...trace.test, id: id(20) }],
        nextCursor: null,
      }).success,
    ).toBe(false);
  });
});

describe('CT-FIX-005 intrinsic roots', () => {
  it('requires path roots to exist even when no paths were returned', () => {
    expect(
      findSymbolPathsResponseSchema.safeParse({
        ...graphFixture(),
        fromSymbolId: id(99),
        toSymbolId: id(8),
        paths: [],
      }).success,
    ).toBe(false);
  });
});

describe('CT-FIX-003 nested occurrences', () => {
  it.each(['identity', 'canonical-key'])(
    'rejects duplicate nested link %s in related and reverse results',
    (kind) => {
      const trace = traceFixture();
      const link = trace.links[0]!;
      const duplicate = {
        ...link,
        ...(kind === 'canonical-key' ? { id: id(30) } : {}),
      };
      const meta = {
        ...trace.meta,
        appliedLimits: { pageSize: 50, relationships: 1000 },
      };
      expect(
        relatedProductionSymbolsResponseSchema.safeParse({
          meta,
          testId: trace.test.id,
          items: [{ symbol: trace.symbols[0], links: [link, duplicate] }],
          nextCursor: null,
        }).success,
      ).toBe(false);
      expect(
        findTestsForSymbolResponseSchema.safeParse({
          meta,
          symbolId: id(7),
          items: [{ test: trace.test, links: [link, duplicate] }],
          nextCursor: null,
        }).success,
      ).toBe(false);
    },
  );
});

describe('CT-FIX-004 evidence associations', () => {
  it('rejects site coordinates that contradict their containing declaration', () => {
    const trace = traceFixture();
    const site = trace.evidenceRefs.find((item) => item.id === id(10))!;
    // Individually feasible range, but this declaration lies entirely on line 1.
    site.range = {
      start: { offset: site.range.start.offset, line: 2, column: 1 },
      end: { offset: site.range.end.offset, line: 2, column: 9 },
    };
    expect(getTestTraceResponseSchema.safeParse(trace).success).toBe(false);
  });
  it('rejects conflicting paths for one file identity across a test page', () => {
    const trace = traceFixture();
    const page = {
      meta: { ...trace.meta, appliedLimits: { pageSize: 50 } },
      items: [
        trace.test,
        {
          ...trace.test,
          id: id(70),
          key: 'test:other',
          filePath: 'different.test.ts',
        },
      ],
      nextCursor: null,
    };
    expect(listTestsResponseSchema.safeParse(page).success).toBe(false);
  });
  it('preserves cross-file auxiliary evidence while checking the primary anchor', () => {
    const trace = traceFixture();
    trace.symbols[0]!.evidenceIds.push(id(5));
    trace.steps[0]!.evidenceIds.push(id(20));
    expect(getTestTraceResponseSchema.safeParse(trace).success).toBe(true);
  });
  it.each(['declaration-file', 'declaration-range', 'file-hash', 'call-site'])(
    'rejects inconsistent %s evidence',
    (failure) => {
      const trace = traceFixture();
      expect(getTestTraceResponseSchema.safeParse(trace).success).toBe(true);
      if (failure === 'declaration-file')
        trace.evidenceRefs.find((item) => item.id === id(5))!.fileId = id(90);
      if (failure === 'declaration-range')
        trace.test.range = {
          start: { offset: 10, line: 1, column: 11 },
          end: { offset: 13, line: 1, column: 14 },
        };
      if (failure === 'file-hash')
        trace.evidenceRefs.find((item) => item.id === id(10))!.contentHash =
          'b'.repeat(64);
      if (failure === 'call-site')
        trace.evidenceRefs.find((item) => item.id === id(10))!.range = {
          start: { offset: 500, line: 1, column: 501 },
          end: { offset: 503, line: 1, column: 504 },
        };
      expect(getTestTraceResponseSchema.safeParse(trace).success).toBe(false);
    },
  );
});

describe('CT-FIX-006 capability coverage', () => {
  it.each(['complete', 'partial', 'not_analyzed', 'unsupported'] as const)(
    'keeps %s capability coverage independent of truncation',
    (coverage) => {
      const meta = {
        ...traceFixture().meta,
        coverage,
        coverageByCapability: { 'declarations.v1': coverage },
        truncated: true,
        truncationReasons: ['result_limit'],
      };
      expect(queryMetaSchema.safeParse(meta).success).toBe(true);
    },
  );
  it('rejects inconsistent aggregates, unversioned capabilities and repeated truncation reasons', () => {
    const meta = traceFixture().meta;
    expect(
      queryMetaSchema.safeParse({ ...meta, coverage: 'complete' }).success,
    ).toBe(false);
    expect(
      queryMetaSchema.safeParse({
        ...meta,
        coverageByCapability: { declarations: 'partial' },
      }).success,
    ).toBe(false);
    expect(
      queryMetaSchema.safeParse({
        ...meta,
        truncated: true,
        truncationReasons: ['result_limit', 'result_limit'],
      }).success,
    ).toBe(false);
  });
  it('rejects empty capability metadata without throwing outside the validation result', () => {
    expect(
      queryMetaSchema.safeParse({
        ...traceFixture().meta,
        coverageByCapability: {},
      }).success,
    ).toBe(false);
  });
  it('represents not-analyzed independently of unsupported, unresolved and truncation', () => {
    const meta = traceFixture().meta;
    expect(
      queryMetaSchema.safeParse({
        ...meta,
        coverage: 'not_analyzed',
        coverageByCapability: { 'declarations.v1': 'not_analyzed' },
      }).success,
    ).toBe(true);
  });
});
