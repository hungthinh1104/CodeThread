import { summarizeCoverage } from '@codethread/code-model';
import { TraceError } from '@codethread/trace-engine';
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
import type { CoverageStatus } from '@codethread/code-model';
import { withScanRead, type Database } from './database.ts';
import {
  loadSnapshotContentsInTransaction,
  protectSnapshotRead,
} from './snapshot-persistence.ts';
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

function validateServerResult<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof z.ZodError)
      throw new Error('Stored query result failed validation', {
        cause: error,
      });
    throw error;
  }
}

/** Application boundary for snapshot-scoped API reads. */
export class BackendQueryService {
  private readonly db: Database;
  private readonly scans: Pick<ScanService, 'publishedSnapshot'>;
  private activeHeavyQueries = 0;

  constructor(db: Database, scans: Pick<ScanService, 'publishedSnapshot'>) {
    this.db = db;
    this.scans = scans;
  }

  get activeHeavyQueryCount(): number {
    return this.activeHeavyQueries;
  }

  async symbols(jobId: string, projectId: string, input: unknown) {
    if (this.activeHeavyQueries >= MAX_HEAVY_QUERIES)
      throw new ServiceError(
        429,
        'QUERY_CAPACITY_EXCEEDED',
        'Too many symbol, graph or evidence queries are active; retry shortly.',
      );
    this.activeHeavyQueries++;
    try {
      return await this.executeSymbols(jobId, projectId, input);
    } finally {
      this.activeHeavyQueries--;
    }
  }

  private async executeSymbols(
    jobId: string,
    projectId: string,
    input: unknown,
  ) {
    return withScanRead(this.db, jobId, async (db) => {
      const snapshotId = await this.scans.publishedSnapshot(
        jobId,
        projectId,
        db,
      );
      const request = listSymbolsRequestSchema.parse({
        ...symbolSearchParameters.parse(input),
        snapshotId,
      });
      await protectSnapshotRead(db, snapshotId);
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
      return validateServerResult(() =>
        parseListSymbolsResult(request, {
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
        }),
      );
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
        'Too many symbol, graph or evidence queries are active; retry shortly.',
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
    const snapshot = await withScanRead(this.db, jobId, async (db) => {
      const expectedSnapshotId = await this.scans.publishedSnapshot(
        jobId,
        projectId,
        db,
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
      await protectSnapshotRead(db, expectedSnapshotId);
      return loadSnapshotContentsInTransaction(db, expectedSnapshotId);
    });
    const { investigation } = snapshot;
    if (kind === 'neighbors') {
      const neighbors = graphNeighborsRequestSchema.parse(input);
      return validateServerResult(() =>
        parseGraphNeighborsResult(
          neighbors,
          investigation.neighbors(neighbors),
        ),
      );
    }
    if (kind === 'paths') {
      const paths = findSymbolPathsRequestSchema.parse(input);
      return validateServerResult(() =>
        parseFindSymbolPathsResult(paths, investigation.paths(paths)),
      );
    }
    const evidence = getSourceEvidenceRequestSchema.parse(input);
    return validateServerResult(() =>
      parseGetSourceEvidenceResult(
        evidence,
        investigation.sourceEvidence(evidence),
      ),
    );
  }

  /**
   * Loads one verified snapshot, executes both bounded graph-neighbors and
   * supporting source-evidence in memory, and releases the heavy-query slot
   * before any external AI provider call begins.
   */
  async aiProjection(
    jobId: string,
    projectId: string,
    neighborsInput: unknown,
  ) {
    if (this.activeHeavyQueries >= MAX_HEAVY_QUERIES)
      throw new ServiceError(
        429,
        'QUERY_CAPACITY_EXCEEDED',
        'Too many symbol, graph or evidence queries are active; retry shortly.',
      );
    this.activeHeavyQueries++;
    try {
      const neighborsRequest =
        graphNeighborsRequestSchema.parse(neighborsInput);
      const snapshot = await withScanRead(this.db, jobId, async (db) => {
        const expectedSnapshotId = await this.scans.publishedSnapshot(
          jobId,
          projectId,
          db,
        );
        if (neighborsRequest.snapshotId !== expectedSnapshotId)
          throw new ServiceError(
            409,
            'SNAPSHOT_MISMATCH',
            'Query snapshot does not match the selected project.',
          );
        await protectSnapshotRead(db, expectedSnapshotId);
        return loadSnapshotContentsInTransaction(db, expectedSnapshotId);
      });
      const { investigation } = snapshot;
      let rawGraph;
      try {
        rawGraph = investigation.neighbors(neighborsRequest);
      } catch (error) {
        if (error instanceof TraceError) {
          if (error.code === 'ENTITY_NOT_FOUND')
            throw new ServiceError(
              404,
              'NOT_FOUND',
              'Requested symbol was not found in the snapshot.',
            );
          if (error.code === 'RESOURCE_LIMIT')
            throw new ServiceError(
              413,
              'RESPONSE_TOO_LARGE',
              'Graph projection exceeded resource bounds.',
            );
          throw new ServiceError(
            400,
            'INVALID_REQUEST',
            'Invalid graph projection request.',
          );
        }
        throw error;
      }
      const graph = validateServerResult(() =>
        parseGraphNeighborsResult(neighborsRequest, rawGraph),
      );
      const rootSymbol = graph.symbols.find(
        (sym) => sym.id === graph.rootSymbolId,
      );
      const evidenceIds = [
        ...new Set([
          ...(rootSymbol ? [rootSymbol.declarationEvidenceId] : []),
          ...graph.relations.flatMap((rel) => rel.resolution.evidenceIds),
          ...graph.symbols.map((sym) => sym.declarationEvidenceId),
        ]),
      ].slice(0, 100);
      const evidenceRequest = getSourceEvidenceRequestSchema.parse({
        snapshotId: neighborsRequest.snapshotId,
        evidenceIds,
      });
      const evidenceBatch = validateServerResult(() =>
        parseGetSourceEvidenceResult(
          evidenceRequest,
          investigation.sourceEvidence(evidenceRequest),
        ),
      );
      return { graph, evidenceBatch };
    } finally {
      this.activeHeavyQueries--;
    }
  }
}
