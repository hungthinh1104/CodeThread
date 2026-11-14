import { summarizeCoverage } from '@codethread/code-model';
import { z } from 'zod';
import {
  getSourceEvidenceRequestSchema,
  graphNeighborsRequestSchema,
  findSymbolPathsRequestSchema,
  listSymbolsRequestSchema,
  parseGetSourceEvidenceResult,
  parseGraphNeighborsResult,
  parseFindSymbolPathsResult,
  parseListSymbolsResult,
} from '@codethread/contracts';
import { createInvestigation } from '@codethread/trace-engine';
import type { CoverageStatus } from '@codethread/code-model';
import type { Database } from './database.ts';
import { loadSnapshot } from './snapshot-persistence.ts';
import { searchPublishedSymbols } from './symbol-search.ts';
import { ServiceError } from './service.ts';
import type { ScanService } from './service.ts';

type ProjectQuery = 'neighbors' | 'paths' | 'evidence';
const MAX_HEAVY_QUERIES = 4;
const symbolSearchParameters = z.strictObject({
  query: z.string().max(256).default(''),
  offset: z.number().int().min(0).max(20000).default(0),
  limit: z.number().int().min(1).max(50).default(50),
});

/** Application boundary for snapshot-scoped API reads. */
export class BackendQueryService {
  private readonly db: Database;
  private readonly scans: Pick<ScanService, 'publishedSnapshot'>;
  private activeHeavyQueries = 0;

  constructor(db: Database, scans: Pick<ScanService, 'publishedSnapshot'>) {
    this.db = db;
    this.scans = scans;
  }

  async symbols(jobId: string, projectId: string, input: unknown) {
    const snapshotId = await this.scans.publishedSnapshot(jobId, projectId);
    const request = listSymbolsRequestSchema.parse({
      ...symbolSearchParameters.parse(input),
      snapshotId,
    });
    return this.db.begin(async (transaction) => {
      const db = transaction as unknown as Database;
      await db`SELECT pg_advisory_xact_lock_shared(
        1919606126,hashtext(${snapshotId}::text))`;
      const [snapshotRows, capabilityRows] = await Promise.all([
        db`SELECT coverage FROM codethread.repository_snapshot
          WHERE id=${snapshotId} AND state='published'`,
        db`SELECT capability_key,coverage FROM codethread.snapshot_capability
          WHERE snapshot_id=${snapshotId} ORDER BY capability_key COLLATE "C"`,
      ]);
      const snapshot = snapshotRows[0];
      if (!snapshot)
        throw new ServiceError(
          404,
          'NOT_FOUND',
          'Published snapshot not found',
        );
      const coverageByCapability = Object.fromEntries(
        capabilityRows.map((row) => [
          String(row.capability_key),
          String(row.coverage) as CoverageStatus,
        ]),
      );
      const coverage = summarizeCoverage(coverageByCapability);
      if (coverage !== snapshot.coverage)
        throw new Error('Stored snapshot capability coverage is inconsistent');
      const page = await searchPublishedSymbols(
        db,
        snapshotId,
        request.query,
        request.offset,
        request.limit,
      );
      const { total, items } = page;
      const end = request.offset + items.length,
        hasMore = total > end;
      return parseListSymbolsResult(request, {
        meta: {
          snapshotId,
          evidenceBasis: 'static',
          coverage,
          coverageByCapability,
          truncated: hasMore,
          truncationReasons: hasMore ? ['result_limit'] : [],
          appliedLimits: { pageSize: request.limit },
        },
        items,
        total,
        nextOffset: hasMore ? end : null,
      });
    });
  }

  async project(
    jobId: string,
    projectId: string,
    kind: ProjectQuery,
    input: unknown,
  ) {
    if (this.activeHeavyQueries >= MAX_HEAVY_QUERIES)
      throw new ServiceError(
        429,
        'QUERY_CAPACITY_EXCEEDED',
        'Too many graph or evidence queries are active; retry shortly.',
      );
    this.activeHeavyQueries++;
    try {
      return await this.executeProject(jobId, projectId, kind, input);
    } finally {
      this.activeHeavyQueries--;
    }
  }

  private async executeProject(
    jobId: string,
    projectId: string,
    kind: ProjectQuery,
    input: unknown,
  ) {
    const expectedSnapshotId = await this.scans.publishedSnapshot(
      jobId,
      projectId,
    );
    const request =
      kind === 'neighbors'
        ? graphNeighborsRequestSchema.parse(input)
        : kind === 'paths'
          ? findSymbolPathsRequestSchema.parse(input)
          : getSourceEvidenceRequestSchema.parse(input);
    if (request.snapshotId !== expectedSnapshotId)
      throw new ServiceError(
        409,
        'SNAPSHOT_MISMATCH',
        'Query snapshot does not match the selected project.',
      );
    const snapshot = await loadSnapshot(this.db, expectedSnapshotId);
    const investigation = createInvestigation(snapshot.facts, snapshot.source, {
      resourceProfile: 'repository',
    });
    if (kind === 'neighbors') {
      const neighbors = graphNeighborsRequestSchema.parse(input);
      return parseGraphNeighborsResult(
        neighbors,
        investigation.neighbors(neighbors),
      );
    }
    if (kind === 'paths') {
      const paths = findSymbolPathsRequestSchema.parse(input);
      return parseFindSymbolPathsResult(paths, investigation.paths(paths));
    }
    const evidence = getSourceEvidenceRequestSchema.parse(input);
    return parseGetSourceEvidenceResult(
      evidence,
      investigation.sourceEvidence(evidence),
    );
  }
}
