import { beforeAll, describe, expect, it } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { AnalysisFacts, CodeRelation } from '@codethread/code-model';
import {
  parseGraphNeighborsResult,
  graphNeighborsRequestSchema,
} from '@codethread/contracts';
import {
  evaluatePinnedRepository,
  evaluateRepositorySession,
} from '../scripts/eval-repository.ts';
import {
  symbolMatchesGold,
  validateClosedGoldOwner,
  validateRepositoryGoldLabel,
} from '../scripts/repository-graph-gold.ts';
import { repositoryGoldContext } from '../scripts/repository-gold-trace.ts';
import { validateRepositoryGoldCorrections } from '../scripts/repository-gold-review.ts';
import {
  equalGoldRange,
  inventoryGoldOwner,
  pinnedSourceExcerpt,
} from '../scripts/repository-gold-source.ts';
import { verifyReviewManifest } from '../scripts/repository-review.ts';

type Evaluated = Awaited<ReturnType<typeof evaluatePinnedRepository>>;
const evaluated = new Map<'ufo' | 'sourcemaps', Evaluated>();
beforeAll(async () => {
  for (const name of ['ufo', 'sourcemaps'] as const)
    evaluated.set(name, await evaluatePinnedRepository(name));
}, 120000);

function ufoSubject() {
  const ground = evaluated.get('ufo')!;
  const project = ground.session.projects.find(
    ({ project }) => project.configPath === 'tsconfig.json',
  )!;
  const label = ground.gold.labels.find(
    (item) => item.repository === 'ufo' && item.expression === 'parseURL',
  )!;
  const snapshot = project.snapshot!;
  const facts = structuredClone(snapshot.facts);
  const evidence = facts.evidenceRefs.find(
    (item) =>
      equalGoldRange(item.range, label.site) &&
      item.contentHash === label.site.sourceSha256,
  )!;
  const relation = facts.relations.find(
    (item) => item.siteEvidenceId === evidence.id,
  )!;
  assert(relation.resolution.status === 'exact');
  const owner = facts.symbols.find(
    (symbol) => symbol.id === relation.sourceSymbolId,
  )!;
  const wrong = facts.symbols.find((symbol) => symbol.name === 'parseQuery')!;
  assert(label.target && symbolMatchesGold(snapshot, owner, label.owner));
  assert(relation.resolution.targetId !== wrong.id);
  return { ground, project, snapshot, facts, evidence, relation, owner, wrong };
}

type MutationSubject = ReturnType<typeof ufoSubject>;
function auditFacts(
  subject: MutationSubject,
  facts: AnalysisFacts = subject.facts,
) {
  const { ground, project, snapshot } = subject;
  return evaluateRepositorySession(
    {
      ...ground.session,
      projects: ground.session.projects.map((entry) =>
        entry === project
          ? { ...entry, snapshot: { ...snapshot, facts } }
          : entry,
      ),
    },
    ground.corpus,
    ground.gold,
    ground.review,
  );
}

describe('whole-repository source-pinned acceptance', () => {
  it.each([
    ['ufo', 21, 4, 4, 0],
    ['sourcemaps', 53, 5, 2, 1],
  ] as const)(
    'verifies every source and labeled case for %s',
    (name, files, labels, exact, excluded) => {
      const result = evaluated.get(name)!;
      expect(result.report.gate).toEqual({ passed: true, failures: [] });
      expect(result.report.sourceFiles).toBe(files);
      expect(result.report.counts).toMatchObject({
        labeledCases: labels,
        scoredCases: labels - excluded,
        prePredictionCases: labels - excluded,
        postPredictionExcludedCases: excluded,
        correctCases: labels - excluded,
        correctExact: exact,
        wrongExact: 0,
        missedExact: 0,
      });
      expect(result.report.completeness).toEqual({
        inventory: true,
        sourceCoverage: true,
        contextsFinished: true,
        context: false,
      });
      expect(result.report.rawCounts.projectOccurrences).toBeGreaterThan(
        labels,
      );
      expect(result.report.unscoredProjectOccurrences).toBe(
        result.report.rawCounts.projectOccurrences - (labels - excluded),
      );
      expect(result.report.semanticAudit).toMatchObject({
        originalAuthor: 'Codex',
        historicalClosedCases: name === 'ufo' ? 4 : 1,
        historicalPartialCases: name === 'ufo' ? 0 : 3,
        reviewedExistingCases: 0,
        blindHumanAuthoredCases: 0,
      });
      expect(
        result.report.semanticAudit.scopes.map(
          ({ occurrences }) => occurrences,
        ),
      ).toEqual(name === 'ufo' ? [5, 8] : [1]);
      expect(
        result.report.semanticAudit.scopes.every(
          ({ precision, recall, review }) =>
            precision === null && recall === null && review === null,
        ),
      ).toBe(true);
    },
  );

  it('rejects a valid-shaped empty graph for a fully labeled owner', () => {
    const result = evaluated.get('ufo')!,
      project = result.session.projects.find(
        (item) => item.project.configPath === 'tsconfig.json',
      )!;
    const context = repositoryGoldContext(project.snapshot!),
      original = context.queries;
    const empty = {
      ...context,
      queries: {
        ...original,
        neighbors(input: unknown) {
          const request = graphNeighborsRequestSchema.parse(input),
            graph = original.neighbors(request);
          const root = graph.symbols.find(
            (symbol) => symbol.id === graph.rootSymbolId,
          )!;
          return parseGraphNeighborsResult(request, {
            ...graph,
            symbols: [root],
            relations: [],
            evidenceRefs: graph.evidenceRefs.filter(
              (evidence) => evidence.id === root.declarationEvidenceId,
            ),
            diagnostics: [],
          });
        },
      },
    };
    const closed = result.gold.closedOwners.find(
      (owner) => owner.repository === 'ufo',
    )!;
    expect(() =>
      validateClosedGoldOwner(
        empty,
        closed.owner,
        result.gold.labels.filter((label) => label.repository === 'ufo'),
        inventoryGoldOwner(result.corpus, closed.owner),
      ),
    ).toThrow(/missing or fabricated graph occurrences/);
  });

  it('rejects a wrong exact target even when the graph parser accepts its shape', () => {
    const result = evaluated.get('ufo')!,
      snapshot = result.session.projects.find(
        (item) => item.project.configPath === 'tsconfig.json',
      )!.snapshot!;
    const context = repositoryGoldContext(snapshot),
      original = context.queries;
    const first = result.gold.labels.find(
      (label) => label.repository === 'ufo' && label.expression === 'parseURL',
    )!;
    const mutated = {
      ...context,
      queries: {
        ...original,
        neighbors(input: unknown) {
          const request = graphNeighborsRequestSchema.parse(input),
            graph = original.neighbors(request);
          const copy = structuredClone(graph);
          const relation = copy.relations.find((relation) => {
            const site = copy.evidenceRefs.find(
              (evidence) => evidence.id === relation.siteEvidenceId,
            );
            return site?.range.start.offset === first.site.start.offset;
          })!;
          const wrong = copy.symbols.find(
            (symbol) => symbol.name === 'parseQuery',
          )!;
          if (relation.resolution.status === 'exact')
            relation.resolution = {
              ...relation.resolution,
              targetId: wrong.id,
              evidenceIds: [
                relation.siteEvidenceId,
                wrong.declarationEvidenceId,
              ],
            };
          const endpoints = new Set([copy.rootSymbolId]);
          for (const relation of copy.relations) {
            endpoints.add(relation.sourceSymbolId);
            if (relation.resolution.status === 'exact')
              endpoints.add(relation.resolution.targetId);
          }
          copy.symbols = copy.symbols.filter((symbol) =>
            endpoints.has(symbol.id),
          );
          const evidenceIds = new Set([
            ...copy.symbols.flatMap((symbol) => symbol.evidenceIds),
            ...copy.relations.flatMap(
              (relation) => relation.resolution.evidenceIds,
            ),
          ]);
          copy.evidenceRefs = copy.evidenceRefs.filter((evidence) =>
            evidenceIds.has(evidence.id),
          );
          return parseGraphNeighborsResult(request, copy);
        },
      },
    };
    expect(() =>
      validateRepositoryGoldLabel(mutated, first, result.corpus),
    ).toThrow(/different exact target/);
  });

  it('refuses to verify an exact row when the direct projection exceeded its result budget', () => {
    const { ground, snapshot } = ufoSubject();
    const label = ground.gold.labels.find(
      (entry) => entry.repository === 'ufo' && entry.expression === 'parseURL',
    )!;
    const healthy = repositoryGoldContext(snapshot);
    const truncated = {
      ...healthy,
      queries: {
        ...healthy.queries,
        neighbors(input: unknown) {
          const request = graphNeighborsRequestSchema.parse(input);
          const graph = healthy.queries.neighbors(request);
          return parseGraphNeighborsResult(request, {
            ...graph,
            meta: {
              ...graph.meta,
              truncated: true,
              truncationReasons: ['result_limit'],
            },
          });
        },
      },
    };
    expect(() =>
      validateRepositoryGoldLabel(truncated, label, ground.corpus),
    ).toThrow(/exceeded the direct-scope budget/);
  });

  it('rejects a fabricated complete source selection and missing-context status', () => {
    const result = evaluated.get('sourcemaps')!;
    const missing = {
      ...result.corpus,
      manifest: {
        ...result.corpus.manifest,
        files: result.corpus.manifest.files.slice(1),
      },
    };
    const omitted = evaluateRepositorySession(
      result.session,
      missing,
      result.gold,
      result.review,
    );
    expect(omitted.gate.passed).toBe(false);
    expect(
      omitted.gate.failures.some((failure) =>
        failure.message.includes('independent pinned Git inventory'),
      ),
    ).toBe(true);
    const context = evaluateRepositorySession(
      { ...result.session, contextComplete: true },
      result.corpus,
      result.gold,
      result.review,
    );
    expect(context.gate.passed).toBe(false);
    expect(
      context.gate.failures.some((failure) =>
        failure.message.includes(
          'Missing source/type context was reported complete',
        ),
      ),
    ).toBe(true);
  });

  it('retains and verifies the post-prediction overload annotation correction', () => {
    const result = evaluated.get('sourcemaps')!;
    expect(result.report.authoredBeforePredictions).toBe(false);
    expect(result.report.counts.prePredictionCases).toBe(4);
    expect(result.report.counts.scoredCases).toBe(4);
    expect(result.report.counts.postPredictionExcludedCases).toBe(1);
    expect(result.report.counts.correctCases).toBe(4);
    expect(result.report.counts.expectedExact).toBe(2);
    expect(result.report.counts.wrongExact).toBe(0);
    expect(result.report.postPredictionCorrections).toHaveLength(1);
    expect(result.report.postPredictionCorrections[0]).toMatchObject({
      previousStatus: 'exact',
      revisedStatus: 'unsupported',
      overloadSignatures: 2,
      trigger: 'post_prediction_source_review',
    });
    const invalid = structuredClone(result.gold);
    invalid.corrections[0]!.overloadSignatures = 1 as 2;
    expect(() =>
      validateRepositoryGoldCorrections(result.corpus, invalid),
    ).toThrow(/overload signatures/);
    const duplicate = structuredClone(result.gold);
    duplicate.corrections.push(structuredClone(duplicate.corrections[0]!));
    expect(() =>
      validateRepositoryGoldCorrections(result.corpus, duplicate),
    ).toThrow(/Duplicate post-prediction correction/);
  });

  it('refuses to score a rewritten correction denominator', () => {
    const result = evaluated.get('sourcemaps')!;
    expect(() =>
      evaluateRepositorySession(
        result.session,
        result.corpus,
        { ...result.gold, authoredBeforePredictions: true, corrections: [] },
        result.review,
      ),
    ).toThrow(/Historical gold or its correction denominator changed/);
  });

  it('rejects editing the frozen review denominator or upgrading provenance without a record', () => {
    const result = evaluated.get('ufo')!;
    const modified = structuredClone(result.review);
    modified.freeze.scopes[0]!.occurrences++;
    expect(() => verifyReviewManifest(modified)).toThrow(
      /Frozen review input changed/,
    );
    expect(() =>
      evaluateRepositorySession(
        result.session,
        result.corpus,
        { ...result.gold, reviewStatus: 'independently_reviewed' as never },
        result.review,
      ),
    ).toThrow(/not_independently_reviewed/);
    expect(() =>
      verifyReviewManifest({
        ...result.review,
        records: [
          {
            scopeId: result.review.freeze.scopes[0]!.id,
            disposition: 'accepted',
          },
        ],
      }),
    ).toThrow(/reviewerAlias/);
  });

  it('rejects attaching the correct snapshot to a different compiler project', () => {
    const baseline = evaluated.get('ufo')!;
    const session = {
      ...baseline.session,
      projects: baseline.session.projects.map((item) =>
        item.project.configPath === 'tsconfig.json'
          ? {
              ...item,
              project: {
                ...item.project,
                id: 'project:111111111111111111111111',
              },
            }
          : item,
      ),
    };
    const report = evaluateRepositorySession(
      session,
      baseline.corpus,
      baseline.gold,
      baseline.review,
    );
    expect(report.gate.passed).toBe(false);
    expect(report.gate.failures).toContainEqual(
      expect.objectContaining({
        code: 'identity_mismatch',
        message: expect.stringContaining('Gold project identity differs'),
      }),
    );
  });

  it('rejects a coherent snapshot from another context of the same repository', () => {
    const { session, corpus, gold, review } = evaluated.get('sourcemaps')!;
    const foreign = session.projects.find(
      ({ project }) =>
        project.configPath === 'packages/trace-mapping/tsconfig.build.json',
    )!.snapshot!;
    const altered = {
      ...session,
      projects: session.projects.map((item) =>
        item.project.configPath === 'packages/trace-mapping/tsconfig.json'
          ? { ...item, snapshot: foreign }
          : item,
      ),
    };
    const report = evaluateRepositorySession(altered, corpus, gold, review);
    expect(report.gate.passed).toBe(false);
    expect(report.gate.failures).toContainEqual(
      expect.objectContaining({
        code: 'identity_mismatch',
        message: expect.stringContaining('another compiler context'),
      }),
    );
  });

  it('keeps a disputed test record out of scoring and rejects retrospective promotion', () => {
    const baseline = evaluated.get('ufo')!;
    // Invalid promotion controls. No reviewer claims are written to the ledger.
    const disputed = {
      scopeId: baseline.review.freeze.scopes[0]!.id,
      frozenInputSha256: baseline.review.frozenInputSha256,
      reviewerAlias: 'synthetic-control',
      reviewerDidNotAuthorLabels: true,
      reviewedAt: baseline.review.freeze.frozenAt,
      method: 'blind_authored',
      exposure: 'predictions',
      disposition: 'disputed',
      answers: [],
      disagreements: ['Synthetic disagreement for the promotion control.'],
      adjudication: null,
    };
    const seal = (record: typeof disputed) => ({
      ...record,
      recordSha256: createHash('sha256')
        .update(JSON.stringify(record))
        .digest('hex'),
    });
    const ledger = { ...baseline.review, records: [seal(disputed)] };
    const review = verifyReviewManifest(ledger);
    const report = evaluateRepositorySession(
      baseline.session,
      baseline.corpus,
      baseline.gold,
      review,
    );
    expect(report.semanticAudit).toMatchObject({
      blindHumanAuthoredCases: 0,
      disputedScopes: 1,
    });
    expect(report.semanticAudit.scopes[0]!.precision).toBeNull();
    expect(() =>
      verifyReviewManifest({
        ...ledger,
        records: [{ ...ledger.records[0], disposition: 'accepted' }],
      }),
    ).toThrow(/Review evidence or provenance changed/);
    expect(() =>
      verifyReviewManifest({
        ...ledger,
        records: [seal({ ...disputed, disposition: 'accepted' })],
      }),
    ).toThrow(/exposed to predictions/);
    const incomplete = verifyReviewManifest({
      ...ledger,
      records: [
        seal({
          ...disputed,
          disposition: 'accepted',
          exposure: 'none',
          disagreements: [],
        }),
      ],
    });
    expect(() =>
      evaluateRepositorySession(
        baseline.session,
        baseline.corpus,
        baseline.gold,
        incomplete,
      ),
    ).toThrow(/Reviewed denominator does not cover the complete owner/);
  });

  it('inventories both same-start calls and keeps nested function sites outside the owner', () => {
    const { corpus } = evaluated.get('ufo')!;
    const source = [
      'function outer() {',
      '  factory()();',
      '  register(value.run);',
      '  function nested() { elsewhere(); }',
      '  outer();',
      '}',
    ].join('\n');
    const file = 'nested-inventory.ts';
    const bytes = Buffer.from(source);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const blobId = createHash('sha1')
      .update('blob ' + bytes.length + '\0')
      .update(bytes)
      .digest('hex');
    const fixture = {
      ...corpus,
      files: [
        {
          path: file,
          sha256,
          blobId,
          mode: '100644' as const,
          bytes,
          byteLength: bytes.length,
        },
      ],
    };
    const owner = {
      file,
      sourceSha256: sha256,
      start: { offset: 0, line: 1, column: 1 },
      end: { offset: source.length, line: 6, column: 2 },
    };
    expect(
      inventoryGoldOwner(fixture, owner).map(({ kind, site }) => [
        kind,
        pinnedSourceExcerpt(fixture, site),
      ]),
    ).toEqual([
      ['calls', 'factory()'],
      ['calls', 'factory()()'],
      ['calls', 'register(value.run)'],
      ['references', 'value.run'],
      ['calls', 'outer()'],
    ]);
  });
});

describe('closed owner false-exact regression controls', () => {
  const mutations: [string, (subject: MutationSubject) => void][] = [
    [
      'wrong_target',
      ({ relation, wrong }) => {
        assert(relation.resolution.status === 'exact');
        relation.resolution.targetId = wrong.id;
        relation.resolution.evidenceIds = [
          ...relation.resolution.evidenceIds,
          wrong.declarationEvidenceId,
        ];
      },
    ],
    [
      'wrong_kind',
      ({ relation }) => {
        relation.kind = 'references';
      },
    ],
    [
      'wrong_owner',
      ({ relation, wrong }) => {
        relation.sourceSymbolId = wrong.id;
      },
    ],
    [
      'wrong_direction',
      ({ relation, owner }) => {
        assert(relation.resolution.status === 'exact');
        relation.sourceSymbolId = relation.resolution.targetId;
        relation.resolution.targetId = owner.id;
      },
    ],
    [
      'evidence_mismatch',
      ({ evidence }) => {
        evidence.contentHash = '0'.repeat(64);
      },
    ],
    [
      'identity_mismatch',
      ({ relation }) => {
        relation.snapshotId = '11111111-1111-4111-8111-111111111111';
      },
    ],
  ];
  it.each(mutations)(
    'records %s and refuses the exact claim',
    (code, mutate) => {
      const subject = ufoSubject();
      mutate(subject);
      const report = auditFacts(subject);
      expect(report.gate.passed).toBe(false);
      expect(report.gate.failures).toContainEqual(
        expect.objectContaining({
          code,
          site: expect.stringMatching(/^src\/utils\.ts:349:/),
        }),
      );
      expect(report.counts.expectedExact).toBe(4);
      expect(report.counts.observedExact).toBe(4);
      expect(report.counts.wrongExact).toBeGreaterThanOrEqual(1);
    },
  );

  it('fails when a valid projection omits one expected call occurrence', () => {
    const subject = ufoSubject();
    const { facts, relation } = subject;
    const altered = {
      ...facts,
      relations: facts.relations.filter((item) => item.id !== relation.id),
      observations: facts.observations.filter(
        (item) => item.relationId !== relation.id,
      ),
      counts: {
        ...facts.counts,
        callSites: facts.counts.callSites - 1,
        exact: facts.counts.exact - 1,
      },
    };
    expect(
      () =>
        repositoryGoldContext({ ...subject.snapshot, facts: altered }).queries,
    ).not.toThrow();
    const report = auditFacts(subject, altered);
    expect(report.gate.passed).toBe(false);
    expect(report.counts).toMatchObject({
      expectedExact: 4,
      observedExact: 3,
      correctExact: 3,
      wrongExact: 0,
      missedExact: 1,
    });
    expect(report.gate.failures).toContainEqual(
      expect.objectContaining({ code: 'missing_occurrence' }),
    );
  });

  it('fails on an unlabelled exact REFERENCES edge that passes fact and trace validation', () => {
    const subject = ufoSubject();
    const { facts, owner } = subject;
    const target = facts.symbols.find((symbol) => symbol.kind === 'method')!;
    const extra: CodeRelation = {
      id: 'f0e8c014-97be-432b-9378-b20112a483df',
      key: 'review-mutation-exact-reference',
      snapshotId: facts.snapshotId,
      kind: 'references',
      sourceSymbolId: owner.id,
      siteEvidenceId: owner.declarationEvidenceId,
      resolution: {
        status: 'exact',
        targetId: target.id,
        evidenceIds: [
          owner.declarationEvidenceId,
          target.declarationEvidenceId,
        ],
      },
    };
    const altered = { ...facts, relations: [...facts.relations, extra] };
    const graph = repositoryGoldContext({
      ...subject.snapshot,
      facts: altered,
    }).queries.neighbors({
      snapshotId: facts.snapshotId,
      symbolId: owner.id,
      relationKinds: ['calls', 'references'],
      direction: 'outgoing',
      depth: 1,
      nodeLimit: 200,
    });
    expect(graph.relations).toContainEqual(extra);
    const report = auditFacts(subject, altered);
    expect(report.gate.passed).toBe(false);
    expect(report.semanticAudit.issues.unexpected_exact).toBe(1);
    expect(report.counts).toMatchObject({
      expectedExact: 4,
      observedExact: 5,
      correctExact: 4,
      wrongExact: 1,
    });
  });
});
