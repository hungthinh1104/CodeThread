import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { loadRepositoryCorpus } from './repository-corpus.ts';
import type {
  RepositoryCorpus,
  RepositoryCorpusName,
} from './repository-corpus.ts';
import { materializeRepositoryCorpus } from './repository-corpus-git.ts';
import { analyzeGitRepository } from './investigation/repository-session.ts';
import type { RepositoryInvestigationSession } from './investigation/repository-session.ts';
import { loadRepositoryGold } from './repository-gold.ts';
import type { RepositoryGold } from './repository-gold.ts';
import { validateRepositoryGoldCorrections } from './repository-gold-review.ts';
import {
  equalGoldRange,
  repositoryGoldContext,
  symbolMatchesGold,
  validateClosedGoldOwner,
  validateRepositoryGoldLabel,
} from './repository-graph-gold.ts';
import type { RepositoryGoldContext } from './repository-graph-gold.ts';

export function evaluateRepositorySession(
  session: RepositoryInvestigationSession,
  corpus: RepositoryCorpus,
  gold: RepositoryGold,
) {
  const allLabels = gold.labels.filter(
    (label) => label.repository === corpus.name,
  );
  const corrections = gold.corrections.filter(
    (correction) => correction.repository === corpus.name,
  );
  const goldOccurrenceKey = (item: {
    repository: string;
    configPath: string;
    site: { file: string; start: { offset: number }; end: { offset: number } };
  }) =>
    JSON.stringify([
      item.repository,
      item.configPath,
      item.site.file,
      item.site.start.offset,
      item.site.end.offset,
    ]);
  const correctedOccurrenceKeys = new Set(corrections.map(goldOccurrenceKey));
  const labels = allLabels.filter(
    (label) => !correctedOccurrenceKeys.has(goldOccurrenceKey(label)),
  );
  const postPredictionLabels = allLabels.filter((label) =>
    correctedOccurrenceKeys.has(goldOccurrenceKey(label)),
  );
  const failures: {
    configPath: string | null;
    site?: string;
    message: string;
  }[] = [];
  const cache = new Map<string, RepositoryGoldContext>();
  const context = (configPath: string) => {
    const cached = cache.get(configPath);
    if (cached) return cached;
    const project = session.projects.find(
      (project) => project.project.configPath === configPath,
    );
    assert(
      project?.snapshot && project.status === 'ready',
      'Gold project has no usable snapshot',
    );
    const result = repositoryGoldContext(project.snapshot);
    cache.set(configPath, result);
    return result;
  };
  try {
    validateRepositoryGoldCorrections(corpus, gold);
    assert(
      labels.length > 0,
      'Repository has no independently specified acceptance cases',
    );
    assert.equal(
      session.commitId,
      corpus.manifest.revision,
      'Repository revision changed',
    );
    assert.equal(
      session.inventory.complete,
      true,
      'Whole source inventory is incomplete',
    );
    assert.deepEqual(
      session.files.map(({ path, sha256, byteLength }) => ({
        path,
        sha256,
        byteLength,
      })),
      corpus.manifest.files.map(({ path, sha256, byteLength }) => ({
        path,
        sha256,
        byteLength,
      })),
      'Whole source inventory differs from independent pinned Git inventory',
    );
    assert.equal(
      session.sourceCoverageComplete,
      true,
      'Some committed TypeScript source was not analyzed',
    );
    assert.equal(
      session.analysisComplete,
      true,
      'A repository project failed or was skipped',
    );
    const missingContext = session.projects.some((project) =>
      project.snapshot?.facts.diagnostics.some((diagnostic) =>
        ['TS_2307', 'TS_2688', 'TS_6053', 'TS_7016', 'TS_2792'].includes(
          diagnostic.code,
        ),
      ),
    );
    if (missingContext)
      assert.equal(
        session.contextComplete,
        false,
        'Missing source/type context was reported complete',
      );
  } catch (error) {
    failures.push({
      configPath: null,
      message:
        error instanceof Error
          ? error.message
          : 'Repository intake gate failed',
    });
  }
  let observedLabeledCases = 0,
    correctCases = 0,
    correctExact = 0,
    wrongExact = 0,
    missedExact = 0;
  for (const label of labels) {
    try {
      assert.equal(
        label.revision,
        corpus.manifest.revision,
        'Gold revision mismatch',
      );
      const project = context(label.configPath);
      const observation = project.snapshot.facts.observations.find(
        (observation) => {
          const evidence = project.evidence.get(observation.evidenceId),
            file = evidence && project.files.get(evidence.fileId);
          return (
            file?.path === label.site.file &&
            evidence &&
            equalGoldRange(evidence.range, label.site)
          );
        },
      );
      if (observation) observedLabeledCases++;
      if (observation?.status === 'exact') {
        const relation =
          observation.relationId &&
          project.relations.get(observation.relationId);
        const targetId =
          relation && relation.resolution.status === 'exact'
            ? relation.resolution.targetId
            : null;
        const target = project.snapshot.facts.symbols.find(
          (symbol) => symbol.id === targetId,
        );
        if (
          !label.target ||
          !target ||
          !symbolMatchesGold(project.snapshot, target, label.target)
        )
          wrongExact++;
      } else if (label.status === 'exact') missedExact++;
      validateRepositoryGoldLabel(project, label, corpus);
      correctCases++;
      if (label.status === 'exact') correctExact++;
    } catch (error) {
      failures.push({
        configPath: label.configPath,
        site: `${label.site.file}:${label.site.start.line}:${label.site.start.column}`,
        message:
          error instanceof Error
            ? error.message
            : 'Gold acceptance case failed',
      });
    }
  }
  for (const closed of gold.closedOwners.filter(
    (owner) => owner.repository === corpus.name,
  )) {
    try {
      validateClosedGoldOwner(
        context(closed.configPath),
        closed.owner,
        labels.filter((label) => label.configPath === closed.configPath),
      );
    } catch (error) {
      failures.push({
        configPath: closed.configPath,
        message:
          error instanceof Error
            ? error.message
            : 'Closed owner graph gate failed',
      });
    }
  }
  const rawCounts = {
    exact: 0,
    unresolved: 0,
    ambiguous: 0,
    unsupported: 0,
    projectOccurrences: 0,
    uniqueSourceOccurrences: 0,
  };
  const sites = new Set<string>();
  for (const project of session.projects)
    if (project.snapshot) {
      const snapshot = project.snapshot,
        evidence = new Map(
          snapshot.facts.evidenceRefs.map((item) => [item.id, item]),
        );
      const files = new Map(
        snapshot.facts.files.map((file) => [file.id, file]),
      );
      for (const observation of snapshot.facts.observations) {
        rawCounts[observation.status]++;
        rawCounts.projectOccurrences++;
        const site = evidence.get(observation.evidenceId),
          file = site && files.get(site.fileId);
        if (site && file)
          sites.add(
            `${file.path}:${file.contentHash}:${site.range.start.offset}:${site.range.end.offset}`,
          );
      }
    }
  rawCounts.uniqueSourceOccurrences = sites.size;
  return {
    repository: corpus.manifest.repository,
    revision: corpus.manifest.revision,
    scope: corpus.manifest.scope,
    sourceFiles: session.files.length,
    sourceBytes: session.inventory.sourceBytes,
    reviewStatus: gold.reviewStatus,
    authoredBeforePredictions:
      gold.originalLabelsAuthoredBeforePredictions && corrections.length === 0,
    originalLabelsAuthoredBeforePredictions:
      gold.originalLabelsAuthoredBeforePredictions,
    postPredictionCorrections: corrections,
    counts: {
      labeledCases: allLabels.length,
      scoredCases: labels.length,
      observedLabeledCases,
      prePredictionCases: labels.length,
      postPredictionExcludedCases: postPredictionLabels.length,
      correctCases,
      expectedExact: labels.filter((label) => label.status === 'exact').length,
      correctExact,
      wrongExact,
      missedExact,
    },
    rawCounts,
    unscoredProjectOccurrences:
      rawCounts.projectOccurrences - observedLabeledCases,
    completeness: {
      inventory: session.inventory.complete,
      sourceCoverage: session.sourceCoverageComplete,
      contextsFinished: session.analysisComplete,
      context: session.contextComplete,
    },
    projects: session.projects.map((project) => ({
      configPath: project.project.configPath,
      status: project.status,
      counts: project.snapshot?.facts.counts ?? null,
      contextDiagnostics:
        project.snapshot?.contextDiagnostics ?? project.project.diagnostics,
      sourceDiagnosticCount: project.snapshot?.facts.diagnostics.length ?? 0,
      error: project.error ?? null,
      execution: project.snapshot?.execution ?? null,
    })),
    metrics: session.metrics,
    gate: { passed: failures.length === 0, failures },
    interpretation:
      'Correctness is evaluated only on source-authored labels fixed before predictions; post-prediction corrections are disclosed but excluded from acceptance counts. All other occurrence counts are unscored static output, not a repository-wide accuracy claim.',
  };
}

export async function evaluatePinnedRepository(name: RepositoryCorpusName) {
  const corpus = await loadRepositoryCorpus(name),
    gold = await loadRepositoryGold();
  const repository = await materializeRepositoryCorpus(corpus);
  try {
    const session = await analyzeGitRepository({
      repositoryPath: repository.directory,
      repositoryId: '00000000-0000-4000-8000-000000000076',
      revision: corpus.manifest.revision,
    });
    return {
      report: evaluateRepositorySession(session, corpus, gold),
      session,
      corpus,
      gold,
    };
  } finally {
    await repository.cleanup();
  }
}

export async function runRepositoryEvaluations(): Promise<void> {
  for (const name of ['ufo', 'sourcemaps'] as const) {
    try {
      const { report } = await evaluatePinnedRepository(name);
      process.stdout.write(JSON.stringify({ name, ...report }) + '\n');
      if (!report.gate.passed) process.exitCode = 1;
    } catch (error) {
      process.stdout.write(
        JSON.stringify({
          name,
          gate: { passed: false },
          failure:
            error instanceof Error
              ? error.message
              : 'Repository evaluation failed',
        }) + '\n',
      );
      process.exitCode = 1;
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runRepositoryEvaluations();
