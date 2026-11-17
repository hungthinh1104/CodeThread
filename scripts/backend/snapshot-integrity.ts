import { summarizeCoverage } from '@codethread/code-model';
import type { AnalysisFacts } from '@codethread/code-model';
import type { Database } from './database.ts';

type Row = Record<string, unknown>;

export function assertSnapshotEnvelope(row: Row, facts: AnalysisFacts): void {
  if (
    facts.identity.repositoryId !== row.repository_id ||
    facts.identity.sourceFingerprint !== row.source_fingerprint ||
    facts.identity.analyzerVersion !== row.analyzer_version ||
    facts.identity.analyzerBuildHash !== row.analyzer_build_hash ||
    facts.identity.configurationHash !== row.configuration_hash ||
    summarizeCoverage(facts.coverageByCapability) !== row.coverage
  )
    throw new Error('Stored snapshot metadata differs from immutable facts');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function assertRows(
  label: string,
  expected: readonly unknown[],
  actual: readonly unknown[],
) {
  const left = expected.map(canonical).sort(),
    right = actual.map(canonical).sort();
  if (
    left.length !== right.length ||
    left.some((value, index) => value !== right[index])
  )
    throw new Error(`Stored snapshot ${label} differ from its immutable facts`);
}

export async function verifyNormalizedSnapshot(
  db: Database,
  snapshotId: string,
  facts: AnalysisFacts,
): Promise<void> {
  const [
    files,
    evidence,
    symbols,
    diagnostics,
    relations,
    relationEvidence,
    capabilities,
  ] = await Promise.all([
    db`SELECT id,path,content_hash,byte_length FROM codethread.snapshot_file
        WHERE snapshot_id=${snapshotId}`,
    db`SELECT id,file_id,content_hash,start_utf16,end_utf16,range_json,kind,
          extractor_name,extractor_version FROM codethread.source_evidence
        WHERE snapshot_id=${snapshotId}`,
    db`SELECT id,file_id,canonical_key,name,kind,declaration_evidence_id,symbol_json
        FROM codethread.code_symbol WHERE snapshot_id=${snapshotId}`,
    db`SELECT id,file_id,code,severity,message FROM codethread.diagnostic
        WHERE snapshot_id=${snapshotId}`,
    db`SELECT id,canonical_key,source_symbol_id,target_symbol_id,kind,resolution,
          site_evidence_id FROM codethread.code_relation WHERE snapshot_id=${snapshotId}`,
    db`SELECT relation_id,evidence_id FROM codethread.relation_evidence
        WHERE snapshot_id=${snapshotId}`,
    db`SELECT capability_key,coverage FROM codethread.snapshot_capability
        WHERE snapshot_id=${snapshotId}`,
  ]);
  const relationEvidenceById = new Map<string, string[]>();
  for (const row of relationEvidence) {
    const key = String(row.relation_id),
      current = relationEvidenceById.get(key) ?? [];
    current.push(String(row.evidence_id));
    relationEvidenceById.set(key, current);
  }
  for (const values of relationEvidenceById.values()) values.sort();

  assertRows(
    'files',
    facts.files.map((file) => ({
      id: file.id,
      path: file.path,
      content_hash: file.contentHash,
      byte_length: file.byteLength,
    })),
    files as Row[],
  );
  assertRows(
    'evidence',
    facts.evidenceRefs.map((item) => ({
      id: item.id,
      file_id: item.fileId,
      content_hash: item.contentHash,
      start_utf16: item.range.start.offset,
      end_utf16: item.range.end.offset,
      range_json: item.range,
      kind: item.kind,
      extractor_name: item.extractor.name,
      extractor_version: item.extractor.version,
    })),
    evidence as Row[],
  );
  assertRows(
    'symbols',
    facts.symbols.map((item) => ({
      id: item.id,
      file_id: item.fileId,
      canonical_key: item.key,
      name: item.name,
      kind: item.kind,
      declaration_evidence_id: item.declarationEvidenceId,
      symbol_json: item,
    })),
    symbols as Row[],
  );
  assertRows(
    'diagnostics',
    facts.diagnostics.map((item) => ({
      id: item.id,
      file_id: item.fileId ?? null,
      code: item.code,
      severity: item.severity,
      message: item.message,
    })),
    diagnostics as Row[],
  );
  assertRows(
    'relations',
    facts.relations.map((item) => ({
      id: item.id,
      canonical_key: item.key,
      source_symbol_id: item.sourceSymbolId,
      target_symbol_id: item.resolution.targetId ?? null,
      kind: item.kind,
      resolution: item.resolution.status,
      site_evidence_id: item.siteEvidenceId,
      evidence_ids: [...item.resolution.evidenceIds].sort(),
    })),
    (relations as Row[]).map((item) => ({
      id: item.id,
      canonical_key: item.canonical_key,
      source_symbol_id: item.source_symbol_id,
      target_symbol_id: item.target_symbol_id,
      kind: item.kind,
      resolution: item.resolution,
      site_evidence_id: item.site_evidence_id,
      evidence_ids: relationEvidenceById.get(String(item.id)) ?? [],
    })),
  );
  assertRows(
    'relation evidence',
    facts.relations.flatMap((item) =>
      item.resolution.evidenceIds.map((evidenceId) => ({
        relation_id: item.id,
        evidence_id: evidenceId,
      })),
    ),
    relationEvidence as Row[],
  );
  assertRows(
    'capabilities',
    Object.entries(facts.coverageByCapability).map(([key, coverage]) => ({
      capability_key: key,
      coverage,
    })),
    capabilities as Row[],
  );
}
