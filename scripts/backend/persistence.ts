import { createHash } from 'node:crypto';
import type { AnalysisFacts, VerifiedSourceReader } from '@codethread/code-model';
import { createSourcePositionIndex, summarizeCoverage } from '@codethread/code-model';
import { createInvestigation } from '@codethread/trace-engine';
import type { Database } from './database.ts';

type Sql = Database;
type Snapshot = { facts: AnalysisFacts; source: VerifiedSourceReader };
type SourceFile = { path: string; bytes: Uint8Array; sha256: string; blobId: string; mode: string };
type Project = { project: { id: string; configPath?: string; status: string; diagnostics: readonly { code: string; message: string }[] }; status: string; snapshot?: Snapshot; error?: { code: string; message: string } };
type ScanSession = { repositoryId: string; commitId: string; rootTreeId?: string; objectFormat: 'sha1'|'sha256'; projects: readonly Project[] };

async function batchInsert(sql: Sql, table: string, columns: readonly string[], rows: Record<string, unknown>[]) {
  // Table and column names are fixed at source-code call sites, never from user input.
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    if (chunk.length) await sql.unsafe(`INSERT INTO codethread.${table} (${columns.join(',')})
      VALUES ${chunk.map((_, j) => '(' + columns.map((__, k) => '$' + (j * columns.length + k + 1)).join(',') + ')').join(',')}`,
      chunk.flatMap(r => columns.map(c => r[c])));
  }
}
function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
export async function persistScan(sql: Sql, jobId: string, repositoryId: string,
  acquired: { files: readonly SourceFile[]; commitId: string; rootTreeId: string; objectFormat: 'sha1'|'sha256' },
  session: ScanSession, generation: number) {
  const projectRows: Record<string, unknown>[] = [];
  await sql.begin(async tx => {
    const db = tx as unknown as Sql;
    const job = (await db`SELECT state, generation FROM codethread.scan_job
      WHERE id = ${jobId} AND repository_id = ${repositoryId} FOR UPDATE`)[0];
    if (!job || job.state !== 'running' || Number(job.generation) !== generation)
      throw new Error('Stale or cancelled scan cannot publish');
    if (session.commitId !== acquired.commitId || session.repositoryId !== repositoryId)
      throw new Error('Scan source provenance mismatch');
    for (const file of acquired.files) {
      if (sha(file.bytes) !== file.sha256) throw new Error('Source hash mismatch before storage');
      await db`INSERT INTO codethread.source_object (sha256, bytes, byte_length)
        VALUES (${file.sha256}, ${Buffer.from(file.bytes)}, ${file.bytes.byteLength})
        ON CONFLICT (sha256) DO NOTHING`;
    }
    await batchInsert(db, 'scan_input_file',
      ['scan_job_id','path','git_blob_oid','git_mode','content_hash'],
      acquired.files.map(f => ({ scan_job_id: jobId, path: f.path, git_blob_oid: f.blobId,
        git_mode: f.mode, content_hash: f.sha256 })));
    for (const project of session.projects) {
      const snapshot = project.snapshot;
      if (snapshot) {
        // The analyzer has already verified facts against immutable source bytes.
        createInvestigation(snapshot.facts, snapshot.source, { resourceProfile: 'repository' });
        const f = snapshot.facts;
        const existing = (await db`SELECT state, facts_json = ${db.json(f)}::jsonb AS same
          FROM codethread.repository_snapshot
          WHERE id = ${f.snapshotId} AND repository_id = ${repositoryId} FOR UPDATE`)[0];
        if (existing && (existing.state !== 'published' || !existing.same))
          throw new Error('Snapshot identity collision or incomplete staging');
        if (!existing) {
          await db`INSERT INTO codethread.repository_snapshot
            (id, repository_id, source_fingerprint, analyzer_version, analyzer_build_hash,
             configuration_hash, coverage, facts_json)
            VALUES (${f.snapshotId}, ${repositoryId}, ${f.identity.sourceFingerprint},
              ${f.identity.analyzerVersion}, ${f.identity.analyzerBuildHash},
              ${f.identity.configurationHash}, ${summarizeCoverage(f.coverageByCapability)}, ${db.json(f)})`;
          const fileRows: Record<string, unknown>[] = [];
          for (const file of f.files) {
            const bytes = snapshot.source.readFile(file.id);
            if (!bytes || sha(bytes) !== file.contentHash)
              throw new Error('Missing or invalid retained source bytes');
            await db`INSERT INTO codethread.source_object (sha256, bytes, byte_length)
              VALUES (${file.contentHash}, ${Buffer.from(bytes)}, ${bytes.byteLength})
              ON CONFLICT (sha256) DO NOTHING`;
            fileRows.push({ snapshot_id:f.snapshotId, id:file.id, path:file.path,
              content_hash:file.contentHash, byte_length:file.byteLength });
          }
          await batchInsert(db,'snapshot_file',
            ['snapshot_id','id','path','content_hash','byte_length'],fileRows);
          await batchInsert(db,'source_evidence',
            ['snapshot_id','id','file_id','content_hash','start_utf16','end_utf16','range_json','kind','extractor_name','extractor_version'],
            f.evidenceRefs.map(e => ({snapshot_id:f.snapshotId,id:e.id,file_id:e.fileId,
              content_hash:e.contentHash,start_utf16:e.range.start.offset,end_utf16:e.range.end.offset,
              range_json:db.json(e.range),kind:e.kind,extractor_name:e.extractor.name,
              extractor_version:e.extractor.version})));
          await batchInsert(db,'code_symbol',
            ['snapshot_id','id','file_id','canonical_key','name','kind','declaration_evidence_id'],
            f.symbols.map(s => ({snapshot_id:f.snapshotId,id:s.id,file_id:s.fileId,
              canonical_key:s.key,name:s.name,kind:s.kind,declaration_evidence_id:s.declarationEvidenceId})));
          await batchInsert(db,'diagnostic',
            ['snapshot_id','id','file_id','code','severity','message'],
            f.diagnostics.map(d => ({snapshot_id:f.snapshotId,id:d.id,file_id:d.fileId ?? null,
              code:d.code,severity:d.severity,message:d.message})));
          await batchInsert(db,'code_relation',
            ['snapshot_id','id','canonical_key','source_symbol_id','target_symbol_id','kind','resolution','site_evidence_id'],
            f.relations.map(r => ({snapshot_id:f.snapshotId,id:r.id,canonical_key:r.key,
              source_symbol_id:r.sourceSymbolId,target_symbol_id:r.resolution.targetId,
              kind:r.kind,resolution:r.resolution.status,site_evidence_id:r.siteEvidenceId})));
          await batchInsert(db,'relation_evidence',
            ['snapshot_id','relation_id','evidence_id'],
            f.relations.flatMap(r => r.resolution.evidenceIds.map(id => ({
              snapshot_id:f.snapshotId,relation_id:r.id,evidence_id:id }))));
          await batchInsert(db,'snapshot_capability',['snapshot_id','capability_key','coverage'],
            Object.entries(f.coverageByCapability).map(([key,value]) => ({
              snapshot_id:f.snapshotId,capability_key:key,coverage:value})));
          await db`UPDATE codethread.repository_snapshot SET state='published',
            published_at=now() WHERE id=${f.snapshotId} AND state='staging'`;
        }
      }
      projectRows.push({repository_id:repositoryId,scan_job_id:jobId,
        project_id:project.project.id,project_label:project.project.configPath ?? 'Default context',
        status:project.status,snapshot_id:snapshot?.facts.snapshotId ?? null,
        diagnostics:db.json(project.error ? [project.error] : project.project.diagnostics)});
    }
    await batchInsert(db,'scan_project',
      ['repository_id','scan_job_id','project_id','project_label','status','snapshot_id','diagnostics'],projectRows);
    const repo = (await db`SELECT desired_generation FROM codethread.repository
      WHERE id = ${repositoryId} FOR UPDATE`)[0];
    const activate = Number(repo?.desired_generation) === generation;
    if (activate) await db`UPDATE codethread.repository SET active_job_id=${jobId},
      updated_at=now() WHERE id=${repositoryId}`;
    await db`UPDATE codethread.scan_job SET state='succeeded',
      activation_result=${activate ? 'activated' : 'stale'},
      git_object_format=${acquired.objectFormat}, git_commit_oid=${acquired.commitId},
      git_tree_oid=${acquired.rootTreeId}, updated_at=now()
      WHERE id=${jobId}`;
  });
}

export async function loadSnapshot(db: Sql, snapshotId: string): Promise<Snapshot> {
  const row = (await db`SELECT facts_json FROM codethread.repository_snapshot
    WHERE id=${snapshotId} AND state='published'`)[0];
  if (!row) throw new Error('Published snapshot not found');
  const facts = row.facts_json as AnalysisFacts;
  if (facts.snapshotId !== snapshotId) throw new Error('Snapshot identity mismatch');
  const files = await db`SELECT f.id, f.path, f.content_hash, o.bytes
    FROM codethread.snapshot_file f JOIN codethread.source_object o
    ON o.sha256=f.content_hash WHERE f.snapshot_id=${snapshotId}`;
  const bytes = new Map<string, { path: string; bytes: Uint8Array; text: string }>();
  for (const f of files) {
    const raw = Uint8Array.from(f.bytes as Uint8Array);
    if (sha(raw) !== f.content_hash) throw new Error('Stored source object hash mismatch');
    bytes.set(f.id as string,{path:f.path as string,bytes:raw,
      text:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw)});
  }
  const refs = new Map(facts.evidenceRefs.map(e=>[e.id,e]));
  const source: VerifiedSourceReader = {
    readFile(id) { const file=bytes.get(id); return file ? Uint8Array.from(file.bytes) : null; },
    readEvidence(id) {
      const evidence=refs.get(id);
      const unavailable=(code:'EVIDENCE_NOT_FOUND'|'SOURCE_UNAVAILABLE'|'HASH_MISMATCH'|'INVALID_ENCODING'|'EVIDENCE_TOO_LARGE')=>({
        status:'unavailable' as const,snapshotId,evidenceId:id,code
      });
      if (!evidence) return unavailable('EVIDENCE_NOT_FOUND');
      const file=bytes.get(evidence.fileId);
      if (!file) return unavailable('SOURCE_UNAVAILABLE');
      if (sha(file.bytes)!==evidence.contentHash) return unavailable('HASH_MISMATCH');
      if (!createSourcePositionIndex(file.text).validateRange(evidence.range))
        return unavailable('SOURCE_UNAVAILABLE');
      if (evidence.range.end.offset - evidence.range.start.offset > 65536)
        return unavailable('EVIDENCE_TOO_LARGE');
      return {status:'available' as const,evidence,filePath:file.path,
        text:file.text.slice(evidence.range.start.offset,evidence.range.end.offset)};
    }
  };
  createInvestigation(facts,source,{resourceProfile:'repository'});
  return {facts,source};
}
