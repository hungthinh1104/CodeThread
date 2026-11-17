import { rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createViewer } from '../scripts/viewer.ts';
import type { ViewerHandle } from '../scripts/viewer.ts';
import { viewerApiResponseSchemas } from '../scripts/viewer-api.ts';
import { repositoryViewerFixture } from './helpers/repository-viewer.ts';

type Route = keyof typeof viewerApiResponseSchemas;
type SelectedCase = {
  route: Route;
  body: () => unknown;
  assert: (response: unknown) => void;
  invalidInputs: () => readonly {
    name: string;
    body: unknown;
    status: number;
    code: string;
  }[];
};

let fixture: Awaited<ReturnType<typeof repositoryViewerFixture>>,
  viewer: ViewerHandle,
  snapshotId = '',
  symbolId = '',
  evidenceId = '';
const temporaryDirectories: string[] = [];

function token(): string {
  return new URL(viewer.url).hash.slice(1);
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(viewer.origin + path, {
    method: 'POST',
    headers: {
      origin: viewer.origin,
      'x-codethread-token': token(),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function success(route: Route, body: unknown): Promise<unknown> {
  const response = await post(route, body),
    text = await response.text();
  expect(response.status, text).toBe(200);
  const value: unknown = JSON.parse(text);
  expect(viewerApiResponseSchemas[route].parse(value)).toEqual(value);
  return value;
}

async function failure(
  route: Route,
  body: unknown,
  status: number,
  code: string,
  name: string,
): Promise<void> {
  const response = await post(route, body);
  const payload: unknown = await response.json();
  expect(response.status, `${name}: ${JSON.stringify(payload)}`).toBe(status);
  expect(payload).toMatchObject({ error: { code } });
}

async function rawHttp(
  path: string,
  body: Buffer,
): Promise<{ status: number; body: unknown }> {
  const url = new URL(viewer.origin);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: '127.0.0.1',
        port: Number(url.port),
        path,
        method: 'POST',
        headers: {
          origin: viewer.origin,
          'x-codethread-token': token(),
          'content-type': 'application/json',
          'content-length': String(body.byteLength),
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
    request.write(body);
    request.end();
  });
}

const cases: readonly SelectedCase[] = [
  {
    route: '/api/projects',
    body: () => ({}),
    assert: (response) =>
      expect(response).toMatchObject({
        mode: 'selected',
        initialProjectId: 'selected',
        commitId: null,
        source: null,
        items: [{ id: 'selected', status: 'ready' }],
      }),
    invalidInputs: () => [
      {
        name: 'missing body',
        body: undefined,
        status: 400,
        code: 'INVALID_REQUEST',
      },
      { name: 'null body', body: null, status: 400, code: 'INVALID_REQUEST' },
      {
        name: 'unexpected field',
        body: { unexpected: true },
        status: 400,
        code: 'INVALID_REQUEST',
      },
    ],
  },
  {
    route: '/api/catalog',
    body: () => ({}),
    assert: (response) => {
      const page = response as {
        total: number;
        items: { projectId: string }[];
      };
      expect(page.total).toBeGreaterThan(0);
      expect(page.items.every((item) => item.projectId === 'selected')).toBe(
        true,
      );
    },
    invalidInputs: () => [
      {
        name: 'null query',
        body: { query: null },
        status: 400,
        code: 'INVALID_REQUEST',
      },
      {
        name: 'null offset',
        body: { offset: null },
        status: 400,
        code: 'INVALID_REQUEST',
      },
      {
        name: 'unexpected field',
        body: { query: 'target', extra: true },
        status: 400,
        code: 'INVALID_REQUEST',
      },
      {
        name: 'offset above limit',
        body: { offset: 640001 },
        status: 400,
        code: 'INVALID_REQUEST',
      },
    ],
  },
  {
    route: '/api/files',
    body: () => ({}),
    assert: (response) => {
      const page = response as { items: { projectIds: string[] }[] };
      expect(page.items.length).toBeGreaterThan(0);
      expect(
        page.items.every((item) => item.projectIds.includes('selected')),
      ).toBe(true);
    },
    invalidInputs: () => [
      {
        name: 'null offset',
        body: { offset: null },
        status: 400,
        code: 'INVALID_REQUEST',
      },
      {
        name: 'unexpected field',
        body: { offset: 1, extra: true },
        status: 400,
        code: 'INVALID_REQUEST',
      },
      {
        name: 'offset above limit',
        body: { offset: 2001 },
        status: 400,
        code: 'INVALID_REQUEST',
      },
    ],
  },
  {
    route: '/api/follow-context',
    body: () => ({ snapshotId, symbolId }),
    assert: (response) =>
      expect(response).toMatchObject({
        projectId: 'selected',
        snapshotId,
        symbolId,
        requiresChoice: false,
        candidates: [{ projectId: 'selected', snapshotId, symbolId }],
      }),
    invalidInputs: () => [
      {
        name: 'missing body',
        body: undefined,
        status: 400,
        code: 'INVALID_REQUEST',
      },
      { name: 'null body', body: null, status: 400, code: 'INVALID_REQUEST' },
      {
        name: 'missing required fields',
        body: {},
        status: 400,
        code: 'INVALID_REQUEST',
      },
      {
        name: 'null snapshot',
        body: { snapshotId: null, symbolId },
        status: 400,
        code: 'INVALID_REQUEST',
      },
      {
        name: 'null symbol',
        body: { snapshotId, symbolId: null },
        status: 400,
        code: 'INVALID_REQUEST',
      },
      {
        name: 'unexpected field',
        body: { snapshotId, symbolId, extra: true },
        status: 400,
        code: 'INVALID_REQUEST',
      },
      {
        name: 'stale snapshot',
        body: { snapshotId: '11111111-1111-4111-8111-111111111111', symbolId },
        status: 404,
        code: 'SNAPSHOT_NOT_FOUND',
      },
    ],
  },
  {
    route: '/api/session',
    body: () => ({}),
    assert: (response) => expect(response).toMatchObject({ snapshotId }),
    invalidInputs: () => [
      {
        name: 'missing body',
        body: undefined,
        status: 400,
        code: 'INVALID_REQUEST',
      },
      { name: 'null body', body: null, status: 400, code: 'INVALID_REQUEST' },
      {
        name: 'unexpected field',
        body: { unexpected: true },
        status: 400,
        code: 'INVALID_REQUEST',
      },
    ],
  },
  {
    route: '/api/symbols',
    body: () => ({}),
    assert: (response) => {
      const page = response as {
        snapshotId: string;
        items: { name: string }[];
      };
      expect(page.snapshotId).toBe(snapshotId);
      expect(page.items.map((item) => item.name)).toContain('entry');
    },
    invalidInputs: () => [
      {
        name: 'null query',
        body: { query: null },
        status: 400,
        code: 'INVALID_REQUEST',
      },
      {
        name: 'null offset',
        body: { query: 'entry', offset: null },
        status: 400,
        code: 'INVALID_REQUEST',
      },
      {
        name: 'unexpected field',
        body: { query: 'entry', extra: true },
        status: 400,
        code: 'INVALID_REQUEST',
      },
      {
        name: 'offset above limit',
        body: { query: 'entry', offset: 20001 },
        status: 400,
        code: 'INVALID_REQUEST',
      },
    ],
  },
  {
    route: '/api/neighbors',
    body: () => ({
      snapshotId,
      symbolId,
      direction: 'outgoing',
      relationKinds: ['calls'],
      depth: 1,
      nodeLimit: 20,
    }),
    assert: (response) =>
      expect(response).toMatchObject({ graph: { rootSymbolId: symbolId } }),
    invalidInputs: () => [
      {
        name: 'missing body',
        body: undefined,
        status: 400,
        code: 'INVALID_REQUEST',
      },
      { name: 'null body', body: null, status: 400, code: 'INVALID_REQUEST' },
      {
        name: 'missing required symbol',
        body: { snapshotId },
        status: 400,
        code: 'INVALID_REQUEST',
      },
      {
        name: 'null snapshot',
        body: { snapshotId: null, symbolId },
        status: 400,
        code: 'INVALID_REQUEST',
      },
      {
        name: 'null symbol',
        body: { snapshotId, symbolId: null },
        status: 400,
        code: 'INVALID_REQUEST',
      },
      {
        name: 'unexpected field',
        body: { snapshotId, symbolId, extra: true },
        status: 400,
        code: 'INVALID_REQUEST',
      },
      {
        name: 'depth above limit',
        body: { snapshotId, symbolId, depth: 3 },
        status: 400,
        code: 'INVALID_REQUEST',
      },
    ],
  },
  {
    route: '/api/evidence',
    body: () => ({ snapshotId, evidenceIds: [evidenceId] }),
    assert: (response) =>
      expect(response).toMatchObject({
        items: [
          expect.objectContaining({
            status: 'available',
            text: expect.stringContaining('function entry'),
          }),
        ],
      }),
    invalidInputs: () => [
      {
        name: 'missing body',
        body: undefined,
        status: 400,
        code: 'INVALID_REQUEST',
      },
      { name: 'null body', body: null, status: 400, code: 'INVALID_REQUEST' },
      {
        name: 'missing evidence IDs',
        body: { snapshotId },
        status: 400,
        code: 'INVALID_REQUEST',
      },
      {
        name: 'null snapshot',
        body: { snapshotId: null, evidenceIds: [evidenceId] },
        status: 400,
        code: 'INVALID_REQUEST',
      },
      {
        name: 'null evidence IDs',
        body: { snapshotId, evidenceIds: null },
        status: 400,
        code: 'INVALID_REQUEST',
      },
      {
        name: 'empty evidence IDs',
        body: { snapshotId, evidenceIds: [] },
        status: 400,
        code: 'INVALID_REQUEST',
      },
      {
        name: 'duplicate evidence IDs',
        body: { snapshotId, evidenceIds: [evidenceId, evidenceId] },
        status: 400,
        code: 'INVALID_REQUEST',
      },
      {
        name: 'unexpected field',
        body: { snapshotId, evidenceIds: [evidenceId], extra: true },
        status: 400,
        code: 'INVALID_REQUEST',
      },
    ],
  },
];

describe('selected snapshot viewer API contracts', () => {
  beforeAll(async () => {
    fixture = await repositoryViewerFixture(temporaryDirectories);
    const project = fixture.session.projects.find(
        (item) => item.project.configPath === 'projects/a/tsconfig.json',
      ),
      snapshot = project?.snapshot,
      symbol = snapshot?.facts.symbols.find((item) => item.name === 'entry');
    if (!snapshot || !symbol)
      throw new Error('Selected viewer contract fixture is incomplete.');
    snapshotId = snapshot.facts.snapshotId;
    symbolId = symbol.id;
    evidenceId = symbol.declarationEvidenceId;
    viewer = await createViewer(snapshot);
  }, 120_000);

  afterAll(async () => {
    await viewer?.close();
    for (const path of temporaryDirectories)
      await rm(path, { recursive: true, force: true });
  });

  for (const testCase of cases) {
    it(`${testCase.route} validates selected-mode success`, async () => {
      testCase.assert(await success(testCase.route, testCase.body()));
    });
    it(`${testCase.route} rejects selected-mode invalid inputs`, async () => {
      const invalidInputs = testCase.invalidInputs();
      expect(invalidInputs.length).toBeGreaterThan(0);
      for (const invalid of invalidInputs)
        await failure(
          testCase.route,
          invalid.body,
          invalid.status,
          invalid.code,
          invalid.name,
        );
    });
  }

  it('rejects malformed UTF-8 bodies and percent-encoded API paths', async () => {
    const invalidJson = Buffer.from([
      0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d,
    ]);
    const badBody = await rawHttp('/api/projects', invalidJson);
    expect(badBody.status).toBe(400);
    expect(badBody.body).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    const badPath = await rawHttp('/api/%E0%A4%A', Buffer.from('{}'));
    expect(badPath.status).toBe(404);
    expect(badPath.body).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});
