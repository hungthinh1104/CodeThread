import { createHash } from 'node:crypto';
import {
  analysisResourceLimits,
  withinAnalysisCollectionLimits,
  coverageByCapabilitySchema,
  idSchema,
  snapshotIdentitySchema,
} from '@codethread/code-model';
import type {
  AnalysisFacts,
  AnalysisResourceLimits,
  VerifiedSourceReader,
} from '@codethread/code-model';
import { ensure, sameRange, TraceError, unique } from './fact-integrity.js';
import { validateSources } from './source-validation.js';
import type { RetainedSource } from './source-validation.js';
import { validateGraph } from './graph-validation.js';

export function validateFacts(
  facts: AnalysisFacts,
  reader: VerifiedSourceReader,
  limits = analysisResourceLimits(),
): Map<string, RetainedSource> {
  try {
    return validate(facts, reader, limits);
  } catch (error) {
    if (error instanceof TraceError) throw error;
    throw new TraceError('INVALID_FACTS', 'Invalid semantic facts');
  }
}
function validate(
  facts: AnalysisFacts,
  reader: VerifiedSourceReader,
  limits: AnalysisResourceLimits,
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
  ensure(withinAnalysisCollectionLimits(facts, limits));
  unique(facts.files);
  unique(facts.symbols);
  unique(facts.relations);
  unique(facts.evidenceRefs);
  unique(facts.diagnostics);
  const sources = validateSources(facts, reader, limits);
  validateGraph(facts, sources);
  validateObservations(facts);
  return sources;
}

function validateObservations(facts: AnalysisFacts): void {
  const evidence = new Map(facts.evidenceRefs.map((item) => [item.id, item]));
  const diagnostics = new Map(facts.diagnostics.map((item) => [item.id, item]));
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
}
