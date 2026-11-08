import { beforeAll, describe, expect, it } from 'vitest';
import {
  findSymbolPathsResponseSchema,
  getSourceEvidenceResponseSchema,
  graphNeighborsResponseSchema,
} from '@codethread/contracts';
import { analyzeManifest, COMPILER_PROFILE } from '@codethread/symbol-indexer';
import { loadExternalCorpus } from '../scripts/external-semantic-corpus.ts';
import {
  collectExternalGraph,
  externalGraphExpectations,
  validateExternalGraph,
} from '../scripts/external-semantic-graph.ts';
import type { ExternalGraphResult } from '../scripts/external-semantic-graph.ts';

const corpusNames = ['tinyexec', 'todo'] as const;
type CorpusName = (typeof corpusNames)[number];
type Mutation = [string, RegExp, (result: ExternalGraphResult) => void];

describe.each(corpusNames)('external graph oracle: %s', (name: CorpusName) => {
  let corpus: Awaited<ReturnType<typeof loadExternalCorpus>>;
  let snapshot: Awaited<ReturnType<typeof analyzeManifest>>;
  let result: ExternalGraphResult;

  beforeAll(async () => {
    corpus = await loadExternalCorpus(name);
    snapshot = await analyzeManifest({
      repositoryId:
        name === 'tinyexec'
          ? '00000000-0000-4000-8000-000000000011'
          : '00000000-0000-4000-8000-000000000012',
      compilerOptions: COMPILER_PROFILE,
      files: corpus.files,
    });
    result = collectExternalGraph(name, snapshot.facts, snapshot.source);
  }, 15000);

  const validate = (candidate: ExternalGraphResult) =>
    validateExternalGraph(
      name,
      corpus.gold,
      corpus.files,
      snapshot.facts,
      candidate,
    );

  function rootId(candidate: ExternalGraphResult): string {
    return candidate.neighbors.symbols.find(
      (symbol) => symbol.name === externalGraphExpectations[name].root.name,
    )!.id;
  }

  function targetId(candidate: ExternalGraphResult): string {
    return candidate.paths.symbols.find(
      (symbol) => symbol.name === externalGraphExpectations[name].target.name,
    )!.id;
  }

  function exactRelation(candidate: ExternalGraphResult) {
    const relation = candidate.neighbors.relations.find(
      (item) => item.resolution.status === 'exact',
    );
    if (!relation) throw new Error('Expected fixture edge is missing.');
    return relation;
  }

  it('accepts only the source-pinned static call and evidence path', () => {
    expect(() => validate(result)).not.toThrow();
  });

  const mutations: Mutation[] = [
    [
      'a missing neighbor edge',
      /outgoing has missing or fabricated exact edges/,
      (candidate) => {
        candidate.neighbors.relations = candidate.neighbors.relations.filter(
          (relation) => relation.resolution.status !== 'exact',
        );
      },
    ],
    [
      'a wrong exact target',
      /outgoing edge has the wrong source, target, kind, or evidence/,
      (candidate) => {
        const relation = exactRelation(candidate);
        if (relation.resolution.status === 'exact')
          relation.resolution.targetId = rootId(candidate);
      },
    ],
    [
      'an incorrect relation kind',
      /outgoing edge has the wrong source, target, kind, or evidence/,
      (candidate) => {
        exactRelation(candidate).kind = 'references';
      },
    ],
    [
      'a reversed source-to-target direction',
      /outgoing edge has the wrong source, target, kind, or evidence/,
      (candidate) => {
        exactRelation(candidate).sourceSymbolId = targetId(candidate);
      },
    ],
    [
      'an exact edge fabricated from an unsupported site',
      /outgoing has missing or fabricated exact edges/,
      (candidate) => {
        const relation = candidate.neighbors.relations.find(
          (item) => item.resolution.status === 'unsupported',
        );
        if (!relation) throw new Error('Expected unsupported fixture site.');
        relation.resolution = {
          status: 'exact',
          targetId: rootId(candidate),
          evidenceIds: [relation.siteEvidenceId],
        };
      },
    ],
    [
      'a guessed target on an unsupported site',
      /outgoing graph fabricated an uncertain target/,
      (candidate) => {
        const relation = candidate.neighbors.relations.find(
          (item) => item.resolution.status === 'unsupported',
        )!;
        relation.resolution = {
          ...relation.resolution,
          targetId: rootId(candidate),
        } as typeof relation.resolution;
      },
    ],
    [
      'a relation with an unrequested evidence ID',
      /outgoing edge has the wrong source, target, kind, or evidence/,
      (candidate) => {
        exactRelation(candidate).siteEvidenceId =
          '00000000-0000-4000-8000-000000000099';
      },
    ],
    [
      'an appended unrequested relation evidence ID',
      /resolution evidence IDs do not match the anchored source path/,
      (candidate) => {
        const relation = exactRelation(candidate);
        if (relation.resolution.status === 'exact')
          relation.resolution.evidenceIds.push(
            '00000000-0000-4000-8000-000000000099',
          );
      },
    ],
    [
      'an appended unrequested incoming evidence ID',
      /resolution evidence IDs do not match the anchored source path/,
      (candidate) => {
        const relation = candidate.incoming.relations.find(
          (item) => item.resolution.status === 'exact',
        );
        if (!relation || relation.resolution.status !== 'exact')
          throw new Error('Expected fixture incoming edge.');
        relation.resolution.evidenceIds.push(
          '00000000-0000-4000-8000-000000000099',
        );
      },
    ],
    [
      'an appended unrequested path evidence ID',
      /resolution evidence IDs do not match the anchored source path/,
      (candidate) => {
        const relation = candidate.paths.relations.find(
          (item) => item.resolution.status === 'exact',
        );
        if (!relation || relation.resolution.status !== 'exact')
          throw new Error('Expected fixture path edge.');
        relation.resolution.evidenceIds.push(
          '00000000-0000-4000-8000-000000000099',
        );
      },
    ],
    [
      'a discontinuous path',
      /path is missing, reversed, or disconnected/,
      (candidate) => {
        candidate.paths.paths[0]!.symbolIds[1] = rootId(candidate);
      },
    ],
    [
      'a path that omits its relation',
      /path has missing or fabricated exact edges/,
      (candidate) => {
        candidate.paths.relations = [];
      },
    ],
    [
      'a truncated graph',
      /unexpected truncation/,
      (candidate) => {
        candidate.neighbors.meta.truncated = true;
        candidate.neighbors.meta.truncationReasons = ['result_limit'];
      },
    ],
    [
      'a changed applied depth',
      /reported depth differs from request/,
      (candidate) => {
        candidate.paths.meta.appliedLimits.depth = 1;
      },
    ],
    [
      'a source evidence range outside the pinned call',
      /evidence range differs from the pinned source anchor/,
      (candidate) => {
        const item = candidate.excerpts.items[0]!;
        if (item.status === 'available') item.evidence.range.start.column += 1;
      },
    ],
    [
      'a graph evidence reference outside the pinned call',
      /evidence range differs from the pinned source anchor/,
      (candidate) => {
        const relation = exactRelation(candidate),
          reference = candidate.neighbors.evidenceRefs.find(
            (item) => item.id === relation.siteEvidenceId,
          )!;
        reference.range.start.column += 1;
      },
    ],
    [
      'a source evidence ID detached from the graph path',
      /source evidence IDs do not match the anchored path/,
      (candidate) => {
        const item = candidate.excerpts.items[0]!;
        if (item.status === 'available')
          item.evidence.id = '00000000-0000-4000-8000-000000000099';
      },
    ],
    [
      'source evidence with fabricated content',
      /source excerpt differs from pinned bytes/,
      (candidate) => {
        const item = candidate.excerpts.items[0]!;
        if (item.status === 'available') item.text = 'invented call evidence';
      },
    ],
    [
      'an unexpected neighbor symbol',
      /outgoing graph contains missing or unexpected symbols/,
      (candidate) => {
        const extra = structuredClone(candidate.neighbors.symbols[0]!);
        extra.id = '00000000-0000-4000-8000-000000000099';
        extra.key = 'symbol:v1:unexpected';
        extra.name = 'unanchored';
        candidate.neighbors.symbols.push(extra);
      },
    ],
  ];

  it.each(mutations)(
    'rejects %s at the expected gate',
    (_label, expectedError, mutate) => {
      const candidate = structuredClone(result);
      mutate(candidate);
      expect(() => validate(candidate)).toThrow(expectedError);
    },
  );

  it('rejects an empty but schema-valid graph response', () => {
    const candidate = structuredClone(result),
      root = candidate.neighbors.symbols.find(
        (symbol) => symbol.id === candidate.neighbors.rootSymbolId,
      )!,
      target = candidate.incoming.symbols.find(
        (symbol) => symbol.id === candidate.incoming.rootSymbolId,
      )!;
    candidate.neighbors.symbols = [root];
    candidate.neighbors.relations = [];
    candidate.incoming.symbols = [target];
    candidate.incoming.relations = [];
    candidate.paths.symbols = [root, target];
    candidate.paths.relations = [];
    candidate.paths.paths = [];

    expect(() =>
      graphNeighborsResponseSchema.parse(candidate.neighbors),
    ).not.toThrow();
    expect(() =>
      graphNeighborsResponseSchema.parse(candidate.incoming),
    ).not.toThrow();
    expect(() =>
      findSymbolPathsResponseSchema.parse(candidate.paths),
    ).not.toThrow();
    expect(() =>
      getSourceEvidenceResponseSchema.parse(candidate.excerpts),
    ).not.toThrow();
    expect(() => validate(candidate)).toThrow(
      /outgoing target did not resolve to one source anchor/,
    );
  });

  it('rejects a changed source revision pin', () => {
    const candidate = structuredClone(corpus.gold);
    candidate.revision = '0000000000000000000000000000000000000000';
    expect(() =>
      validateExternalGraph(
        name,
        candidate,
        corpus.files,
        snapshot.facts,
        result,
      ),
    ).toThrow(/revision pin changed/);
  });

  it('rejects source bytes that no longer match the independent hash', () => {
    const original = corpus.files[0]!,
      bytes = Uint8Array.from(original.bytes);
    bytes[0] = bytes[0]! ^ 1;
    const changedFiles = corpus.files.map((file, index) =>
      index === 0 ? { ...file, bytes } : file,
    );
    expect(() =>
      validateExternalGraph(
        name,
        corpus.gold,
        changedFiles,
        snapshot.facts,
        result,
      ),
    ).toThrow(/source bytes do not match the independent pin/);
  });

  it('rejects source files outside the independent pinned set', () => {
    const extra = { ...corpus.files[0]!, path: 'unreviewed-extra.ts' };
    expect(() =>
      validateExternalGraph(
        name,
        corpus.gold,
        [...corpus.files, extra],
        snapshot.facts,
        result,
      ),
    ).toThrow(/source paths differ from the independent pin/);
  });
});
