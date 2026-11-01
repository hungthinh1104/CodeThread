import { createHash } from 'node:crypto';
import { positionAt } from '@codethread/code-model';
import type { TestTrace } from '@codethread/contracts';

/** Hand-authored DTOs and retained source; not analyzer output or semantic ground truth. */
export const id = (value: number): string =>
  '00000000-0000-4000-8000-' + String(value).padStart(12, '0');
export const snapshotId = id(1);
export const testSource = "test('example', () => { first(); first(); });\n";
export const productionSource =
  'export function first() { second(); second(); }\nexport function second() { first(); third(); }\nexport function third() {}\n';
export const sourceExcerpt = testSource.trimEnd();
const span = (source: string, start: number, end: number) => ({
  start: positionAt(source, start),
  end: positionAt(source, end),
});
export const range = span(testSource, 0, sourceExcerpt.length);
const firstEnd = productionSource.indexOf('\n');
const secondEnd = productionSource.indexOf('\n', firstEnd + 1);
const firstCall = productionSource.indexOf('second()');
const secondCall = productionSource.indexOf('second()', firstCall + 1);
export const secondCallRange = span(
  productionSource,
  secondCall,
  secondCall + 8,
);
export const reverseCallRange = span(
  productionSource,
  productionSource.lastIndexOf('first()'),
  productionSource.lastIndexOf('first()') + 7,
);
const testCall = testSource.indexOf('first()');
const secondTestCall = testSource.indexOf('first()', testCall + 1);

export function traceFixture(): TestTrace {
  const evidence = (
    number: number,
    fileId: number,
    source: string,
    start: number,
    end: number,
  ) => ({
    snapshotId,
    id: id(number),
    fileId: id(fileId),
    contentHash: createHash('sha256').update(source, 'utf8').digest('hex'),
    range: span(source, start, end),
    kind: 'static_source' as const,
    extractor: { name: 'hand-authored-fixture', version: '2' },
  });
  return {
    meta: {
      snapshotId,
      evidenceBasis: 'static',
      coverage: 'partial',
      coverageByCapability: {
        'declarations.v1': 'complete',
        'relationships.v1': 'partial',
        'test_behavior.v1': 'complete',
      },
      truncated: false,
      truncationReasons: [],
      appliedLimits: {
        steps: 500,
        symbols: 200,
        relationships: 1000,
        evidence: 5000,
        diagnostics: 200,
      },
    },
    test: {
      snapshotId,
      id: id(3),
      key: 'test:example:0',
      fileId: id(4),
      filePath: 'example.test.ts',
      name: 'example',
      suitePath: ['suite'],
      range,
      declarationEvidenceId: id(5),
      parameterization: 'none',
      caseKey: null,
    },
    steps: [
      {
        snapshotId,
        id: id(6),
        key: 'step:example:0',
        testId: id(3),
        parentStepId: null,
        kind: 'action',
        phase: 'testBody',
        syntaxOrdinal: 0,
        sourceEvidenceId: id(22),
        evidenceIds: [id(22)],
      },
      {
        snapshotId,
        id: id(27),
        key: 'step:example:1',
        testId: id(3),
        parentStepId: null,
        kind: 'action',
        phase: 'testBody',
        syntaxOrdinal: 1,
        sourceEvidenceId: id(26),
        evidenceIds: [id(26)],
      },
    ],
    symbols: [
      {
        snapshotId,
        id: id(7),
        key: 'symbol:first',
        fileId: id(40),
        filePath: 'example.ts',
        name: 'first',
        kind: 'function',
        range: span(productionSource, 0, firstEnd),
        declarationEvidenceId: id(20),
        evidenceIds: [id(20)],
      },
      {
        snapshotId,
        id: id(8),
        key: 'symbol:second',
        fileId: id(40),
        filePath: 'example.ts',
        name: 'second',
        kind: 'function',
        range: span(productionSource, firstEnd + 1, secondEnd),
        declarationEvidenceId: id(21),
        evidenceIds: [id(21)],
      },
    ],
    links: [
      {
        snapshotId,
        id: id(11),
        key: 'link:0',
        testId: id(3),
        stepId: id(6),
        kind: 'calls',
        siteEvidenceId: id(23),
        resolution: { status: 'exact', targetId: id(7), evidenceIds: [id(23)] },
      },
      {
        snapshotId,
        id: id(28),
        key: 'link:1',
        testId: id(3),
        stepId: id(27),
        kind: 'calls',
        siteEvidenceId: id(29),
        resolution: { status: 'exact', targetId: id(7), evidenceIds: [id(29)] },
      },
    ],
    relations: [
      {
        snapshotId,
        id: id(9),
        key: 'call:site:0',
        sourceSymbolId: id(7),
        kind: 'calls',
        siteEvidenceId: id(10),
        resolution: { status: 'exact', targetId: id(8), evidenceIds: [id(10)] },
      },
    ],
    evidenceRefs: [
      evidence(5, 4, testSource, 0, sourceExcerpt.length),
      evidence(20, 40, productionSource, 0, firstEnd),
      evidence(21, 40, productionSource, firstEnd + 1, secondEnd),
      evidence(22, 4, testSource, testCall, testCall + 8),
      evidence(23, 4, testSource, testCall, testCall + 7),
      evidence(26, 4, testSource, secondTestCall, secondTestCall + 8),
      evidence(29, 4, testSource, secondTestCall, secondTestCall + 7),
      evidence(10, 40, productionSource, firstCall, firstCall + 8),
    ],
    diagnostics: [],
  };
}

export function graphFixture() {
  const trace = traceFixture();
  return {
    meta: {
      ...trace.meta,
      coverageByCapability: {
        'declarations.v1': 'complete' as const,
        'relationships.v1': 'partial' as const,
      },
      appliedLimits: {
        symbols: 200,
        nodes: 200,
        relationships: 1000,
        evidence: 5000,
        diagnostics: 200,
        depth: 2,
        paths: 20,
        expansions: 10000,
      },
    },
    symbols: trace.symbols,
    relations: trace.relations,
    evidenceRefs: trace.evidenceRefs.filter((item) => item.fileId === id(40)),
    diagnostics: trace.diagnostics,
  };
}

export function chainGraphFixture() {
  const graph = graphFixture();
  const declarationRange = span(
    productionSource,
    secondEnd + 1,
    productionSource.length - 1,
  );
  const call = productionSource.indexOf('third()');
  const declaration = graph.evidenceRefs.find((item) => item.id === id(20))!;
  graph.symbols.push({
    ...graph.symbols[1]!,
    id: id(42),
    key: 'symbol:third',
    name: 'third',
    range: declarationRange,
    declarationEvidenceId: id(31),
    evidenceIds: [id(31)],
  });
  graph.evidenceRefs.push(
    { ...declaration, id: id(31), range: declarationRange },
    {
      ...declaration,
      id: id(32),
      range: span(productionSource, call, call + 7),
    },
  );
  graph.relations.push({
    ...graph.relations[0]!,
    id: id(30),
    key: 'call:second-to-third',
    sourceSymbolId: id(8),
    siteEvidenceId: id(32),
    resolution: { status: 'exact', targetId: id(42), evidenceIds: [id(32)] },
  });
  return graph;
}
