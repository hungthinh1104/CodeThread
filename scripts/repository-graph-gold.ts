import assert from 'node:assert/strict';
import type { CodeRelation, CodeSymbol } from '@codethread/code-model';
import type { AnalysisSnapshot } from '@codethread/symbol-indexer';
import type { RepositoryCorpus } from './repository-corpus.ts';
import type {
  RepositoryGoldAnchor,
  RepositoryGoldLabel,
} from './repository-gold.ts';
import { equalGoldRange, goldSiteKey } from './repository-gold-source.ts';
import type { GoldOwnerInventory } from './repository-gold-source.ts';
import {
  checkProjection,
  checkTrace,
  directScopeAvailable,
  matchesEvidence,
  TraceGoldIssue,
} from './repository-gold-trace.ts';
import type {
  GoldIssue,
  RepositoryGoldContext,
} from './repository-gold-trace.ts';

export type GoldExpectation = Pick<
  RepositoryGoldLabel,
  'owner' | 'site' | 'target'
> & {
  kind?: CodeRelation['kind'];
  status: RepositoryGoldLabel['status'] | 'absent';
};

export function symbolMatchesGold(
  snapshot: AnalysisSnapshot,
  symbol: CodeSymbol,
  expected: RepositoryGoldAnchor,
): boolean {
  return (
    symbol.filePath === expected.file &&
    equalGoldRange(symbol.range, expected) &&
    snapshot.facts.files.some(
      (file) =>
        file.id === symbol.fileId && file.contentHash === expected.sourceSha256,
    )
  );
}

function anchoredSymbol(
  context: RepositoryGoldContext,
  anchor: RepositoryGoldAnchor,
) {
  const matches = context.snapshot.facts.symbols.filter((symbol) =>
    symbolMatchesGold(context.snapshot, symbol, anchor),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/** Join by source occurrence before testing the claimed owner and target. */
export function assessRepositoryGoldLabel(
  context: RepositoryGoldContext,
  expected: GoldExpectation,
  corpus: RepositoryCorpus,
) {
  const kind = expected.kind ?? 'calls';
  const key = goldSiteKey(expected.site.file, expected.site);
  const owner = anchoredSymbol(context, expected.owner);
  const target = expected.target
    ? anchoredSymbol(context, expected.target)
    : undefined;
  const observations =
    kind === 'calls'
      ? context.snapshot.facts.observations.filter(
          (item) => context.occurrenceKey(item.evidenceId) === key,
        )
      : [];
  const linkedId = observations[0]?.relationId;
  const claims = context.snapshot.facts.relations.filter(
    (relation) =>
      relation.id === linkedId ||
      context.occurrenceKey(relation.siteEvidenceId) === key,
  );
  const relation =
    claims.find((item) => item.id === linkedId) ??
    claims.find((item) => item.kind === kind) ??
    claims[0];
  const issues: GoldIssue[] = [];
  const add = (code: GoldIssue['code'], message: string) => {
    if (!issues.some((issue) => issue.code === code))
      issues.push({ code, message });
  };
  if (
    !owner ||
    observations.some((observation) => observation.ownerId !== owner.id)
  )
    add('wrong_owner', 'Gold lexical owner is missing, ambiguous or different');
  if (observations.length > 1 || claims.length > 1)
    add(
      'duplicate_occurrence',
      'Gold occurrence has duplicated observations or graph claims',
    );

  if (expected.status === 'absent') {
    if (relation || observations.length)
      add('wrong_status', 'An absent relationship was emitted');
  } else {
    if (!relation || (kind === 'calls' && observations.length !== 1))
      add(
        'missing_occurrence',
        'Gold occurrence is missing from facts or observations',
      );
    if (
      (relation && relation.resolution.status !== expected.status) ||
      observations.some((item) => item.status !== expected.status)
    )
      add('wrong_status', 'Gold resolution status differs');
  }

  if (relation) {
    const snapshotId = context.snapshot.facts.snapshotId;
    if (
      relation.snapshotId !== snapshotId ||
      (owner && owner.snapshotId !== snapshotId) ||
      (target && target.snapshotId !== snapshotId)
    )
      add(
        'identity_mismatch',
        'Gold relation or declaration belongs to a different snapshot',
      );
    if (relation.kind !== kind) add('wrong_kind', 'Gold relation kind differs');
    const reversed =
      owner &&
      target &&
      owner.id !== target.id &&
      relation.sourceSymbolId === target.id &&
      relation.resolution.targetId === owner.id;
    if (reversed)
      add('wrong_direction', 'Gold relation reverses the owner and target');
    else {
      if (owner && relation.sourceSymbolId !== owner.id)
        add(
          'wrong_owner',
          'Gold relation is attributed to a different lexical owner',
        );
      if (
        expected.target &&
        relation.resolution.status === 'exact' &&
        (!target || relation.resolution.targetId !== target.id)
      )
        add('wrong_target', 'Gold exact target declaration differs');
    }
    const requiredEvidence = [
      relation.siteEvidenceId,
      ...(owner ? [owner.declarationEvidenceId] : []),
      ...(target && relation.resolution.targetId === target.id
        ? [target.declarationEvidenceId]
        : []),
    ];
    if (
      !matchesEvidence(context, relation.siteEvidenceId, expected.site) ||
      observations.some(
        (item) => item.evidenceId !== relation.siteEvidenceId,
      ) ||
      (owner &&
        !matchesEvidence(
          context,
          owner.declarationEvidenceId,
          expected.owner,
        )) ||
      (target &&
        expected.target &&
        !matchesEvidence(
          context,
          target.declarationEvidenceId,
          expected.target,
        )) ||
      requiredEvidence.some(
        (id) => !relation.resolution.evidenceIds.includes(id),
      )
    )
      add(
        'evidence_mismatch',
        'Gold evidence does not identify the original occurrence and declarations',
      );
    if (issues.length === 0 && owner) {
      try {
        checkTrace(context, relation, owner, target, corpus);
      } catch (error) {
        add(
          error instanceof TraceGoldIssue ? error.code : 'invalid_projection',
          error instanceof Error
            ? error.message
            : 'Gold trace projection failed',
        );
      }
    }
  }
  return {
    issues,
    observed: observations.length > 0 || claims.length > 0,
    matchedCallObservations: observations.length,
    exactIds: claims
      .filter((claim) => claim.resolution.status === 'exact')
      .map((claim) => claim.id),
    correctExactId:
      issues.length === 0 && expected.status === 'exact'
        ? relation?.id
        : undefined,
  };
}

export function validateRepositoryGoldLabel(
  context: RepositoryGoldContext,
  expected: GoldExpectation,
  corpus: RepositoryCorpus,
) {
  const { issues } = assessRepositoryGoldLabel(context, expected, corpus);
  assert.equal(
    issues.length,
    0,
    issues.map((issue) => issue.message).join('. '),
  );
}

export function inspectClosedGoldOwner(
  context: RepositoryGoldContext,
  owner: RepositoryGoldAnchor,
  labels: readonly GoldExpectation[],
  inventory: GoldOwnerInventory,
) {
  const symbol = anchoredSymbol(context, owner);
  assert(symbol, 'Closed gold owner is missing or ambiguous');
  function startsInOwner(relation: CodeRelation): boolean {
    const site = context.evidence.get(relation.siteEvidenceId);
    if (!site || context.files.get(site.fileId)?.path !== owner.file)
      return false;
    const offset = site.range.start.offset;
    return (
      offset >= inventory.body.start &&
      offset < inventory.body.end &&
      !inventory.nestedOwners.some(
        (nested) => offset >= nested.start && offset < nested.end,
      )
    );
  }
  const exacts = context.snapshot.facts.relations.filter(
    (relation) =>
      relation.resolution.status === 'exact' &&
      (relation.sourceSymbolId === symbol.id || startsInOwner(relation)),
  );
  const expected = new Set(
    labels
      .filter((label) => label.status === 'exact')
      .map((label) =>
        JSON.stringify([
          goldSiteKey(label.site.file, label.site),
          label.kind ?? 'calls',
        ]),
      ),
  );
  const unexpected = exacts.filter(
    (relation) =>
      !expected.has(
        JSON.stringify([
          context.occurrenceKey(relation.siteEvidenceId),
          relation.kind,
        ]),
      ),
  );
  return { symbol, unexpected };
}

export function validateClosedGoldOwner(
  context: RepositoryGoldContext,
  owner: RepositoryGoldAnchor,
  labels: readonly GoldExpectation[],
  inventory: GoldOwnerInventory,
  inspection?: ReturnType<typeof inspectClosedGoldOwner>,
): void {
  const closingLabels = labels.filter(
    (item) =>
      item.owner.file === owner.file && equalGoldRange(item.owner, owner),
  );
  const { unexpected, symbol } =
    inspection ??
    inspectClosedGoldOwner(context, owner, closingLabels, inventory);
  assert.equal(
    unexpected.length,
    0,
    'Closed gold owner has missing or fabricated graph occurrences',
  );
  const graph = context.queries.neighbors({
    snapshotId: context.snapshot.facts.snapshotId,
    symbolId: symbol.id,
    direction: 'outgoing',
    relationKinds: ['calls', 'references', 'constructs'],
    depth: 1,
    nodeLimit: 200,
  });
  assert(
    directScopeAvailable(graph.meta),
    'Closed gold projection exceeded the direct-scope budget',
  );
  assert.equal(
    graph.meta.snapshotId,
    context.snapshot.facts.snapshotId,
    'Closed gold projection changed snapshot',
  );
  assert.equal(
    graph.rootSymbolId,
    symbol.id,
    'Closed gold projection changed direction',
  );
  const rawExact = context.snapshot.facts.relations.filter(
    (item) =>
      item.sourceSymbolId === symbol.id && item.resolution.status === 'exact',
  );
  const projectedExact = graph.relations.filter(
    (item) => item.resolution.status === 'exact',
  );
  assert.deepEqual(
    projectedExact.map(({ id }) => id).sort(),
    rawExact.map(({ id }) => id).sort(),
    'Closed gold owner has missing or fabricated graph occurrences',
  );
  if (rawExact[0])
    checkProjection(context, graph, rawExact[0], symbol, 'outgoing');
  const expectedCalls = closingLabels
    .filter(
      (label) =>
        (label.kind ?? 'calls') === 'calls' && label.status !== 'absent',
    )
    .map((label) => goldSiteKey(label.site.file, label.site))
    .sort();
  const actualCalls = graph.relations
    .filter(
      (item) => item.sourceSymbolId === symbol.id && item.kind === 'calls',
    )
    .map((item) => context.occurrenceKey(item.siteEvidenceId))
    .sort();
  assert.deepEqual(
    actualCalls,
    expectedCalls,
    'Closed gold owner has missing or fabricated graph occurrences',
  );
}
