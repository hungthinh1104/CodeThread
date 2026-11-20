import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
import type {
  RepositoryGold,
  RepositoryGoldAnchor,
} from './repository-gold.ts';
import { validateRepositoryGoldCorrections } from './repository-gold-review.ts';
import { goldSiteKey } from './repository-gold-source.ts';
import { repositoryGoldContext } from './repository-gold-trace.ts';
import type { RepositoryGoldContext } from './repository-gold-trace.ts';
import {
  auditScope,
  checkLabel,
  countGoldIssues,
  describeError,
  labelFailures,
  matchesOwner,
  observationCounts,
  scopedRatio,
  summarizeChecks,
} from './repository-claim-report.ts';
import type { Failure } from './repository-claim-report.ts';
import {
  loadRepositoryReview,
  verifyRepositoryReview,
} from './repository-review.ts';
import type { RepositoryReview } from './repository-review.ts';

function inventoryPin({
  path,
  sha256,
  byteLength,
}: Pick<
  RepositoryCorpus['manifest']['files'][number],
  'path' | 'sha256' | 'byteLength'
>) {
  return { path, sha256, byteLength };
}

function verifyIntake(
  session: RepositoryInvestigationSession,
  corpus: RepositoryCorpus,
  repositoryId: string,
) {
  assert.equal(
    session.repositoryId,
    repositoryId,
    'Repository identity differs from the frozen evaluation',
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
    session.files.map(inventoryPin),
    corpus.manifest.files.map(inventoryPin),
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
    project.snapshot?.facts.diagnostics.some(({ code }) =>
      ['TS_2307', 'TS_2688', 'TS_6053', 'TS_7016', 'TS_2792'].includes(code),
    ),
  );
  if (missingContext)
    assert.equal(
      session.contextComplete,
      false,
      'Missing source/type context was reported complete',
    );
}

function repositoryContext(
  session: RepositoryInvestigationSession,
  corpus: RepositoryCorpus,
  review: RepositoryReview,
  configPath: string,
): RepositoryGoldContext {
  const pin = review.freeze.contexts.find(
    (item) => item.repository === corpus.name && item.configPath === configPath,
  );
  const projects = session.projects.filter(
    (item) => item.project.configPath === configPath,
  );
  const [project] = projects;
  assert(
    pin &&
      projects.length === 1 &&
      project?.status === 'ready' &&
      project.snapshot,
    'Gold project has no unique usable snapshot in the frozen context',
  );
  assert.equal(
    project.project.id,
    pin.projectId,
    'Gold project identity differs from the frozen context',
  );
  const identity = project.snapshot.facts.identity;
  assert.equal(
    identity.repositoryId,
    review.freeze.repositoryId,
    'Gold snapshot belongs to another repository',
  );
  assert.equal(
    identity.configurationHash,
    pin.configurationHash,
    'Gold snapshot belongs to another compiler context',
  );
  assert.equal(
    identity.sourceFingerprint,
    pin.sourceFingerprint,
    'Gold snapshot source membership differs from the frozen context',
  );
  // The fingerprint binds the admitted input set. Each project's analyzed
  // files are a subset selected by that compiler context.
  const files = corpus.manifest.files
    .map(inventoryPin)
    .sort((left, right) =>
      Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
    );
  const admittedFingerprint = createHash('sha256')
    .update(JSON.stringify({ version: 1, files }))
    .digest('hex');
  assert.equal(
    admittedFingerprint,
    pin.sourceFingerprint,
    'Gold repository inputs differ from the frozen source fingerprint',
  );
  const admitted = new Map(files.map((file) => [file.path, file]));
  const analyzed = project.snapshot.facts.files;
  assert.equal(
    new Set(analyzed.map((file) => file.path)).size,
    analyzed.length,
    'Gold snapshot repeats a path in its compiler context',
  );
  assert(
    analyzed.every((file) => {
      const pinned = admitted.get(file.path);
      return (
        pinned?.sha256 === file.contentHash &&
        pinned.byteLength === file.byteLength
      );
    }),
    'Gold snapshot contains a file outside the pinned source inputs',
  );
  return repositoryGoldContext(project.snapshot);
}

export function evaluateRepositorySession(
  session: RepositoryInvestigationSession,
  corpus: RepositoryCorpus,
  inputGold: RepositoryGold,
  inputReview: RepositoryReview,
) {
  // A bad ledger or modified historical denominator produces no score.
  const { gold, review, scopes } = verifyRepositoryReview(
    inputReview,
    corpus,
    inputGold,
  );
  validateRepositoryGoldCorrections(corpus, gold);
  const allLabels = gold.labels.filter(
    (label) => label.repository === corpus.name,
  );
  const corrections = gold.corrections.filter(
    (item) => item.repository === corpus.name,
  );
  const occurrenceKey = (entry: {
    configPath: string;
    site: RepositoryGoldAnchor;
  }) =>
    JSON.stringify([
      entry.configPath,
      goldSiteKey(entry.site.file, entry.site),
    ]);
  const excluded = new Set(corrections.map(occurrenceKey));
  const labels = allLabels.filter(
    (label) => !excluded.has(occurrenceKey(label)),
  );
  const failures: Failure[] = [];
  const reviewFailures: Failure[] = [];
  let intakeValid = true;
  try {
    verifyIntake(session, corpus, review.freeze.repositoryId);
  } catch (error) {
    intakeValid = false;
    failures.push({
      configPath: null,
      code: 'input_mismatch',
      message: describeError(error),
    });
  }
  const cache = new Map<string, RepositoryGoldContext>();
  const context = (path: string) => {
    const previous = cache.get(path);
    if (previous) return previous;
    const result = repositoryContext(session, corpus, review, path);
    cache.set(path, result);
    return result;
  };
  const cases = labels.map((label) => checkLabel(label, context, corpus));
  const historicalOwners = gold.closedOwners.filter(
    (owner) => owner.repository === corpus.name,
  );
  for (const owner of historicalOwners)
    assert(
      scopes.some((scope) => matchesOwner(scope, owner)),
      'Historical closed owner is missing from the frozen review plan',
    );
  const closedCases = cases.filter(({ label }) =>
    historicalOwners.some((owner) => matchesOwner(label, owner)),
  );
  const partialCases = cases.filter((item) => !closedCases.includes(item));
  const unexpectedIds: string[] = [];
  failures.push(...cases.flatMap(labelFailures));
  const scopeReports = scopes.map((scope) => {
    const isHistorical = historicalOwners.some((owner) =>
      matchesOwner(scope, owner),
    );
    const historical = isHistorical
      ? auditScope(
          scope,
          closedCases.filter(({ label }) => matchesOwner(label, scope)),
          context,
          false,
        )
      : null;
    if (historical) {
      failures.push(...historical.failures);
      unexpectedIds.push(...historical.unexpectedIds);
    }
    const response = scope.accepted;
    const reviewedCases =
      response?.answers.map((answer) =>
        checkLabel(
          { ...answer, configPath: scope.configPath, owner: scope.owner },
          context,
          corpus,
        ),
      ) ?? [];
    const reviewed = response
      ? auditScope(scope, reviewedCases, context, true)
      : null;
    const independentIssues = reviewed
      ? [...reviewedCases.flatMap(labelFailures), ...reviewed.failures]
      : [];
    reviewFailures.push(...independentIssues);
    const valid =
      intakeValid &&
      reviewed &&
      !independentIssues.some(
        ({ code }) =>
          code === 'identity_mismatch' || code === 'invalid_projection',
      );
    return {
      id: scope.id,
      configPath: scope.configPath,
      owner: scope.owner,
      occurrences: scope.occurrences,
      historicalCallClosure: historical,
      review: scope.record ?? null,
      reviewed,
      reviewedIssues: countGoldIssues(independentIssues),
      precision: valid
        ? scopedRatio(reviewed.correctExact, reviewed.observedExact)
        : null,
      recall: valid
        ? scopedRatio(reviewed.correctExact, reviewed.expectedExact)
        : null,
    };
  });
  const history = summarizeChecks(cases, unexpectedIds);
  const rawCounts = observationCounts(session);
  const countReviewed = (method: 'review_existing' | 'blind_authored') =>
    scopes
      .filter((scope) => scope.accepted?.method === method)
      .reduce((count, scope) => count + scope.accepted!.answers.length, 0);
  const scoredKeys = new Set(labels.map(occurrenceKey));
  const reviewedExistingCases = scopes
    .filter((scope) => scope.accepted?.method === 'review_existing')
    .flatMap((scope) =>
      scope.accepted!.answers.map((answer) =>
        occurrenceKey({ configPath: scope.configPath, site: answer.site }),
      ),
    )
    .filter((key) => scoredKeys.has(key)).length;
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
      prePredictionCases: labels.length,
      postPredictionExcludedCases: allLabels.length - labels.length,
      ...history,
    },
    semanticAudit: {
      frozenInputSha256: review.frozenInputSha256,
      originalAuthor: gold.author,
      historicalClosedCases: closedCases.length,
      historicalPartialCases: partialCases.length,
      historicalPartialResults: summarizeChecks(partialCases, []),
      reviewedExistingCases,
      existingReviewSupplementalCases:
        countReviewed('review_existing') - reviewedExistingCases,
      unreviewedHistoricalCases: labels.length - reviewedExistingCases,
      blindHumanAuthoredCases: countReviewed('blind_authored'),
      previouslyExposedReviewedCases: scopes
        .filter((scope) => scope.accepted?.exposure === 'labels_only')
        .reduce((count, scope) => count + scope.accepted!.answers.length, 0),
      pendingScopes: scopes.filter((scope) => !scope.record).length,
      disputedScopes: scopes.filter(
        (scope) => scope.record?.disposition === 'disputed',
      ).length,
      excludedScopes: scopes.filter(
        (scope) => scope.record?.disposition === 'excluded',
      ).length,
      issues: countGoldIssues(failures),
      reviewIssues: countGoldIssues(reviewFailures),
      scopes: scopeReports,
    },
    rawCounts,
    unscoredProjectOccurrences:
      rawCounts.projectOccurrences - history.matchedCallObservations,
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
    gate: {
      passed: failures.length + reviewFailures.length === 0,
      failures: [...failures, ...reviewFailures],
    },
    interpretation:
      'Historical AI-authored engineering assertions and independent review are separate. Valid completed review scopes report exact-claim precision and recall. Raw call observations outside the historical labels are not correct negatives.',
  };
}

export async function evaluatePinnedRepository(name: RepositoryCorpusName) {
  const [corpus, gold, review] = await Promise.all([
    loadRepositoryCorpus(name),
    loadRepositoryGold(),
    loadRepositoryReview(),
  ]);
  verifyRepositoryReview(review, corpus, gold);
  const repository = await materializeRepositoryCorpus(corpus);
  try {
    const session = await analyzeGitRepository({
      repositoryPath: repository.directory,
      repositoryId: review.freeze.repositoryId,
      revision: corpus.manifest.revision,
    });
    return {
      report: evaluateRepositorySession(session, corpus, gold, review),
      session,
      corpus,
      gold,
      review,
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
          failure: describeError(error),
        }) + '\n',
      );
      process.exitCode = 1;
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runRepositoryEvaluations();
