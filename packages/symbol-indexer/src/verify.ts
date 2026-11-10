import {
  analysisResourceLimits,
  withinAnalysisCollectionLimits,
  codeRelationSchema,
  coverageByCapabilitySchema,
  diagnosticSchema,
  idSchema,
  snapshotIdentitySchema,
  sourceEvidenceSchema,
  sourceRangeSchema,
  symbolSchema,
} from '@codethread/code-model';
import type {
  AnalysisFacts,
  SourcePositionIndex,
} from '@codethread/code-model';
import { hash, identity } from './identity.js';
import type { WorkerInput } from './protocol.js';

type Source = {
  bytes: Uint8Array;
  text: string;
  positions: SourcePositionIndex;
};
function requireFact(value: unknown): asserts value {
  if (!value) throw new Error('Invalid analysis fact');
}
function sameRange(
  a: {
    start: { offset: number; line: number; column: number };
    end: { offset: number; line: number; column: number };
  },
  b: typeof a,
): boolean {
  return (['start', 'end'] as const).every((edge) =>
    (['offset', 'line', 'column'] as const).every(
      (key) => a[edge][key] === b[edge][key],
    ),
  );
}
function unique(values: readonly { id: string; key?: string }[]): void {
  const ids = new Set<string>(),
    keys = new Set<string>();
  for (const item of values) {
    requireFact(item.id === idSchema.parse(item.id));
    requireFact(!ids.has(item.id));
    ids.add(item.id);
    if (item.key !== undefined) {
      requireFact(!keys.has(item.key));
      keys.add(item.key);
    }
  }
}

/** Independent content and reference checks before exposing worker-produced facts. */
export function verifyFacts(
  facts: AnalysisFacts,
  request: WorkerInput,
  sources: ReadonlyMap<string, Source>,
): void {
  requireFact(facts && typeof facts === 'object');
  const snapshot = idSchema.parse(facts.snapshotId);
  requireFact(snapshot === facts.snapshotId);
  const analysis = snapshotIdentitySchema.parse(facts.identity);
  requireFact(
    analysis.repositoryId === request.repositoryId &&
      analysis.sourceFingerprint === request.sourceFingerprint &&
      analysis.configurationHash === request.configurationHash,
  );
  requireFact(identity('snapshot', analysis) === snapshot);
  const limits = analysisResourceLimits(request.resourceProfile);
  requireFact(withinAnalysisCollectionLimits(facts, limits));
  requireFact(
    Array.isArray(facts.files) &&
      (request.project === undefined
        ? facts.files.length === request.files.length
        : request.project.rootPaths.every((path) =>
            facts.files.some((file) => file.path === path),
          )),
  );
  coverageByCapabilitySchema.parse(facts.coverageByCapability);
  unique(facts.files);
  const requested = new Map(request.files.map((file) => [file.path, file]));
  const files = new Map(facts.files.map((file) => [file.id, file]));
  for (const file of facts.files) {
    const expected = requested.get(file.path),
      retained = sources.get(file.path);
    requireFact(
      expected &&
        retained &&
        file.snapshotId === snapshot &&
        file.id === identity('file', [snapshot, file.path]),
    );
    requireFact(
      file.contentHash === expected.sha256 &&
        file.byteLength === expected.byteLength &&
        retained.bytes.length === file.byteLength &&
        hash(retained.bytes) === file.contentHash,
    );
  }
  unique(facts.evidenceRefs);
  const evidence = new Map(facts.evidenceRefs.map((item) => [item.id, item]));
  for (const item of facts.evidenceRefs) {
    sourceEvidenceSchema.parse(item);
    const file = files.get(item.fileId),
      retained = file && sources.get(file.path);
    requireFact(
      file &&
        retained &&
        item.snapshotId === snapshot &&
        item.contentHash === file.contentHash &&
        item.extractor.name === 'ct-index-001b' &&
        item.extractor.version === '0.1.0',
    );
    requireFact(
      item.id ===
        identity('evidence', [
          snapshot,
          file.id,
          item.range.start.offset,
          item.range.end.offset,
        ]),
    );
    requireFact(retained.positions.validateRange(item.range));
  }
  unique(facts.symbols);
  const symbols = new Map(facts.symbols.map((item) => [item.id, item]));
  for (const symbol of facts.symbols) {
    symbolSchema.parse(symbol);
    const file = files.get(symbol.fileId),
      primary = evidence.get(symbol.declarationEvidenceId);
    requireFact(
      file &&
        primary &&
        symbol.snapshotId === snapshot &&
        (symbol.kind === 'function' || symbol.kind === 'method') &&
        symbol.filePath === file.path &&
        primary.fileId === file.id &&
        sameRange(symbol.range, primary.range),
    );
    requireFact(symbol.evidenceIds.every((id: string) => evidence.has(id)));
    const key =
      'symbol:v1:' +
      hash(
        JSON.stringify([
          file.path,
          symbol.range.start.offset,
          symbol.range.end.offset,
          symbol.kind,
        ]),
      );
    requireFact(
      symbol.key === key && symbol.id === identity('symbol', [snapshot, key]),
    );
  }
  unique(facts.diagnostics);
  const diagnostics = new Map(facts.diagnostics.map((item) => [item.id, item]));
  for (const diagnostic of facts.diagnostics) {
    diagnosticSchema.parse(diagnostic);
    requireFact(diagnostic.snapshotId === snapshot);
    if (diagnostic.fileId) {
      const file = files.get(diagnostic.fileId),
        retained = file && sources.get(file.path);
      requireFact(file && retained && diagnostic.filePath === file.path);
      if (diagnostic.range)
        requireFact(retained.positions.validateRange(diagnostic.range));
    }
  }
  unique(facts.relations);
  const relations = new Map(facts.relations.map((item) => [item.id, item]));
  for (const relation of facts.relations) {
    codeRelationSchema.parse(relation);
    const owner = symbols.get(relation.sourceSymbolId),
      site = evidence.get(relation.siteEvidenceId);
    requireFact(
      owner &&
        site &&
        relation.snapshotId === snapshot &&
        (relation.kind === 'calls' || relation.kind === 'references') &&
        site.fileId === owner.fileId &&
        (relation.kind === 'references' ||
          owner.kind === 'function' ||
          owner.kind === 'method'),
    );
    requireFact(
      sourceRangeSchema.safeParse({
        start: owner.range.start,
        end: site.range.start,
      }).success &&
        sourceRangeSchema.safeParse({
          start: site.range.end,
          end: owner.range.end,
        }).success,
    );
    requireFact(
      relation.resolution.evidenceIds.every((id: string) => evidence.has(id)) &&
        relation.resolution.evidenceIds.includes(owner.declarationEvidenceId),
    );
    if (relation.resolution.status === 'exact') {
      const target = symbols.get(relation.resolution.targetId);
      requireFact(
        target &&
          (relation.kind === 'calls'
            ? target.kind === 'function'
            : target.kind === 'method') &&
          relation.resolution.evidenceIds.includes(
            target.declarationEvidenceId,
          ),
      );
    }
    const key =
      'relation:v1:' +
      hash(
        JSON.stringify([
          owner.key,
          owner.filePath,
          site.range.start.offset,
          site.range.end.offset,
          relation.kind,
        ]),
      );
    requireFact(
      relation.key === key &&
        relation.id === identity('relation', [snapshot, key]),
    );
    if (relation.resolution.status !== 'exact')
      requireFact(
        relation.resolution.diagnosticIds.every((id: string) =>
          diagnostics.has(id),
        ),
      );
  }
  const seenSites = new Set<string>(),
    seenRelations = new Set<string>();
  for (const observation of facts.observations) {
    const site = evidence.get(observation.evidenceId);
    requireFact(
      site && site.fileId === observation.fileId && !seenSites.has(site.id),
    );
    seenSites.add(site.id);
    requireFact(
      typeof observation.eligible === 'boolean' &&
        observation.eligible === (observation.status !== 'unsupported'),
    );
    if (observation.ownerId) {
      const relation =
        observation.relationId && relations.get(observation.relationId);
      requireFact(
        relation &&
          !seenRelations.has(relation.id) &&
          relation.sourceSymbolId === observation.ownerId &&
          relation.siteEvidenceId === site.id &&
          relation.resolution.status === observation.status,
      );
      seenRelations.add(relation.id);
    } else
      requireFact(
        observation.relationId === null && observation.status === 'unsupported',
      );
    if (observation.status === 'exact')
      requireFact(observation.diagnosticId === null);
    else {
      const diagnostic =
        observation.diagnosticId && diagnostics.get(observation.diagnosticId);
      requireFact(
        diagnostic &&
          diagnostic.fileId === site.fileId &&
          diagnostic.range &&
          sameRange(diagnostic.range, site.range),
      );
      if (observation.relationId) {
        const relation = relations.get(observation.relationId);
        requireFact(
          relation &&
            relation.resolution.status !== 'exact' &&
            relation.resolution.diagnosticIds.includes(diagnostic.id),
        );
      }
    }
  }
  requireFact(
    seenRelations.size ===
      facts.relations.filter((relation) => relation.kind === 'calls').length,
  );
  requireFact(
    facts.counts.files === facts.files.length &&
      facts.counts.declarations === facts.symbols.length &&
      facts.counts.callSites === facts.observations.length &&
      facts.counts.notAnalyzedInputs === 0,
  );
  for (const status of [
    'exact',
    'unresolved',
    'ambiguous',
    'unsupported',
  ] as const)
    requireFact(
      facts.counts[status] ===
        facts.observations.filter(
          (observation) => observation.status === status,
        ).length,
    );
}
