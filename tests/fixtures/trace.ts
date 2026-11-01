import type { TestTrace } from '@codethread/contracts';

/** Hand-authored contract fixture; not analyzer output or semantic ground truth. */
export const id = (value: number): string =>
  `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
export const snapshotId = id(1);
export const range = {
  start: { offset: 0, line: 1, column: 1 },
  end: { offset: 3, line: 1, column: 4 },
};
export function traceFixture(): TestTrace {
  const evidence = (number: number) => ({
    snapshotId,
    id: id(number),
    fileId: id(4),
    contentHash: 'a'.repeat(64),
    range,
    kind: 'static_source' as const,
    extractor: { name: 'hand-authored-fixture', version: '1' },
  });
  return {
    meta: {
      snapshotId,
      evidenceBasis: 'static',
      coverage: 'partial',
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
        evidenceIds: [id(5)],
      },
    ],
    symbols: [7, 8].map((number) => ({
      snapshotId,
      id: id(number),
      key: `symbol:${number}`,
      fileId: id(4),
      filePath: 'example.test.ts',
      name: `function${number}`,
      kind: 'function' as const,
      range,
      evidenceIds: [id(10)],
    })),
    links: [
      {
        snapshotId,
        id: id(11),
        key: 'link:0',
        testId: id(3),
        stepId: id(6),
        kind: 'calls',
        siteEvidenceId: id(5),
        resolution: { status: 'exact', targetId: id(7), evidenceIds: [id(5)] },
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
    evidenceRefs: [evidence(5), evidence(10)],
    diagnostics: [],
  };
}
