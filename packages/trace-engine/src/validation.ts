import { createHash } from 'node:crypto';
import {
  codeRelationSchema,
  coverageByCapabilitySchema,
  createSourcePositionIndex,
  diagnosticSchema,
  hashSchema,
  idSchema,
  isSnapshotPath,
  sourceEvidenceSchema,
  sourceRangeSchema,
  snapshotIdentitySchema,
  symbolSchema,
} from '@codethread/code-model';
import type {
  AnalysisFacts,
  SourcePositionIndex,
  SourceRange,
  VerifiedSourceReader,
} from '@codethread/code-model';

export class TraceError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_FACTS'
      | 'SOURCE_UNAVAILABLE'
      | 'HASH_MISMATCH'
      | 'SNAPSHOT_NOT_FOUND'
      | 'ENTITY_NOT_FOUND'
      | 'RESOURCE_LIMIT',
    message: string,
  ) {
    super(message);
    this.name = 'TraceError';
  }
}
export interface RetainedSource {
  bytes: Uint8Array;
  text: string;
  positions: SourcePositionIndex;
}
function ensure(value: unknown): asserts value {
  if (!value) throw new TraceError('INVALID_FACTS', 'Invalid semantic facts');
}
function unique(items: readonly { id: string; key?: string }[]): void {
  const ids = new Set<string>(),
    keys = new Set<string>();
  for (const item of items) {
    const id = idSchema.parse(item.id);
    ensure(id === item.id && !ids.has(id));
    ids.add(id);
    if (item.key !== undefined) {
      ensure(!keys.has(item.key));
      keys.add(item.key);
    }
  }
}
export function sameRange(a: SourceRange, b: SourceRange): boolean {
  return (['start', 'end'] as const).every((edge) =>
    (['offset', 'line', 'column'] as const).every(
      (coordinate) => a[edge][coordinate] === b[edge][coordinate],
    ),
  );
}
export function validateFacts(
  facts: AnalysisFacts,
  reader: VerifiedSourceReader,
): Map<string, RetainedSource> {
  try {
    return validate(facts, reader);
  } catch (error) {
    if (error instanceof TraceError) throw error;
    throw new TraceError('INVALID_FACTS', 'Invalid semantic facts');
  }
}
function validate(
  facts: AnalysisFacts,
  reader: VerifiedSourceReader,
): Map<string, RetainedSource> {
  ensure(
    facts &&
      typeof facts === 'object' &&
      reader &&
      typeof reader.readFile === 'function' &&
      typeof reader.readEvidence === 'function',
  );
  const snapshot = idSchema.parse(facts.snapshotId);
  ensure(snapshot === facts.snapshotId);
  const analysis = snapshotIdentitySchema.parse(facts.identity);
  const identityBytes = createHash('sha256')
    .update(JSON.stringify(['snapshot', analysis]))
    .digest()
    .subarray(0, 16);
  identityBytes[6] = (identityBytes[6]! & 15) | 128;
  identityBytes[8] = (identityBytes[8]! & 63) | 128;
  const hex = identityBytes.toString('hex');
  ensure(
    snapshot ===
      `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
  coverageByCapabilitySchema.parse(facts.coverageByCapability);
  ensure(
    Array.isArray(facts.files) &&
      facts.files.length <= 20 &&
      Array.isArray(facts.symbols) &&
      facts.symbols.length <= 2000 &&
      Array.isArray(facts.relations) &&
      facts.relations.length <= 10000 &&
      Array.isArray(facts.evidenceRefs) &&
      facts.evidenceRefs.length <= 17000 &&
      Array.isArray(facts.diagnostics) &&
      facts.diagnostics.length <= 25000 &&
      Array.isArray(facts.observations) &&
      facts.observations.length <= 5000,
  );
  unique(facts.files);
  unique(facts.symbols);
  unique(facts.relations);
  unique(facts.evidenceRefs);
  unique(facts.diagnostics);
  const files = new Map(facts.files.map((file) => [file.id, file]));
  const sources = new Map<string, RetainedSource>();
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const file of facts.files) {
    ensure(
      file.snapshotId === snapshot &&
        isSnapshotPath(file.path) &&
        new TextDecoder().decode(new TextEncoder().encode(file.path)) ===
          file.path &&
        !paths.has(file.path.toLowerCase()),
    );
    paths.add(file.path.toLowerCase());
    hashSchema.parse(file.contentHash);
    let input: Uint8Array | null;
    try {
      input = reader.readFile(file.id);
    } catch {
      throw new TraceError(
        'SOURCE_UNAVAILABLE',
        'Retained source is unavailable',
      );
    }
    if (!(input instanceof Uint8Array))
      throw new TraceError(
        'SOURCE_UNAVAILABLE',
        'Retained source is unavailable',
      );
    const bytes = Uint8Array.from(input);
    totalBytes += bytes.length;
    ensure(
      bytes.length === file.byteLength &&
        bytes.length <= 262144 &&
        totalBytes <= 2097152,
    );
    if (createHash('sha256').update(bytes).digest('hex') !== file.contentHash)
      throw new TraceError(
        'HASH_MISMATCH',
        'Retained source does not match its identity',
      );
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        bytes,
      );
    } catch {
      throw new TraceError(
        'SOURCE_UNAVAILABLE',
        'Retained source has invalid encoding',
      );
    }
    sources.set(file.id, {
      bytes,
      text,
      positions: createSourcePositionIndex(text),
    });
  }
  const evidence = new Map(facts.evidenceRefs.map((item) => [item.id, item]));
  for (const item of facts.evidenceRefs) {
    sourceEvidenceSchema.parse(item);
    const file = files.get(item.fileId),
      source = sources.get(item.fileId);
    ensure(
      file &&
        source &&
        item.snapshotId === snapshot &&
        item.contentHash === file.contentHash &&
        source.positions.validateRange(item.range),
    );
  }
  const symbols = new Map(facts.symbols.map((item) => [item.id, item]));
  for (const symbol of facts.symbols) {
    symbolSchema.parse(symbol);
    const file = files.get(symbol.fileId),
      primary = evidence.get(symbol.declarationEvidenceId);
    ensure(
      file &&
        primary &&
        symbol.snapshotId === snapshot &&
        symbol.filePath === file.path &&
        primary.fileId === file.id &&
        sameRange(symbol.range, primary.range),
    );
    ensure(symbol.evidenceIds.every((id: string) => evidence.has(id)));
  }
  const diagnostics = new Map(facts.diagnostics.map((item) => [item.id, item]));
  for (const diagnostic of facts.diagnostics) {
    diagnosticSchema.parse(diagnostic);
    ensure(diagnostic.snapshotId === snapshot);
    if (diagnostic.fileId) {
      const file = files.get(diagnostic.fileId),
        source = sources.get(diagnostic.fileId);
      ensure(
        file &&
          source &&
          diagnostic.filePath === file.path &&
          (!diagnostic.range ||
            source.positions.validateRange(diagnostic.range)),
      );
    }
  }
  for (const relation of facts.relations) {
    codeRelationSchema.parse(relation);
    const owner = symbols.get(relation.sourceSymbolId),
      site = evidence.get(relation.siteEvidenceId);
    ensure(
      owner &&
        site &&
        relation.snapshotId === snapshot &&
        site.fileId === owner.fileId &&
        (relation.kind !== 'calls' || owner.kind === 'function'),
    );
    ensure(
      sourceRangeSchema.safeParse({
        start: owner.range.start,
        end: site.range.start,
      }).success &&
        sourceRangeSchema.safeParse({
          start: site.range.end,
          end: owner.range.end,
        }).success,
    );
    ensure(
      relation.resolution.evidenceIds.every((id: string) => evidence.has(id)) &&
        relation.resolution.evidenceIds.includes(owner.declarationEvidenceId),
    );
    if (relation.resolution.status === 'exact') {
      const target = symbols.get(relation.resolution.targetId);
      ensure(
        target &&
          (relation.kind !== 'references' || target.kind === 'method') &&
          relation.resolution.evidenceIds.includes(
            target.declarationEvidenceId,
          ),
      );
    } else
      ensure(
        relation.resolution.diagnosticIds.every((id: string) =>
          diagnostics.has(id),
        ),
      );
  }
  const relationMap = new Map(facts.relations.map((item) => [item.id, item]));
  const seenSites = new Set<string>(),
    seenRelations = new Set<string>();
  for (const observation of facts.observations) {
    const site = evidence.get(observation.evidenceId);
    ensure(
      site && site.fileId === observation.fileId && !seenSites.has(site.id),
    );
    seenSites.add(site.id);
    ensure(
      typeof observation.eligible === 'boolean' &&
        observation.eligible === (observation.status !== 'unsupported'),
    );
    if (observation.ownerId) {
      const relation =
        observation.relationId && relationMap.get(observation.relationId);
      ensure(
        relation &&
          relation.kind === 'calls' &&
          !seenRelations.has(relation.id) &&
          relation.sourceSymbolId === observation.ownerId &&
          relation.siteEvidenceId === site.id &&
          relation.resolution.status === observation.status,
      );
      seenRelations.add(relation.id);
    } else
      ensure(
        observation.relationId === null && observation.status === 'unsupported',
      );
    if (observation.status === 'exact')
      ensure(observation.diagnosticId === null);
    else {
      const diagnostic =
        observation.diagnosticId && diagnostics.get(observation.diagnosticId);
      ensure(
        diagnostic &&
          diagnostic.fileId === site.fileId &&
          diagnostic.range &&
          sameRange(diagnostic.range, site.range),
      );
    }
  }
  ensure(
    seenRelations.size ===
      facts.relations.filter((relation) => relation.kind === 'calls').length &&
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
    ensure(
      facts.counts[status] ===
        facts.observations.filter((item) => item.status === status).length,
    );
  return sources;
}
