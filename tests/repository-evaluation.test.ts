import { beforeAll, describe, expect, it } from 'vitest';
import {
  parseGraphNeighborsResult,
  graphNeighborsRequestSchema,
} from '@codethread/contracts';
import {
  evaluatePinnedRepository,
  evaluateRepositorySession,
} from '../scripts/eval-repository.ts';
import {
  repositoryGoldContext,
  validateClosedGoldOwner,
  validateRepositoryGoldLabel,
} from '../scripts/repository-graph-gold.ts';
import { validateRepositoryGoldCorrections } from '../scripts/repository-gold-review.ts';

type Evaluated = Awaited<ReturnType<typeof evaluatePinnedRepository>>;
const evaluated = new Map<'ufo' | 'sourcemaps', Evaluated>();
beforeAll(async () => {
  for (const name of ['ufo', 'sourcemaps'] as const)
    evaluated.set(name, await evaluatePinnedRepository(name));
}, 120000);

describe('whole-repository source-pinned acceptance', () => {
  it.each([
    ['ufo', 21, 4, 4],
    ['sourcemaps', 53, 5, 2],
  ] as const)(
    'verifies every source and labeled case for %s',
    (name, files, labels, exact) => {
      const result = evaluated.get(name)!;
      expect(result.report.gate).toEqual({ passed: true, failures: [] });
      expect(result.report.sourceFiles).toBe(files);
      expect(result.report.counts).toMatchObject({
        labeledCases: labels,
        correctCases: labels,
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
        result.report.rawCounts.projectOccurrences - labels,
      );
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
  });
});
