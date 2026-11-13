import { summarizeCoverage } from '@codethread/code-model';
import { createInvestigation } from '@codethread/trace-engine';
import type { RepositoryInvestigationSession } from '../investigation/repository-session.ts';
import type { Database } from './database.ts';
import { hashSourceBytes, storeSourceObjects } from './source-objects.ts';
import {
  assertSnapshotEnvelope,
  verifyNormalizedSnapshot,
} from './snapshot-integrity.ts';

type Sql = Database;
type SourceFile = {
  path: string;
  bytes: Uint8Array;
  sha256: string;
  blobId: string;
  mode: string;
};
type ScanSession = RepositoryInvestigationSession;

async function batchInsert(
  sql: Sql,
  table: string,
  columns: readonly string[],
  rows: Record<string, unknown>[],
) {
  // Table and column names are fixed at source-code call sites, never from user input.
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const parameters = chunk.flatMap((r) => columns.map((c) => r[c]));
    if (chunk.length)
      await sql.unsafe(
        `INSERT INTO codethread.${table} (${columns.join(',')})
      VALUES ${chunk.map((_, j) => '(' + columns.map((__, k) => '$' + (j * columns.length + k + 1)).join(',') + ')').join(',')}`,
        parameters as Parameters<Sql['unsafe']>[1],
      );
  }
}
export async function persistScan(
  sql: Sql,
  jobId: string,
  repositoryId: string,
  acquired: {
    files: readonly SourceFile[];
    commitId: string;
    rootTreeId: string;
    objectFormat: 'sha1' | 'sha256';
  },
  session: ScanSession,
  generation: string,
  attempt: number,
) {
  const projectRows: Record<string, unknown>[] = [];
  await sql.begin(async (tx) => {
    const db = tx as unknown as Sql;
    const job = (
      await db`SELECT state, generation, attempt FROM codethread.scan_job
      WHERE id = ${jobId} AND repository_id = ${repositoryId} FOR UPDATE`
    )[0];
    if (
      !job ||
      job.state !== 'running' ||
      String(job.generation) !== generation ||
      Number(job.attempt) !== attempt
    )
      throw new Error('Stale or cancelled scan cannot publish');
    if (
      session.commitId !== acquired.commitId ||
      session.repositoryId !== repositoryId
    )
      throw new Error('Scan source provenance mismatch');
    await storeSourceObjects(db, acquired.files);
    const inputRows =
      await db`SELECT path,git_blob_oid,git_mode,content_hash,input_kind
      FROM codethread.scan_input_file WHERE scan_job_id=${jobId}
        AND input_kind='source' ORDER BY path COLLATE "C"`;
    const expectedInputs = [...acquired.files].sort((a, b) =>
      Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
    );
    if (inputRows.length !== expectedInputs.length)
      throw new Error(
        'Persisted source manifest does not match the analyzed files',
      );
    for (let index = 0; index < expectedInputs.length; index++) {
      const row = inputRows[index]!,
        file = expectedInputs[index]!;
      if (
        row.path !== file.path ||
        row.git_blob_oid !== file.blobId ||
        row.git_mode !== file.mode ||
        row.content_hash !== file.sha256
      )
        throw new Error(
          'Persisted source manifest does not match the analyzed files',
        );
    }
    for (const project of session.projects) {
      const snapshot = project.snapshot;
      if (snapshot) {
        // The analyzer has already verified facts against immutable source bytes.
        createInvestigation(snapshot.facts, snapshot.source, {
          resourceProfile: 'repository',
        });
        const f = snapshot.facts;
        const serializedFacts = db.json(
          f as unknown as Parameters<Sql['json']>[0],
        );
        const existing = (
          await db`SELECT state,repository_id,source_fingerprint,analyzer_version,
            analyzer_build_hash,configuration_hash,coverage,
            facts_json = ${serializedFacts} AS same
          FROM codethread.repository_snapshot
          WHERE id = ${f.snapshotId} AND repository_id = ${repositoryId} FOR UPDATE`
        )[0];
        if (existing && (existing.state !== 'published' || !existing.same))
          throw new Error('Snapshot identity collision or incomplete staging');
        if (existing) {
          assertSnapshotEnvelope(existing, f);
          await verifyNormalizedSnapshot(db, f.snapshotId, f);
        } else {
          await db`INSERT INTO codethread.repository_snapshot
            (id, repository_id, source_fingerprint, analyzer_version, analyzer_build_hash,
             configuration_hash, coverage, facts_json)
            VALUES (${f.snapshotId}, ${repositoryId}, ${f.identity.sourceFingerprint},
              ${f.identity.analyzerVersion}, ${f.identity.analyzerBuildHash},
              ${f.identity.configurationHash}, ${summarizeCoverage(f.coverageByCapability)}, ${serializedFacts}::jsonb)`;
          const fileRows: Record<string, unknown>[] = [],
            retainedSources: { sha256: string; bytes: Uint8Array }[] = [];
          for (const file of f.files) {
            const bytes = snapshot.source.readFile(file.id);
            if (!bytes || hashSourceBytes(bytes) !== file.contentHash)
              throw new Error('Missing or invalid retained source bytes');
            retainedSources.push({ sha256: file.contentHash, bytes });
            fileRows.push({
              snapshot_id: f.snapshotId,
              id: file.id,
              path: file.path,
              content_hash: file.contentHash,
              byte_length: file.byteLength,
            });
          }
          await storeSourceObjects(db, retainedSources);
          await batchInsert(
            db,
            'snapshot_file',
            ['snapshot_id', 'id', 'path', 'content_hash', 'byte_length'],
            fileRows,
          );
          await batchInsert(
            db,
            'source_evidence',
            [
              'snapshot_id',
              'id',
              'file_id',
              'content_hash',
              'start_utf16',
              'end_utf16',
              'range_json',
              'kind',
              'extractor_name',
              'extractor_version',
            ],
            f.evidenceRefs.map((e) => ({
              snapshot_id: f.snapshotId,
              id: e.id,
              file_id: e.fileId,
              content_hash: e.contentHash,
              start_utf16: e.range.start.offset,
              end_utf16: e.range.end.offset,
              range_json: db.json(e.range),
              kind: e.kind,
              extractor_name: e.extractor.name,
              extractor_version: e.extractor.version,
            })),
          );
          await batchInsert(
            db,
            'code_symbol',
            [
              'snapshot_id',
              'id',
              'file_id',
              'canonical_key',
              'name',
              'kind',
              'declaration_evidence_id',
              'symbol_json',
            ],
            f.symbols.map((s) => ({
              snapshot_id: f.snapshotId,
              id: s.id,
              file_id: s.fileId,
              canonical_key: s.key,
              name: s.name,
              kind: s.kind,
              declaration_evidence_id: s.declarationEvidenceId,
              symbol_json: db.json(s as unknown as Parameters<Sql['json']>[0]),
            })),
          );
          await batchInsert(
            db,
            'diagnostic',
            ['snapshot_id', 'id', 'file_id', 'code', 'severity', 'message'],
            f.diagnostics.map((d) => ({
              snapshot_id: f.snapshotId,
              id: d.id,
              file_id: d.fileId ?? null,
              code: d.code,
              severity: d.severity,
              message: d.message,
            })),
          );
          await batchInsert(
            db,
            'code_relation',
            [
              'snapshot_id',
              'id',
              'canonical_key',
              'source_symbol_id',
              'target_symbol_id',
              'kind',
              'resolution',
              'site_evidence_id',
            ],
            f.relations.map((r) => ({
              snapshot_id: f.snapshotId,
              id: r.id,
              canonical_key: r.key,
              source_symbol_id: r.sourceSymbolId,
              target_symbol_id: r.resolution.targetId,
              kind: r.kind,
              resolution: r.resolution.status,
              site_evidence_id: r.siteEvidenceId,
            })),
          );
          await batchInsert(
            db,
            'relation_evidence',
            ['snapshot_id', 'relation_id', 'evidence_id'],
            f.relations.flatMap((r) =>
              r.resolution.evidenceIds.map((id) => ({
                snapshot_id: f.snapshotId,
                relation_id: r.id,
                evidence_id: id,
              })),
            ),
          );
          await batchInsert(
            db,
            'snapshot_capability',
            ['snapshot_id', 'capability_key', 'coverage'],
            Object.entries(f.coverageByCapability).map(([key, value]) => ({
              snapshot_id: f.snapshotId,
              capability_key: key,
              coverage: value,
            })),
          );
          await verifyNormalizedSnapshot(db, f.snapshotId, f);
          await db`UPDATE codethread.repository_snapshot SET state='published',
            published_at=now() WHERE id=${f.snapshotId} AND state='staging'`;
        }
      }
      projectRows.push({
        repository_id: repositoryId,
        scan_job_id: jobId,
        project_id: project.project.id,
        project_label: project.project.configPath ?? 'Default context',
        project_json: db.json(
          project.project as unknown as Parameters<Sql['json']>[0],
        ),
        status: project.status,
        snapshot_id: snapshot?.facts.snapshotId ?? null,
        diagnostics: db.json(
          (project.error
            ? [project.error]
            : project.project.diagnostics) as unknown as Parameters<
            Sql['json']
          >[0],
        ),
      });
    }
    await batchInsert(
      db,
      'scan_project',
      [
        'repository_id',
        'scan_job_id',
        'project_id',
        'project_label',
        'project_json',
        'status',
        'snapshot_id',
        'diagnostics',
      ],
      projectRows,
    );
    const activated = await db`UPDATE codethread.repository
      SET active_job_id=${jobId}, updated_at=now()
      WHERE id=${repositoryId} AND desired_generation=${generation}::bigint
      RETURNING id`;
    const activate = activated.length > 0;
    const completed = await db`UPDATE codethread.scan_job SET state='succeeded',
      activation_result=${activate ? 'activated' : 'stale'},
      git_object_format=${acquired.objectFormat}, git_commit_oid=${acquired.commitId},
      git_tree_oid=${acquired.rootTreeId},
      session_json=${db.json({
        inventory: session.inventory,
        files: session.files,
        diagnostics: session.diagnostics,
        sourceCoverageComplete: session.sourceCoverageComplete,
        contextComplete: session.contextComplete,
        analysisComplete: session.analysisComplete,
        metrics: session.metrics,
      } as unknown as Parameters<Sql['json']>[0])}, updated_at=now()
      WHERE id=${jobId} AND repository_id=${repositoryId}
        AND generation=${generation}::bigint AND attempt=${attempt} AND state='running'
      RETURNING id`;
    if (!completed.length)
      throw new Error('Fenced scan cannot complete publication');
  });
}
