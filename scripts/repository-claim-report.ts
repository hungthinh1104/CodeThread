import assert from 'node:assert/strict';
import type { RepositoryInvestigationSession } from './investigation/repository-session.ts';
import type { RepositoryCorpus } from './repository-corpus.ts';
import type { RepositoryGoldAnchor } from './repository-gold.ts';
import { equalGoldRange, goldSiteKey } from './repository-gold-source.ts';
import {
  assessRepositoryGoldLabel,
  inspectClosedGoldOwner,
  validateClosedGoldOwner,
} from './repository-graph-gold.ts';
import type { GoldExpectation } from './repository-graph-gold.ts';
import type {
  GoldIssue,
  RepositoryGoldContext,
} from './repository-gold-trace.ts';
import type { verifyRepositoryReview } from './repository-review.ts';

export type Failure = {
  configPath: string | null;
  site?: string;
  code: GoldIssue['code'] | 'input_mismatch';
  message: string;
};

export function describeError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'Repository evaluation failed';
}

type ComparableLabel = GoldExpectation & { configPath: string };
type CheckedLabel = {
  label: ComparableLabel;
  observed: boolean;
  matchedCallObservations: number;
  issues: GoldIssue[];
  exactIds: string[];
  correctExactId?: string | undefined;
};

export function checkLabel(
  label: ComparableLabel,
  context: (configPath: string) => RepositoryGoldContext,
  corpus: RepositoryCorpus,
): CheckedLabel {
  let project: RepositoryGoldContext;
  try {
    project = context(label.configPath);
  } catch (error) {
    return {
      label,
      observed: false,
      matchedCallObservations: 0,
      exactIds: [],
      issues: [{ code: 'identity_mismatch', message: describeError(error) }],
    };
  }
  return { label, ...assessRepositoryGoldLabel(project, label, corpus) };
}

export function matchesOwner(label: TypedOwner, owner: TypedOwner): boolean {
  return (
    label.configPath === owner.configPath &&
    label.owner.file === owner.owner.file &&
    label.owner.sourceSha256 === owner.owner.sourceSha256 &&
    equalGoldRange(label.owner, owner.owner)
  );
}
type TypedOwner = { configPath: string; owner: RepositoryGoldAnchor };

export function labelFailures(check: CheckedLabel): Failure[] {
  const { configPath, site } = check.label;
  return check.issues.map((issue) => ({
    ...issue,
    configPath,
    site: [site.file, site.start.line, site.start.column].join(':'),
  }));
}

export function summarizeChecks(
  cases: readonly CheckedLabel[],
  unexpectedExactIds: readonly string[],
) {
  const claimKey = (configPath: string, id: string) =>
    JSON.stringify([configPath, id]);
  const expectedExact = cases.filter(
    ({ label }) => label.status === 'exact',
  ).length;
  const observedExact = new Set([
    ...cases.flatMap(({ label, exactIds }) =>
      exactIds.map((id) => claimKey(label.configPath, id)),
    ),
    ...unexpectedExactIds,
  ]).size;
  const correctExact = cases.filter(
    (item) => item.correctExactId !== undefined,
  ).length;
  return {
    observedLabeledCases: cases.filter((item) => item.observed).length,
    matchedCallObservations: cases.reduce(
      (count, item) => count + item.matchedCallObservations,
      0,
    ),
    correctCases: cases.filter((item) => !item.issues.length).length,
    expectedExact,
    observedExact,
    correctExact,
    wrongExact: observedExact - correctExact,
    missedExact: expectedExact - correctExact,
  };
}

export function countGoldIssues(failures: readonly Failure[]) {
  return Object.fromEntries(
    (
      [
        'wrong_owner',
        'wrong_kind',
        'wrong_direction',
        'wrong_target',
        'evidence_mismatch',
        'identity_mismatch',
        'wrong_status',
        'missing_occurrence',
        'duplicate_occurrence',
        'unexpected_exact',
        'invalid_projection',
      ] as const
    ).map((code) => [
      code,
      failures.filter((failure) => failure.code === code).length,
    ]),
  );
}

export function observationCounts(session: RepositoryInvestigationSession) {
  const counts = {
    exact: 0,
    unresolved: 0,
    ambiguous: 0,
    unsupported: 0,
    projectOccurrences: 0,
    uniqueSourceOccurrences: 0,
  };
  const sites = new Set<string>();
  for (const { snapshot } of session.projects) {
    if (!snapshot) continue;
    const evidence = new Map(
      snapshot.facts.evidenceRefs.map((item) => [item.id, item]),
    );
    const files = new Map(snapshot.facts.files.map((file) => [file.id, file]));
    for (const observation of snapshot.facts.observations) {
      counts[observation.status]++;
      counts.projectOccurrences++;
      const site = evidence.get(observation.evidenceId);
      const file = site && files.get(site.fileId);
      if (site && file)
        sites.add(
          JSON.stringify([
            file.path,
            file.contentHash,
            site.range.start.offset,
            site.range.end.offset,
          ]),
        );
    }
  }
  return { ...counts, uniqueSourceOccurrences: sites.size };
}

type FrozenScope = ReturnType<typeof verifyRepositoryReview>['scopes'][number];

export function auditScope(
  scope: FrozenScope,
  cases: readonly CheckedLabel[],
  context: (path: string) => RepositoryGoldContext,
  completeReview: boolean,
) {
  const failures: Failure[] = [];
  const unexpectedIds: string[] = [];
  try {
    // Historical closures specified every call. A human closure also covers access and constructor candidates.
    const inventory = completeReview
      ? scope.inventory.sites
      : scope.inventory.sites.filter(({ kind }) => kind === 'calls');
    const keys = (entries: readonly { site: RepositoryGoldAnchor }[]) =>
      entries.map(({ site }) => goldSiteKey(site.file, site)).sort();
    assert.deepEqual(
      keys(cases.map(({ label }) => label)),
      keys(inventory),
      'Closed source occurrence denominator differs from the frozen inventory',
    );
    const project = context(scope.configPath);
    const labels = cases.map(({ label }) => label);
    const inspection = inspectClosedGoldOwner(
      project,
      scope.owner,
      labels,
      scope.inventory,
    );
    const { unexpected } = inspection;
    for (const relation of unexpected) {
      unexpectedIds.push(JSON.stringify([scope.configPath, relation.id]));
      failures.push({
        configPath: scope.configPath,
        code: 'unexpected_exact',
        site:
          project.occurrenceKey(relation.siteEvidenceId) ?? scope.owner.file,
        message:
          'Closed gold owner has an unexpected EXACT ' +
          relation.kind +
          ' occurrence',
      });
    }
    if (!unexpected.length)
      validateClosedGoldOwner(
        project,
        scope.owner,
        labels,
        scope.inventory,
        inspection,
      );
  } catch (error) {
    failures.push({
      configPath: scope.configPath,
      code: 'invalid_projection',
      message: describeError(error),
    });
  }
  return { failures, unexpectedIds, ...summarizeChecks(cases, unexpectedIds) };
}

export function scopedRatio(numerator: number, denominator: number) {
  return {
    numerator,
    denominator,
    value: denominator ? numerator / denominator : null,
  };
}
