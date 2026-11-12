import assert from 'node:assert/strict';
import { createInvestigation } from '@codethread/trace-engine';
import type { CodeSymbol, SourceRange } from '@codethread/code-model';
import type { AnalysisSnapshot } from '@codethread/symbol-indexer';
import type {
  RepositoryGoldAnchor,
  RepositoryGoldLabel,
} from './repository-gold.ts';
import type { RepositoryCorpus } from './repository-corpus.ts';

export function equalGoldRange(left: SourceRange, right: SourceRange): boolean {
  return (['start', 'end'] as const).every((edge) =>
    (['offset', 'line', 'column'] as const).every(
      (key) => left[edge][key] === right[edge][key],
    ),
  );
}
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
export function repositoryGoldContext(snapshot: AnalysisSnapshot) {
  return {
    snapshot,
    queries: createInvestigation(snapshot.facts, snapshot.source, {
      resourceProfile: 'repository',
    }),
    evidence: new Map(
      snapshot.facts.evidenceRefs.map((item) => [item.id, item]),
    ),
    relations: new Map(snapshot.facts.relations.map((item) => [item.id, item])),
    files: new Map(snapshot.facts.files.map((item) => [item.id, item])),
  };
}
export type RepositoryGoldContext = ReturnType<typeof repositoryGoldContext>;

function checkEvidence(
  context: RepositoryGoldContext,
  id: string,
  expected: RepositoryGoldAnchor,
  corpus: RepositoryCorpus,
): void {
  const result = context.queries.sourceEvidence({
    snapshotId: context.snapshot.facts.snapshotId,
    evidenceIds: [id],
  });
  const item = result.items[0];
  assert(item?.status === 'available', 'Gold source evidence is unavailable');
  const pinned = corpus.files.find((file) => file.path === expected.file);
  assert(
    pinned && pinned.sha256 === expected.sourceSha256,
    'Gold source hash differs from pinned bytes',
  );
  assert.equal(item.filePath, expected.file, 'Gold evidence path mismatch');
  assert(
    equalGoldRange(item.evidence.range, expected),
    'Gold evidence range mismatch',
  );
  const text = new TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: true,
  }).decode(pinned.bytes);
  assert.equal(
    item.text,
    text.slice(expected.start.offset, expected.end.offset),
    'Gold evidence is not the original source excerpt',
  );
}

/** Expected declaration anchors are source-authored; analyzer IDs are lookup values only. */
export function validateRepositoryGoldLabel(
  context: RepositoryGoldContext,
  expected: RepositoryGoldLabel,
  corpus: RepositoryCorpus,
) {
  const snapshot = context.snapshot;
  const owners = snapshot.facts.symbols.filter((symbol) =>
    symbolMatchesGold(snapshot, symbol, expected.owner),
  );
  assert.equal(
    owners.length,
    1,
    'Gold owner declaration is missing or ambiguous',
  );
  const owner = owners[0]!;
  const observations = snapshot.facts.observations.filter((observation) => {
    const evidence = context.evidence.get(observation.evidenceId),
      file = evidence && context.files.get(evidence.fileId);
    return (
      evidence &&
      file?.path === expected.site.file &&
      file.contentHash === expected.site.sourceSha256 &&
      equalGoldRange(evidence.range, expected.site)
    );
  });
  assert.equal(
    observations.length,
    1,
    'Gold call occurrence is missing, duplicated or moved',
  );
  const observation = observations[0]!;
  assert.equal(observation.ownerId, owner.id, 'Gold lexical owner mismatch');
  assert.equal(
    observation.status,
    expected.status,
    'Gold call resolution status mismatch',
  );
  const relation =
    observation.relationId && context.relations.get(observation.relationId);
  assert(
    relation &&
      relation.kind === 'calls' &&
      relation.sourceSymbolId === owner.id,
    'Gold call relation is missing or has the wrong kind',
  );
  checkEvidence(context, observation.evidenceId, expected.site, corpus);
  checkEvidence(context, owner.declarationEvidenceId, expected.owner, corpus);
  const outgoing = context.queries.neighbors({
    snapshotId: snapshot.facts.snapshotId,
    symbolId: owner.id,
    direction: 'outgoing',
    relationKinds: ['calls'],
    depth: 1,
    nodeLimit: 200,
  });
  const row = outgoing.relations.find((item) => item.id === relation.id);
  assert.equal(outgoing.rootSymbolId, owner.id, 'Gold outgoing root mismatch');
  assert(row, 'Gold edge is absent from the outgoing projection');
  if (expected.target) {
    assert(
      relation.resolution.status === 'exact' &&
        row.resolution.status === 'exact',
      'Gold exact edge became uncertain',
    );
    const target = snapshot.facts.symbols.find(
      (symbol) => symbol.id === relation.resolution.targetId,
    );
    assert(
      target && symbolMatchesGold(snapshot, target, expected.target),
      'Gold exact target declaration mismatch',
    );
    assert.equal(
      row.resolution.targetId,
      target.id,
      'Outgoing graph selected a different exact target',
    );
    checkEvidence(
      context,
      target.declarationEvidenceId,
      expected.target,
      corpus,
    );
    const incoming = context.queries.neighbors({
      snapshotId: snapshot.facts.snapshotId,
      symbolId: target.id,
      direction: 'incoming',
      relationKinds: ['calls'],
      depth: 1,
      nodeLimit: 200,
    });
    assert(
      incoming.relations.some(
        (item) =>
          item.id === relation.id &&
          item.sourceSymbolId === owner.id &&
          item.resolution.status === 'exact' &&
          item.resolution.targetId === target.id,
      ),
      'Gold incoming direction or occurrence mismatch',
    );
    assert.equal(
      incoming.rootSymbolId,
      target.id,
      'Gold incoming root mismatch',
    );
    const paths = context.queries.paths({
      snapshotId: snapshot.facts.snapshotId,
      fromSymbolId: owner.id,
      toSymbolId: target.id,
      relationKinds: ['calls'],
      depth: 1,
      nodeLimit: 200,
      pathLimit: 20,
    });
    assert(
      paths.paths.some(
        (path) =>
          path.relationIds.length === 1 && path.relationIds[0] === relation.id,
      ),
      'Gold direct path is absent',
    );
  } else
    assert(
      row.resolution.status !== 'exact',
      'Fabricated exact graph edge from an uncertain occurrence',
    );
  return { ownerId: owner.id, relationId: relation.id };
}

export function validateClosedGoldOwner(
  context: RepositoryGoldContext,
  owner: RepositoryGoldAnchor,
  labels: readonly RepositoryGoldLabel[],
): void {
  const symbol = context.snapshot.facts.symbols.find((symbol) =>
    symbolMatchesGold(context.snapshot, symbol, owner),
  );
  assert(symbol, 'Closed gold owner is missing');
  const result = context.queries.neighbors({
    snapshotId: context.snapshot.facts.snapshotId,
    symbolId: symbol.id,
    direction: 'outgoing',
    relationKinds: ['calls'],
    depth: 1,
    nodeLimit: 200,
  });
  const actual = result.relations
    .filter((relation) => relation.sourceSymbolId === symbol.id)
    .map((relation) => {
      const site = result.evidenceRefs.find(
        (evidence) => evidence.id === relation.siteEvidenceId,
      );
      assert(site, 'Closed gold graph lacks site evidence');
      return `${site.range.start.offset}:${site.range.end.offset}`;
    })
    .sort();
  const expected = labels
    .filter(
      (label) =>
        equalGoldRange(label.owner, owner) && label.owner.file === owner.file,
    )
    .map((label) => `${label.site.start.offset}:${label.site.end.offset}`)
    .sort();
  assert(
    expected.length > 0,
    'Closed gold owner has no independent expectations',
  );
  assert.deepEqual(
    actual,
    expected,
    'Closed gold owner has missing or fabricated graph occurrences',
  );
}
