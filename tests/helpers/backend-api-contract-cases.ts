import { createHash, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { parseBackendResponse } from '../../scripts/backend/http-contracts.ts';
import type { BackendApiRoute } from '../../scripts/backend/http-contracts.ts';

export const backendContractSource =
  'export function getValue() { return 7; }\n' +
  'export function consumer() { return getValue(); }\n' +
  Array.from({ length: 51 }, (_, index) => {
    const number = String(index).padStart(3, '0');
    return `export function pageSymbol${number}() { return ${index}; }\n`;
  }).join('');

export type HttpContext = {
  apiOrigin: string;
  token: string;
  repositoryId: string;
  scanId: string;
  projectId: string;
  snapshotId: string;
  commitId: string;
  getValueId: string;
  consumerId: string;
  evidenceId: string;
};
export type BackendRequestOptions = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
};
export type BackendRouteCase = {
  route: BackendApiRoute;
  positive: () => Promise<void>;
  negative: () => Promise<void>;
};
type Dependencies = {
  context: () => HttpContext;
  request: (path: string, options?: BackendRequestOptions) => Promise<Response>;
  success: (
    route: BackendApiRoute,
    path: string,
    options?: BackendRequestOptions,
  ) => Promise<Record<string, unknown>>;
  failure: (
    path: string,
    status: number,
    code: string,
    options?: BackendRequestOptions,
  ) => Promise<void>;
  createRepositoryFixture: () => Promise<string>;
  stopWorker: () => Promise<void>;
};

export function createBackendApiContractCases(dependencies: Dependencies) {
  const ctx = dependencies.context,
    { success, failure } = dependencies,
    source = backendContractSource;
  let cancelledScanId = '';
  function scanPath(): string {
    return `/v1/scans/${ctx().scanId}`;
  }
  function projectPath(): string {
    return `${scanPath()}/projects/${encodeURIComponent(ctx().projectId)}`;
  }
  function scanRequest(idempotencyKey: string, revision = ctx().commitId) {
    return { revision, idempotencyKey };
  }
  async function rejectStructuredBodyVariants(
    path: string,
    validBody: Record<string, unknown>,
  ) {
    await failure(path, 400, 'INVALID_REQUEST', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    await failure(path, 400, 'INVALID_REQUEST', {
      method: 'POST',
      body: {},
    });
    await failure(path, 400, 'INVALID_REQUEST', {
      method: 'POST',
      body: null,
    });
    await failure(path, 400, 'INVALID_REQUEST', {
      method: 'POST',
      body: { ...validBody, unexpected: true },
    });
  }
  const backendApiContractCases: readonly BackendRouteCase[] = [
    {
      route: 'GET /v1/health',
      positive: async () => {
        const body = await success('GET /v1/health', '/v1/health');
        expect(body).toMatchObject({
          api: 'ready',
          database: 'ready',
          worker: 'ready',
          ready: true,
        });
      },
      negative: async () => {
        await dependencies.stopWorker();
        const response = await dependencies.request('/v1/health');
        expect(response.status).toBe(503);
        const body = await response.json();
        expect(parseBackendResponse('GET /v1/health', body)).toMatchObject({
          api: 'ready',
          database: 'ready',
          worker: 'unavailable',
          ready: false,
        });
      },
    },
    {
      route: 'POST /v1/repositories',
      positive: async () => {
        const locator = await dependencies.createRepositoryFixture();
        const body = await success(
          'POST /v1/repositories',
          '/v1/repositories',
          {
            method: 'POST',
            body: { locator },
          },
        );
        const readback = await success(
          'GET /v1/repositories/:id',
          `/v1/repositories/${String(body.id)}`,
        );
        expect(readback).toMatchObject({ id: body.id, locator: body.locator });
      },
      negative: async () => {
        const before = await success(
          'GET /v1/repositories',
          '/v1/repositories',
        );
        await rejectStructuredBodyVariants('/v1/repositories', {
          locator: 'fixture',
        });
        await failure('/v1/repositories', 400, 'INVALID_REQUEST', {
          method: 'POST',
          body: { locator: null },
        });
        await failure('/v1/repositories', 400, 'INVALID_REQUEST', {
          method: 'POST',
          body: { locator: 'x'.repeat(4097) },
        });
        const after = await success('GET /v1/repositories', '/v1/repositories');
        expect(after).toHaveLength((before as unknown as unknown[]).length);
      },
    },
    {
      route: 'GET /v1/repositories',
      positive: async () => {
        const rows = await success('GET /v1/repositories', '/v1/repositories');
        expect(Array.isArray(rows)).toBe(true);
        expect(rows).toContainEqual(
          expect.objectContaining({ id: ctx().repositoryId }),
        );
      },
      negative: async () => {
        await failure('/v1/repositories', 404, 'NOT_FOUND', {
          method: 'PATCH',
        });
      },
    },
    {
      route: 'GET /v1/repositories/:id',
      positive: async () => {
        const body = await success(
          'GET /v1/repositories/:id',
          `/v1/repositories/${ctx().repositoryId}`,
        );
        expect(body).toMatchObject({
          id: ctx().repositoryId,
          desired_generation: '1',
        });
      },
      negative: async () => {
        await failure('/v1/repositories/not-a-uuid', 400, 'INVALID_REQUEST');
        await failure(`/v1/repositories/${randomUUID()}`, 404, 'NOT_FOUND');
      },
    },
    {
      route: 'POST /v1/repositories/:id/scans',
      positive: async () => {
        const key = `api-contract-${randomUUID()}`,
          path = `/v1/repositories/${ctx().repositoryId}/scans`,
          before = await success(
            'GET /v1/repositories/:id',
            `/v1/repositories/${ctx().repositoryId}`,
          ),
          body = scanRequest(key),
          [first, second] = await Promise.all([
            success('POST /v1/repositories/:id/scans', path, {
              method: 'POST',
              body,
            }),
            success('POST /v1/repositories/:id/scans', path, {
              method: 'POST',
              body,
            }),
          ]),
          after = await success(
            'GET /v1/repositories/:id',
            `/v1/repositories/${ctx().repositoryId}`,
          );
        expect(first.id).toBe(second.id);
        expect([first.reused, second.reused].sort()).toEqual([false, true]);
        expect(String(after.desired_generation)).toBe(
          String(BigInt(String(before.desired_generation)) + 1n),
        );
      },
      negative: async () => {
        const path = `/v1/repositories/${ctx().repositoryId}/scans`,
          before = await success(
            'GET /v1/repositories/:id',
            `/v1/repositories/${ctx().repositoryId}`,
          );
        await rejectStructuredBodyVariants(path, scanRequest('shape-check'));
        await failure(path, 400, 'INVALID_REQUEST', {
          method: 'POST',
          body: { idempotencyKey: 'shape-check' },
        });
        await failure(path, 400, 'INVALID_REQUEST', {
          method: 'POST',
          body: { revision: null, idempotencyKey: 'shape-check' },
        });
        await failure(path, 400, 'INVALID_REQUEST', {
          method: 'POST',
          body: scanRequest('x'.repeat(129)),
        });
        const afterInvalid = await success(
          'GET /v1/repositories/:id',
          `/v1/repositories/${ctx().repositoryId}`,
        );
        expect(afterInvalid.desired_generation).toBe(before.desired_generation);
        const created = await success('POST /v1/repositories/:id/scans', path, {
          method: 'POST',
          body: scanRequest('api-contract-stable-key'),
        });
        expect(created.id).toBeTruthy();
        const beforeConflict = await success(
          'GET /v1/repositories/:id',
          `/v1/repositories/${ctx().repositoryId}`,
        );
        await failure(path, 409, 'IDEMPOTENCY_CONFLICT', {
          method: 'POST',
          body: scanRequest('api-contract-stable-key', 'different-revision'),
        });
        const after = await success(
          'GET /v1/repositories/:id',
          `/v1/repositories/${ctx().repositoryId}`,
        );
        expect(after.desired_generation).toBe(
          beforeConflict.desired_generation,
        );
      },
    },
    {
      route: 'GET /v1/scans/:id',
      positive: async () => {
        const body = await success('GET /v1/scans/:id', scanPath());
        expect(body).toMatchObject({
          id: ctx().scanId,
          state: 'succeeded',
          git_commit_oid: ctx().commitId,
        });
        expect(body.created_at).toMatch(/^\d{4}-\d\d-\d\dT/);
      },
      negative: async () => {
        await failure('/v1/scans/not-a-uuid', 400, 'INVALID_REQUEST');
        await failure(`/v1/scans/${randomUUID()}`, 404, 'NOT_FOUND');
      },
    },
    {
      route: 'POST /v1/scans/:id/viewer',
      positive: async () => {
        const body = await success(
          'POST /v1/scans/:id/viewer',
          `${scanPath()}/viewer`,
          { method: 'POST' },
        );
        expect(body.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#/);
        expect(body.expiresAt).toMatch(/^\d{4}-\d\d-\d\dT/);
      },
      negative: async () => {
        await failure(`${scanPath()}/viewer`, 400, 'INVALID_REQUEST', {
          method: 'POST',
          body: { unexpected: true },
        });
        await failure(`${scanPath()}/viewer`, 400, 'INVALID_REQUEST', {
          method: 'POST',
          body: null,
        });
        await failure('/v1/scans/not-a-uuid/viewer', 400, 'INVALID_REQUEST', {
          method: 'POST',
        });
        await failure(`/v1/scans/${randomUUID()}/viewer`, 404, 'NOT_FOUND', {
          method: 'POST',
        });
        const queued = await success(
          'POST /v1/repositories/:id/scans',
          `/v1/repositories/${ctx().repositoryId}/scans`,
          {
            method: 'POST',
            body: scanRequest(`api-contract-viewer-not-ready-${randomUUID()}`),
          },
        );
        await failure(
          `/v1/scans/${String(queued.id)}/viewer`,
          409,
          'VIEWER_NOT_READY',
          { method: 'POST' },
        );
      },
    },
    {
      route: 'GET /v1/scans/:id/projects',
      positive: async () => {
        const rows = await success(
          'GET /v1/scans/:id/projects',
          `${scanPath()}/projects`,
        );
        expect(Array.isArray(rows)).toBe(true);
        expect(rows).toContainEqual(
          expect.objectContaining({
            project_id: ctx().projectId,
            status: 'ready',
            snapshot_id: ctx().snapshotId,
          }),
        );
      },
      negative: async () => {
        await failure('/v1/scans/not-a-uuid/projects', 400, 'INVALID_REQUEST');
        await failure(`/v1/scans/${randomUUID()}/projects`, 404, 'NOT_FOUND');
      },
    },
    {
      route: 'GET /v1/scans/:id/files',
      positive: async () => {
        const body = await success(
          'GET /v1/scans/:id/files',
          `${scanPath()}/files`,
        );
        expect(body).toMatchObject({
          total: 1,
          nextOffset: null,
          items: [
            {
              path: 'index.ts',
              content_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
              git_blob_oid: expect.stringMatching(/^[0-9a-f]{40}$/),
              git_mode: '100644',
            },
          ],
        });
      },
      negative: async () => {
        await failure(
          `${scanPath()}/files?offset=1257`,
          400,
          'INVALID_REQUEST',
        );
        await failure(`${scanPath()}/files?offset=-1`, 400, 'INVALID_REQUEST');
      },
    },
    {
      route: 'GET /v1/scans/:id/projects/:projectId/symbols',
      positive: async () => {
        const body = await success(
          'GET /v1/scans/:id/projects/:projectId/symbols',
          `${projectPath()}/symbols?query=consumer`,
        );
        expect(body).toMatchObject({
          meta: { snapshotId: ctx().snapshotId },
          total: 1,
          items: [expect.objectContaining({ id: ctx().consumerId })],
        });
      },
      negative: async () => {
        await failure(
          `${projectPath()}/symbols?offset=20001`,
          400,
          'INVALID_REQUEST',
        );
        await failure(
          `${projectPath()}/symbols?query=${'x'.repeat(257)}`,
          400,
          'INVALID_REQUEST',
        );
        await failure(
          `${scanPath()}/projects/missing/symbols?query=x`,
          404,
          'NOT_FOUND',
        );
      },
    },
    {
      route: 'POST /v1/scans/:id/projects/:projectId/neighbors',
      positive: async () => {
        const body = await success(
          'POST /v1/scans/:id/projects/:projectId/neighbors',
          `${projectPath()}/neighbors`,
          {
            method: 'POST',
            body: {
              snapshotId: ctx().snapshotId,
              symbolId: ctx().consumerId,
              depth: 1,
              nodeLimit: 20,
              direction: 'outgoing',
              relationKinds: ['calls'],
            },
          },
        );
        expect(body).toMatchObject({
          meta: { snapshotId: ctx().snapshotId },
          rootSymbolId: ctx().consumerId,
        });
        const relation = (body.relations as Record<string, unknown>[]).find(
          (item) => item.kind === 'calls',
        );
        expect(relation?.resolution).toMatchObject({
          status: 'exact',
          targetId: ctx().getValueId,
        });
        const repeated = await success(
          'POST /v1/scans/:id/projects/:projectId/neighbors',
          `${projectPath()}/neighbors`,
          {
            method: 'POST',
            body: {
              snapshotId: ctx().snapshotId,
              symbolId: ctx().consumerId,
              depth: 1,
              nodeLimit: 20,
              direction: 'outgoing',
              relationKinds: ['calls'],
            },
          },
        );
        expect(repeated).toEqual(body);
      },
      negative: async () => {
        await rejectStructuredBodyVariants(`${projectPath()}/neighbors`, {
          snapshotId: ctx().snapshotId,
          symbolId: ctx().consumerId,
          direction: 'outgoing',
          relationKinds: ['calls'],
          depth: 1,
          nodeLimit: 20,
        });
        await failure(`${projectPath()}/neighbors`, 400, 'INVALID_REQUEST', {
          method: 'POST',
          body: {
            snapshotId: null,
            symbolId: ctx().consumerId,
            direction: 'outgoing',
            relationKinds: ['calls'],
            depth: 1,
            nodeLimit: 20,
          },
        });
        await failure(`${projectPath()}/neighbors`, 400, 'INVALID_REQUEST', {
          method: 'POST',
          body: {
            snapshotId: ctx().snapshotId,
            symbolId: ctx().consumerId,
            depth: 6,
          },
        });
        await failure(`${projectPath()}/neighbors`, 409, 'SNAPSHOT_MISMATCH', {
          method: 'POST',
          body: { snapshotId: randomUUID(), symbolId: ctx().consumerId },
        });
      },
    },
    {
      route: 'POST /v1/scans/:id/projects/:projectId/paths',
      positive: async () => {
        const body = await success(
          'POST /v1/scans/:id/projects/:projectId/paths',
          `${projectPath()}/paths`,
          {
            method: 'POST',
            body: {
              snapshotId: ctx().snapshotId,
              fromSymbolId: ctx().consumerId,
              toSymbolId: ctx().getValueId,
              depth: 1,
              nodeLimit: 20,
              pathLimit: 5,
              relationKinds: ['calls'],
            },
          },
        );
        expect(body).toMatchObject({
          meta: { snapshotId: ctx().snapshotId },
          fromSymbolId: ctx().consumerId,
          toSymbolId: ctx().getValueId,
          paths: [{ symbolIds: [ctx().consumerId, ctx().getValueId] }],
        });
        const repeated = await success(
          'POST /v1/scans/:id/projects/:projectId/paths',
          `${projectPath()}/paths`,
          {
            method: 'POST',
            body: {
              snapshotId: ctx().snapshotId,
              fromSymbolId: ctx().consumerId,
              toSymbolId: ctx().getValueId,
              depth: 1,
              nodeLimit: 20,
              pathLimit: 5,
              relationKinds: ['calls'],
            },
          },
        );
        expect(repeated).toEqual(body);
      },
      negative: async () => {
        await rejectStructuredBodyVariants(`${projectPath()}/paths`, {
          snapshotId: ctx().snapshotId,
          fromSymbolId: ctx().consumerId,
          toSymbolId: ctx().getValueId,
          relationKinds: ['calls'],
          depth: 1,
          nodeLimit: 20,
          pathLimit: 5,
        });
        await failure(`${projectPath()}/paths`, 400, 'INVALID_REQUEST', {
          method: 'POST',
          body: {
            snapshotId: ctx().snapshotId,
            fromSymbolId: null,
            toSymbolId: ctx().getValueId,
            relationKinds: ['calls'],
            depth: 1,
            nodeLimit: 20,
            pathLimit: 5,
          },
        });
        await failure(`${projectPath()}/paths`, 400, 'INVALID_REQUEST', {
          method: 'POST',
          body: {
            snapshotId: ctx().snapshotId,
            fromSymbolId: ctx().consumerId,
            toSymbolId: ctx().getValueId,
            pathLimit: 21,
          },
        });
        await failure(`${projectPath()}/paths`, 409, 'SNAPSHOT_MISMATCH', {
          method: 'POST',
          body: {
            snapshotId: randomUUID(),
            fromSymbolId: ctx().consumerId,
            toSymbolId: ctx().getValueId,
          },
        });
      },
    },
    {
      route: 'POST /v1/scans/:id/projects/:projectId/evidence',
      positive: async () => {
        const body = await success(
          'POST /v1/scans/:id/projects/:projectId/evidence',
          `${projectPath()}/evidence`,
          {
            method: 'POST',
            body: {
              snapshotId: ctx().snapshotId,
              evidenceIds: [ctx().evidenceId],
            },
          },
        );
        const item = (body.items as Record<string, unknown>[])[0];
        expect(item).toMatchObject({
          status: 'available',
          filePath: 'index.ts',
        });
        const files = await success(
          'GET /v1/scans/:id/files',
          `${scanPath()}/files`,
        );
        const fileHash = (files.items as Record<string, unknown>[])[0]
            ?.content_hash,
          expectedHash = createHash('sha256').update(source).digest('hex');
        expect(fileHash).toBe(expectedHash);
        expect((item?.evidence as Record<string, unknown>).contentHash).toBe(
          expectedHash,
        );
        expect(item?.text).toContain('consumer');
      },
      negative: async () => {
        await rejectStructuredBodyVariants(`${projectPath()}/evidence`, {
          snapshotId: ctx().snapshotId,
          evidenceIds: [ctx().evidenceId],
        });
        await failure(`${projectPath()}/evidence`, 400, 'INVALID_REQUEST', {
          method: 'POST',
          body: { snapshotId: ctx().snapshotId, evidenceIds: null },
        });
        await failure(`${projectPath()}/evidence`, 400, 'INVALID_REQUEST', {
          method: 'POST',
          body: { snapshotId: ctx().snapshotId, evidenceIds: [] },
        });
        await failure(`${projectPath()}/evidence`, 400, 'INVALID_REQUEST', {
          method: 'POST',
          body: {
            snapshotId: ctx().snapshotId,
            evidenceIds: [ctx().evidenceId, ctx().evidenceId],
          },
        });
        await failure(`${projectPath()}/evidence`, 409, 'SNAPSHOT_MISMATCH', {
          method: 'POST',
          body: { snapshotId: randomUUID(), evidenceIds: [ctx().evidenceId] },
        });
      },
    },
    {
      route: 'POST /v1/scans/:id/cancel',
      positive: async () => {
        await dependencies.stopWorker();
        const queued = await success(
          'POST /v1/repositories/:id/scans',
          `/v1/repositories/${ctx().repositoryId}/scans`,
          {
            method: 'POST',
            body: scanRequest(`api-contract-cancel-${randomUUID()}`),
          },
        );
        cancelledScanId = String(queued.id);
        const body = await success(
          'POST /v1/scans/:id/cancel',
          `/v1/scans/${cancelledScanId}/cancel`,
          { method: 'POST' },
        );
        expect(body).toEqual({ id: cancelledScanId, state: 'cancelled' });
        const readback = await success(
          'GET /v1/scans/:id',
          `/v1/scans/${cancelledScanId}`,
        );
        expect(readback.state).toBe('cancelled');
      },
      negative: async () => {
        await failure(`${scanPath()}/cancel`, 400, 'INVALID_REQUEST', {
          method: 'POST',
          body: {},
        });
        await failure(`${scanPath()}/cancel`, 400, 'INVALID_REQUEST', {
          method: 'POST',
          body: null,
        });
        await failure('/v1/scans/not-a-uuid/cancel', 400, 'INVALID_REQUEST', {
          method: 'POST',
        });
        let terminalScanId = cancelledScanId;
        if (!terminalScanId) {
          await dependencies.stopWorker();
          const queued = await success(
            'POST /v1/repositories/:id/scans',
            `/v1/repositories/${ctx().repositoryId}/scans`,
            {
              method: 'POST',
              body: scanRequest(`api-contract-cancel-neg-${randomUUID()}`),
            },
          );
          terminalScanId = String(queued.id);
          await success(
            'POST /v1/scans/:id/cancel',
            `/v1/scans/${terminalScanId}/cancel`,
            { method: 'POST' },
          );
        }
        await failure(
          `/v1/scans/${terminalScanId}/cancel`,
          409,
          'NOT_CANCELLABLE',
          {
            method: 'POST',
          },
        );
      },
    },
  ];

  return backendApiContractCases;
}
