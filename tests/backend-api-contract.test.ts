import { randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createServer as createPortProbe } from 'node:net';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { analyzerBuildHash } from '@codethread/symbol-indexer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  backendApiResponseSchemas,
  parseBackendErrorResponse,
  parseBackendResponse,
} from '../scripts/backend/http-contracts.ts';
import { connect } from '../scripts/backend/database.ts';
import { applyMigrations } from '../scripts/backend/migrations.ts';
import { makeApi } from '../scripts/backend/http.ts';
import { ScanService } from '../scripts/backend/service.ts';
import { acquireWorkerLease } from '../scripts/backend/worker-lease.ts';
import { PersistentViewerManager } from '../scripts/backend/viewer-adapter.ts';
import type { BackendApiRoute } from '../scripts/backend/http-contracts.ts';
import {
  backendContractSource,
  createBackendApiContractCases,
} from './helpers/backend-api-contract-cases.ts';
import type { HttpContext } from './helpers/backend-api-contract-cases.ts';
import { createGitRepository } from './helpers/git-fixture.ts';

const databaseUrl = process.env.CODETHREAD_TEST_DATABASE_URL;
let context: HttpContext,
  db: ReturnType<typeof connect> | undefined,
  service: ScanService | undefined,
  viewers: PersistentViewerManager | undefined,
  server: ReturnType<typeof makeApi> | undefined,
  worker: Promise<void> | undefined,
  lease: Awaited<ReturnType<typeof acquireWorkerLease>> | undefined;
const temporaryDirectories: string[] = [];

async function findPort(): Promise<number> {
  const probe = createPortProbe();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  if (!address || typeof address === 'string')
    throw new Error('Could not reserve an API test port.');
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function request(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${context.token}`,
    ...options.headers,
  };
  const init: RequestInit = {
    method: options.method ?? 'GET',
    headers,
  };
  if (options.body !== undefined) {
    headers['content-type'] ??= 'application/json';
    init.body = JSON.stringify(options.body);
  }
  return fetch(context.apiOrigin + path, init);
}

async function success(
  route: BackendApiRoute,
  path: string,
  options: Parameters<typeof request>[1] = {},
): Promise<Record<string, unknown>> {
  const response = await request(path, options);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/json');
  const body: unknown = await response.json();
  expect(parseBackendResponse(route, body)).toEqual(body);
  return body as Record<string, unknown>;
}

async function failure(
  path: string,
  status: number,
  code: string,
  options: Parameters<typeof request>[1] = {},
): Promise<void> {
  const response = await request(path, options);
  expect(response.status).toBe(status);
  expect(parseBackendErrorResponse(await response.json())).toMatchObject({
    error: { code },
  });
}

async function wrongHostStatus(): Promise<{ status: number; body: unknown }> {
  const url = new URL(context.apiOrigin);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: '127.0.0.1',
        port: Number(url.port),
        path: '/v1/health',
        method: 'GET',
        headers: {
          host: 'attacker.invalid',
          authorization: `Bearer ${context.token}`,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.once('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
          }),
        );
      },
    );
    request.once('error', reject);
    request.end();
  });
}

async function rawHttp(
  path: string,
  method: string,
  body?: Buffer,
): Promise<{ status: number; body: unknown }> {
  const url = new URL(context.apiOrigin);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: '127.0.0.1',
        port: Number(url.port),
        path,
        method,
        headers: {
          authorization: `Bearer ${context.token}`,
          ...(body
            ? {
                'content-type': 'application/json',
                'content-length': String(body.byteLength),
              }
            : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.once('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
          }),
        );
      },
    );
    request.once('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

const backendApiContractCases = createBackendApiContractCases({
  context: () => context,
  request,
  success,
  failure,
  createRepositoryFixture: async () =>
    (
      await createGitRepository(
        [{ path: 'index.ts', source: backendContractSource }],
        temporaryDirectories,
      )
    ).directory,
  stopWorker: async () => {
    service!.stop();
    await worker;
  },
});
describe.skipIf(!databaseUrl)('PostgreSQL backend HTTP contract matrix', () => {
  beforeAll(async () => {
    const fixture = await createGitRepository(
      [{ path: 'index.ts', source: backendContractSource }],
      temporaryDirectories,
    );
    const apiDb = connect(databaseUrl!);
    db = apiDb;
    await applyMigrations(apiDb);
    lease = await acquireWorkerLease(databaseUrl!);
    service = new ScanService(
      apiDb,
      {
        root: dirname(fixture.directory),
        analyzerBuildHash: analyzerBuildHash(),
      },
      lease,
    );
    viewers = new PersistentViewerManager(apiDb);
    const port = await findPort();
    context = {
      apiOrigin: `http://127.0.0.1:${port}`,
      token: randomBytes(32).toString('hex'),
      repositoryId: '',
      scanId: '',
      projectId: '',
      snapshotId: '',
      commitId: fixture.revision,
      getValueId: '',
      consumerId: '',
      evidenceId: '',
    };
    server = makeApi(apiDb, service, context.token, port, viewers);
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(port, '127.0.0.1', resolve);
    });
    worker = service.run();
    const registered = await service.register(fixture.directory),
      accepted = await service.accept(
        registered.id,
        fixture.revision,
        randomUUID(),
      );
    context.repositoryId = registered.id;
    context.scanId = accepted.id;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const job = await service.job(accepted.id);
      if (job.state === 'succeeded') break;
      if (job.state === 'failed' || job.state === 'cancelled')
        throw new Error(`API fixture scan ended in ${job.state}.`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const job = await service.job(accepted.id);
    expect(job.state).toBe('succeeded');
    const project = (await service.projects(accepted.id)).find(
      (item) => item.status === 'ready',
    );
    if (!project?.snapshot_id)
      throw new Error('API contract fixture has no ready project.');
    context.projectId = project.project_id;
    context.snapshotId = project.snapshot_id;
    const symbols = await success(
      'GET /v1/scans/:id/projects/:projectId/symbols',
      `/v1/scans/${context.scanId}/projects/${encodeURIComponent(context.projectId)}/symbols?offset=0`,
    );
    const items = symbols.items as Record<string, unknown>[];
    const getValue = items.find((item) => item.name === 'getValue'),
      consumer = items.find((item) => item.name === 'consumer');
    if (!getValue || !consumer)
      throw new Error('API contract fixture symbols are incomplete.');
    context.getValueId = String(getValue.id);
    context.consumerId = String(consumer.id);
    context.evidenceId = String(consumer.declarationEvidenceId);
  }, 150_000);

  afterAll(async () => {
    service?.stop();
    await worker;
    await viewers?.closeAll();
    if (server)
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    await lease?.close();
    await db?.end({ timeout: 5 });
    for (const directory of temporaryDirectories)
      await rm(directory, { recursive: true, force: true });
  });

  it('shares one viewer across concurrent opens of the same scan and recovers capacity', async () => {
    const open = (id: string) =>
      request('/v1/scans/' + id + '/viewer', { method: 'POST' });
    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        open(index % 2 ? context.scanId.toUpperCase() : context.scanId),
      ),
    );
    expect(responses.map(({ status }) => status)).toEqual([
      200, 200, 200, 200, 200,
    ]);
    const viewersByOpen = await Promise.all(
      responses.map((response) => response.json()),
    );
    const first = viewersByOpen[0];
    expect(viewersByOpen).toEqual(Array.from({ length: 5 }, () => first));

    const laterJobs: string[] = [];
    const capacityFixture = await createGitRepository(
      [{ path: 'index.ts', source: backendContractSource }],
      temporaryDirectories,
    );
    const capacityRepository = await service!.register(
      capacityFixture.directory,
    );
    for (let index = 0; index < 4; index++) {
      const scan = await service!.accept(
        capacityRepository.id,
        capacityFixture.revision,
        randomUUID(),
      );
      const deadline = Date.now() + 30_000;
      for (;;) {
        const { state } = await service!.job(scan.id);
        if (state === 'succeeded') break;
        if (
          state === 'failed' ||
          state === 'cancelled' ||
          Date.now() >= deadline
        )
          throw new Error('Viewer capacity fixture scan ended in ' + state);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      laterJobs.push(scan.id);
    }
    try {
      const distinctViewers = new Set([first.url]);
      for (const id of laterJobs.slice(0, 3)) {
        const opened = await open(id);
        expect(opened.status).toBe(200);
        distinctViewers.add((await opened.json()).url);
      }
      expect(distinctViewers.size).toBe(4);
      const lastJob = laterJobs[3]!;
      const full = await open(lastJob);
      expect(full.status).toBe(429);
      expect(await full.json()).toMatchObject({
        error: { code: 'VIEWER_CAPACITY' },
      });
      await viewers!.closeAll();
      expect((await open(lastJob)).status).toBe(200);
    } finally {
      await viewers!.closeAll();
    }
  }, 60_000);

  for (const testCase of backendApiContractCases) {
    it(
      `${testCase.route} returns its valid public response`,
      testCase.positive,
    );
  }
  for (const testCase of backendApiContractCases.filter(
    (item) => item.route !== 'GET /v1/health',
  )) {
    it(
      `${testCase.route} rejects its route-specific invalid request`,
      testCase.negative,
    );
  }
  it(
    'GET /v1/health reports a stopped worker as unavailable',
    backendApiContractCases[0]!.negative,
  );

  it('keeps authentication, Host, and Origin checks at the transport boundary', async () => {
    const missingToken = await fetch(context.apiOrigin + '/v1/health');
    expect(missingToken.status).toBe(401);
    expect(parseBackendErrorResponse(await missingToken.json())).toMatchObject({
      error: { code: 'UNAUTHORIZED' },
    });
    const wrongToken = await request('/v1/health', {
      headers: { authorization: 'Bearer invalid-token' },
    });
    expect(wrongToken.status).toBe(401);
    expect(parseBackendErrorResponse(await wrongToken.json())).toMatchObject({
      error: { code: 'UNAUTHORIZED' },
    });
    const invalidOrigin = await request('/v1/health', {
      headers: { origin: 'https://attacker.invalid' },
    });
    expect(invalidOrigin.status).toBe(403);
    expect(parseBackendErrorResponse(await invalidOrigin.json())).toMatchObject(
      {
        error: { code: 'INVALID_ORIGIN' },
      },
    );
    const invalidHost = await wrongHostStatus();
    expect(invalidHost.status).toBe(403);
    expect(parseBackendErrorResponse(invalidHost.body)).toMatchObject({
      error: { code: 'INVALID_HOST' },
    });
    await failure('/v1/repositories', 413, 'REQUEST_TOO_LARGE', {
      method: 'POST',
      body: { locator: 'x'.repeat(70_000) },
    });
    await failure('/v1/health?unexpected=1', 400, 'INVALID_REQUEST');
    const filesPath = `/v1/scans/${context.scanId}/files`;
    for (const query of [
      'offset=0&unexpected=1',
      'offset=0&offset=1',
      'offset=1.5',
      'offset=',
    ])
      await failure(`${filesPath}?${query}`, 400, 'INVALID_REQUEST');
    const symbolsPath = `/v1/scans/${context.scanId}/projects/${encodeURIComponent(context.projectId)}/symbols`;
    await failure(
      `${symbolsPath}?query=consumer&unexpected=1`,
      400,
      'INVALID_REQUEST',
    );
    await failure(
      `${symbolsPath}?query=consumer&query=consumer`,
      400,
      'INVALID_REQUEST',
    );
  });

  it('rejects malformed UTF-8 JSON and percent-encoded path segments', async () => {
    const malformedJson = Buffer.from([
      0x7b, 0x22, 0x6c, 0x6f, 0x63, 0x61, 0x74, 0x6f, 0x72, 0x22, 0x3a, 0x22,
      0xc3, 0x28, 0x22, 0x7d,
    ]);
    const badJson = await rawHttp('/v1/repositories', 'POST', malformedJson);
    expect(badJson.status).toBe(400);
    expect(parseBackendErrorResponse(badJson.body)).toMatchObject({
      error: { code: 'INVALID_JSON' },
    });
    const badPath = await rawHttp('/v1/scans/%E0%A4%A', 'GET');
    expect(badPath.status).toBe(400);
    expect(parseBackendErrorResponse(badPath.body)).toMatchObject({
      error: { code: 'INVALID_REQUEST' },
    });
  });

  it('GET /v1/scans/:id/projects caps an oversized serialized response', async () => {
    const admin = connect(databaseUrl!),
      databaseName = 'ct_response_' + randomUUID().replaceAll('-', ''),
      targetUrl = new URL(databaseUrl!),
      root = await mkdtemp(join(tmpdir(), 'ct-backend-response-cap-')),
      repositoryPath = join(root, 'repo');
    targetUrl.pathname = '/' + databaseName;
    let responseDb: ReturnType<typeof connect> | undefined,
      responseService: ScanService | undefined,
      responseServer: ReturnType<typeof makeApi> | undefined;
    try {
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
      await mkdir(repositoryPath);
      responseDb = connect(targetUrl.toString());
      await applyMigrations(responseDb);
      responseService = new ScanService(responseDb, {
        root,
        analyzerBuildHash: analyzerBuildHash(),
      });
      const repository = await responseService.register(repositoryPath),
        job = await responseService.accept(repository.id, 'HEAD', randomUUID());
      await responseDb`
        UPDATE codethread.scan_job SET state='running',attempt=attempt+1
        WHERE id=${job.id}
      `;
      await responseDb`
        INSERT INTO codethread.scan_project
          (repository_id,scan_job_id,project_id,project_label,project_json,status,diagnostics)
        VALUES
          (${repository.id},${job.id},'response-cap','Response cap fixture',
           ${responseDb.json({})},'failed',${responseDb.json([
             { code: 'RESPONSE_LIMIT_TEST', message: 'x'.repeat(1024 * 1024) },
           ])})
      `;
      const port = await findPort(),
        token = randomBytes(32).toString('hex');
      responseServer = makeApi(responseDb, responseService, token, port);
      await new Promise<void>((resolve, reject) => {
        responseServer!.once('error', reject);
        responseServer!.listen(port, '127.0.0.1', resolve);
      });
      const response = await fetch(
        `http://127.0.0.1:${port}/v1/scans/${job.id}/projects`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(response.status).toBe(413);
      expect(parseBackendErrorResponse(await response.json())).toMatchObject({
        error: { code: 'RESPONSE_TOO_LARGE' },
      });
    } finally {
      if (responseServer)
        await new Promise<void>((resolve) =>
          responseServer!.close(() => resolve()),
        );
      await responseDb?.end({ timeout: 5 });
      await admin.unsafe(`DROP DATABASE "${databaseName}"`);
      await admin.end({ timeout: 5 });
      await rm(root, { recursive: true, force: true });
    }
  });

  it('GET /v1/scans/:id/projects/:projectId/symbols pages in stable order', async () => {
    const base = `/v1/scans/${context.scanId}/projects/${encodeURIComponent(context.projectId)}/symbols`,
      first = await success(
        'GET /v1/scans/:id/projects/:projectId/symbols',
        `${base}?query=pageSymbol&offset=0`,
      ),
      second = await success(
        'GET /v1/scans/:id/projects/:projectId/symbols',
        `${base}?query=pageSymbol&offset=50`,
      ),
      firstItems = first.items as { name: string }[],
      secondItems = second.items as { name: string }[];
    expect(first.total).toBe(51);
    expect(firstItems).toHaveLength(50);
    expect(first.nextOffset).toBe(50);
    expect(secondItems).toHaveLength(1);
    expect(second.nextOffset).toBeNull();
    expect([...firstItems, ...secondItems].map((item) => item.name)).toEqual(
      Array.from(
        { length: 51 },
        (_, index) => `pageSymbol${String(index).padStart(3, '0')}`,
      ),
    );
  });

  it('rejects malformed public responses in negative controls', () => {
    expect(
      backendApiResponseSchemas['GET /v1/health'].safeParse({
        api: 'ready',
        database: 'ready',
        worker: 'ready',
        ready: false,
      }).success,
    ).toBe(false);
    expect(
      backendApiResponseSchemas['GET /v1/repositories/:id'].safeParse({
        id: randomUUID(),
        locator: 'C:/repo',
        desired_generation: '1',
        active_job_id: null,
        raw_database_column: 'must not leak',
      }).success,
    ).toBe(false);
    expect(() =>
      parseBackendResponse('GET /v1/repositories/:id', {
        id: randomUUID(),
        locator: 'C:/repo',
        desired_generation: '1',
      }),
    ).toThrow('Backend response failed its public contract');
  });
});
