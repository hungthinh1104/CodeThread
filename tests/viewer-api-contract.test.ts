import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRepositoryViewer } from '../scripts/viewer.ts';
import type { ViewerHandle } from '../scripts/viewer.ts';
import { viewerApiResponseSchemas } from '../scripts/viewer-api.ts';
import { repositoryViewerFixture } from './helpers/repository-viewer.ts';
import { runGitFixture } from './helpers/git-fixture.ts';

type ViewerApiPath = keyof typeof viewerApiResponseSchemas;
type ViewerApiCase = {
  route: ViewerApiPath;
  positive: () => Promise<void>;
  negative: () => Promise<void>;
};
type StaticAsset = {
  route: string;
  file: string;
  mediaType: string;
};

let fixture: Awaited<ReturnType<typeof repositoryViewerFixture>>,
  viewer: ViewerHandle;
const temporaryDirectories: string[] = [];

function project(configPath: string) {
  const item = fixture.session.projects.find(
    (candidate) => candidate.project.configPath === configPath,
  );
  if (!item?.snapshot) throw new Error(`Missing fixture project ${configPath}`);
  return item;
}
function selectedDeclaration(projectConfig: string, name: string) {
  const owner = project(projectConfig),
    symbol = owner.snapshot!.facts.symbols.find((item) => item.name === name);
  if (!symbol) throw new Error(`Missing fixture declaration ${name}`);
  return { owner, symbol };
}
function scoped(projectId: string, request: unknown) {
  return { projectId, request };
}
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
async function success(path: ViewerApiPath, body: unknown): Promise<unknown> {
  const response = await post(path, body);
  const text = await response.text();
  expect(response.status, text).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/json');
  const value: unknown = JSON.parse(text);
  expect(viewerApiResponseSchemas[path].parse(value)).toEqual(value);
  return value;
}
async function failure(
  path: ViewerApiPath,
  body: unknown,
  status: number,
  code: string,
): Promise<void> {
  const response = await post(path, body);
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(await response.json()).toMatchObject({ error: { code } });
}

const viewerApiContractCases: readonly ViewerApiCase[] = [
  {
    route: '/api/projects',
    positive: async () => {
      const body = await success('/api/projects', {});
      expect(body).toMatchObject({
        mode: 'repository',
        repositoryId: fixture.session.repositoryId,
        commitId: fixture.session.commitId,
        source: { inventoryComplete: true },
      });
    },
    negative: async () => {
      await failure('/api/projects', undefined, 400, 'INVALID_REQUEST');
      await failure('/api/projects', null, 400, 'INVALID_REQUEST');
      await failure(
        '/api/projects',
        { unexpected: true },
        400,
        'INVALID_REQUEST',
      );
    },
  },
  {
    route: '/api/catalog',
    positive: async () => {
      const body = (await success('/api/catalog', { query: 'target' })) as {
        total: number;
        items: { projectId: string; snapshotId: string }[];
      };
      expect(body.total).toBe(3);
      expect(new Set(body.items.map((item) => item.projectId)).size).toBe(3);
      expect(new Set(body.items.map((item) => item.snapshotId)).size).toBe(3);
    },
    negative: async () => {
      await failure('/api/catalog', { query: null }, 400, 'INVALID_REQUEST');
      await failure('/api/catalog', { offset: null }, 400, 'INVALID_REQUEST');
      await failure(
        '/api/catalog',
        { query: 'target', unexpected: true },
        400,
        'INVALID_REQUEST',
      );
      await failure(
        '/api/catalog',
        { query: 'x'.repeat(257) },
        400,
        'INVALID_REQUEST',
      );
      await failure('/api/catalog', { offset: 640001 }, 400, 'INVALID_REQUEST');
    },
  },
  {
    route: '/api/files',
    positive: async () => {
      const body = (await success('/api/files', {})) as {
        total: number;
        items: {
          path: string;
          sha256: string | null;
          blobId?: string;
          status: string;
        }[];
      };
      expect(body.total).toBe(5);
      const entry = body.items.find((item) => item.path === 'src/entry.ts'),
        expectedBlob = (
          await runGitFixture(fixture.repository.directory, [
            'rev-parse',
            'HEAD:src/entry.ts',
          ])
        ).trim();
      expect(entry).toMatchObject({
        status: 'analyzed',
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        blobId: expectedBlob,
      });
      expect(
        body.items.find((item) => item.path === 'src/linked.ts'),
      ).toMatchObject({
        status: 'excluded',
        sha256: null,
      });
    },
    negative: async () => {
      await failure('/api/files', { offset: null }, 400, 'INVALID_REQUEST');
      await failure(
        '/api/files',
        { offset: 1, unexpected: true },
        400,
        'INVALID_REQUEST',
      );
      await failure('/api/files', { offset: 2001 }, 400, 'INVALID_REQUEST');
      await failure('/api/files', { offset: -1 }, 400, 'INVALID_REQUEST');
    },
  },
  {
    route: '/api/follow-context',
    positive: async () => {
      const { owner, symbol } = selectedDeclaration(
        'projects/a/tsconfig.json',
        'entry',
      );
      const body = (await success(
        '/api/follow-context',
        scoped(owner.project.id, {
          snapshotId: owner.snapshot!.facts.snapshotId,
          symbolId: symbol.id,
        }),
      )) as { projectId: string; snapshotId: string; symbolId: string };
      expect(body).toEqual({
        projectId: owner.project.id,
        snapshotId: owner.snapshot!.facts.snapshotId,
        symbolId: symbol.id,
        requiresChoice: false,
        candidates: [
          expect.objectContaining({
            projectId: owner.project.id,
            snapshotId: owner.snapshot!.facts.snapshotId,
            symbolId: symbol.id,
          }),
        ],
      });
    },
    negative: async () => {
      const { owner, symbol } = selectedDeclaration(
        'projects/a/tsconfig.json',
        'entry',
      );
      await failure('/api/follow-context', null, 400, 'INVALID_REQUEST');
      await failure(
        '/api/follow-context',
        { projectId: owner.project.id },
        400,
        'INVALID_REQUEST',
      );
      await failure(
        '/api/follow-context',
        scoped(owner.project.id, { symbolId: symbol.id }),
        400,
        'INVALID_REQUEST',
      );
      await failure(
        '/api/follow-context',
        scoped(owner.project.id, {
          snapshotId: owner.snapshot!.facts.snapshotId,
          symbolId: null,
        }),
        400,
        'INVALID_REQUEST',
      );
      await failure(
        '/api/follow-context',
        scoped(owner.project.id, {
          snapshotId: owner.snapshot!.facts.snapshotId,
          symbolId: symbol.id,
          extra: true,
        }),
        400,
        'INVALID_REQUEST',
      );
      await failure(
        '/api/follow-context',
        scoped(owner.project.id, {
          snapshotId: '00000000-0000-4000-8000-000000000001',
          symbolId: symbol.id,
        }),
        404,
        'SNAPSHOT_NOT_FOUND',
      );
    },
  },
  {
    route: '/api/session',
    positive: async () => {
      const { owner } = selectedDeclaration(
        'projects/a/tsconfig.json',
        'entry',
      );
      const body = (await success(
        '/api/session',
        scoped(owner.project.id, {}),
      )) as {
        projectId: string;
        result: { snapshotId: string };
      };
      expect(body.projectId).toBe(owner.project.id);
      expect(body.result.snapshotId).toBe(owner.snapshot!.facts.snapshotId);
    },
    negative: async () => {
      await failure('/api/session', undefined, 400, 'INVALID_REQUEST');
      await failure('/api/session', null, 400, 'INVALID_REQUEST');
      const { owner } = selectedDeclaration(
        'projects/a/tsconfig.json',
        'entry',
      );
      await failure(
        '/api/session',
        { projectId: owner.project.id },
        400,
        'INVALID_REQUEST',
      );
      await failure(
        '/api/session',
        scoped(owner.project.id, null),
        400,
        'INVALID_REQUEST',
      );
      await failure(
        '/api/session',
        scoped(owner.project.id, { unexpected: true }),
        400,
        'INVALID_REQUEST',
      );
      await failure(
        '/api/session',
        scoped('missing-project', {}),
        404,
        'ENTITY_NOT_FOUND',
      );
    },
  },
  {
    route: '/api/symbols',
    positive: async () => {
      const { owner } = selectedDeclaration(
        'projects/a/tsconfig.json',
        'entry',
      );
      const body = (await success(
        '/api/symbols',
        scoped(owner.project.id, { query: 'entry', offset: 0 }),
      )) as { projectId: string; result: { items: { name: string }[] } };
      expect(body.projectId).toBe(owner.project.id);
      expect(body.result.items.map((item) => item.name)).toContain('entry');
    },
    negative: async () => {
      const { owner } = selectedDeclaration(
        'projects/a/tsconfig.json',
        'entry',
      );
      await failure('/api/symbols', undefined, 400, 'INVALID_REQUEST');
      await failure('/api/symbols', null, 400, 'INVALID_REQUEST');
      await failure(
        '/api/symbols',
        scoped(owner.project.id, { query: null }),
        400,
        'INVALID_REQUEST',
      );
      await failure(
        '/api/symbols',
        scoped(owner.project.id, { query: '', offset: null }),
        400,
        'INVALID_REQUEST',
      );
      await failure(
        '/api/symbols',
        scoped(owner.project.id, { query: '', extra: true }),
        400,
        'INVALID_REQUEST',
      );
      await failure(
        '/api/symbols',
        scoped(owner.project.id, { query: '', offset: 20001 }),
        400,
        'INVALID_REQUEST',
      );
    },
  },
  {
    route: '/api/neighbors',
    positive: async () => {
      const { owner, symbol } = selectedDeclaration(
        'projects/a/tsconfig.json',
        'entry',
      );
      const body = (await success(
        '/api/neighbors',
        scoped(owner.project.id, {
          snapshotId: owner.snapshot!.facts.snapshotId,
          symbolId: symbol.id,
          direction: 'outgoing',
          relationKinds: ['calls'],
          depth: 1,
          nodeLimit: 20,
        }),
      )) as { projectId: string; result: { graph: { rootSymbolId: string } } };
      expect(body.projectId).toBe(owner.project.id);
      expect(body.result.graph.rootSymbolId).toBe(symbol.id);
    },
    negative: async () => {
      const { owner, symbol } = selectedDeclaration(
        'projects/a/tsconfig.json',
        'entry',
      );
      await failure('/api/neighbors', undefined, 400, 'INVALID_REQUEST');
      await failure('/api/neighbors', null, 400, 'INVALID_REQUEST');
      await failure(
        '/api/neighbors',
        scoped(owner.project.id, null),
        400,
        'INVALID_REQUEST',
      );
      await failure(
        '/api/neighbors',
        scoped(owner.project.id, {
          snapshotId: owner.snapshot!.facts.snapshotId,
        }),
        400,
        'INVALID_REQUEST',
      );
      await failure(
        '/api/neighbors',
        scoped(owner.project.id, {
          snapshotId: null,
          symbolId: symbol.id,
        }),
        400,
        'INVALID_REQUEST',
      );
      await failure(
        '/api/neighbors',
        scoped(owner.project.id, {
          snapshotId: owner.snapshot!.facts.snapshotId,
          symbolId: null,
        }),
        400,
        'INVALID_REQUEST',
      );
      await failure(
        '/api/neighbors',
        scoped(owner.project.id, {
          snapshotId: owner.snapshot!.facts.snapshotId,
          symbolId: symbol.id,
          unexpected: true,
        }),
        400,
        'INVALID_REQUEST',
      );
      await failure(
        '/api/neighbors',
        scoped(owner.project.id, {
          snapshotId: owner.snapshot!.facts.snapshotId,
          symbolId: symbol.id,
          depth: 3,
        }),
        400,
        'INVALID_REQUEST',
      );
    },
  },
  {
    route: '/api/evidence',
    positive: async () => {
      const { owner, symbol } = selectedDeclaration(
        'projects/a/tsconfig.json',
        'entry',
      );
      const body = (await success(
        '/api/evidence',
        scoped(owner.project.id, {
          snapshotId: owner.snapshot!.facts.snapshotId,
          evidenceIds: [symbol.declarationEvidenceId],
        }),
      )) as {
        projectId: string;
        result: { items: { status: string; text?: string }[] };
      };
      expect(body.projectId).toBe(owner.project.id);
      expect(body.result.items[0]).toMatchObject({
        status: 'available',
        text: expect.stringContaining('function entry'),
      });
    },
    negative: async () => {
      const { owner, symbol } = selectedDeclaration(
        'projects/a/tsconfig.json',
        'entry',
      );
      await failure('/api/evidence', undefined, 400, 'INVALID_REQUEST');
      await failure('/api/evidence', null, 400, 'INVALID_REQUEST');
      await failure(
        '/api/evidence',
        scoped(owner.project.id, {
          snapshotId: owner.snapshot!.facts.snapshotId,
        }),
        400,
        'INVALID_REQUEST',
      );
      await failure(
        '/api/evidence',
        scoped(owner.project.id, {
          snapshotId: owner.snapshot!.facts.snapshotId,
          evidenceIds: null,
        }),
        400,
        'INVALID_REQUEST',
      );
      await failure(
        '/api/evidence',
        scoped(owner.project.id, {
          snapshotId: owner.snapshot!.facts.snapshotId,
          evidenceIds: [],
        }),
        400,
        'INVALID_REQUEST',
      );
      await failure(
        '/api/evidence',
        scoped(owner.project.id, {
          snapshotId: owner.snapshot!.facts.snapshotId,
          evidenceIds: [symbol.declarationEvidenceId],
          unexpected: true,
        }),
        400,
        'INVALID_REQUEST',
      );
      await failure(
        '/api/evidence',
        scoped(owner.project.id, {
          snapshotId: owner.snapshot!.facts.snapshotId,
          evidenceIds: [
            symbol.declarationEvidenceId,
            symbol.declarationEvidenceId,
          ],
        }),
        400,
        'INVALID_REQUEST',
      );
    },
  },
];

const staticViewerAssetCases: readonly StaticAsset[] = [
  { route: '/', file: '../scripts/viewer.html', mediaType: 'text/html' },
  {
    route: '/viewer.js',
    file: '../scripts/viewer.js',
    mediaType: 'text/javascript',
  },
  {
    route: '/viewer.css',
    file: '../scripts/viewer.css',
    mediaType: 'text/css',
  },
  {
    route: '/viewer-client/dom.js',
    file: '../scripts/viewer-client/dom.js',
    mediaType: 'text/javascript',
  },
  {
    route: '/viewer-client/projection.js',
    file: '../scripts/viewer-client/projection.js',
    mediaType: 'text/javascript',
  },
  {
    route: '/viewer-client/history.js',
    file: '../scripts/viewer-client/history.js',
    mediaType: 'text/javascript',
  },
  {
    route: '/viewer-client/repository.js',
    file: '../scripts/viewer-client/repository.js',
    mediaType: 'text/javascript',
  },
];

async function wrongHostStatus(path: string): Promise<number> {
  const url = new URL(viewer.origin);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: '127.0.0.1',
        port: Number(url.port),
        path,
        method: 'GET',
        headers: { host: 'attacker.invalid' },
      },
      (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode ?? 0));
      },
    );
    request.once('error', reject);
    request.end();
  });
}

describe('repository viewer HTTP contract matrix', () => {
  beforeAll(async () => {
    fixture = await repositoryViewerFixture(temporaryDirectories);
    viewer = await createRepositoryViewer(fixture.session);
  }, 120_000);
  afterAll(async () => {
    await viewer?.close();
    for (const path of temporaryDirectories)
      await rm(path, { recursive: true, force: true });
  });

  for (const testCase of viewerApiContractCases) {
    it(
      `${testCase.route} returns its valid public response`,
      testCase.positive,
    );
  }
  for (const testCase of viewerApiContractCases) {
    it(
      `${testCase.route} rejects its route-specific invalid request`,
      testCase.negative,
    );
  }

  it.each(staticViewerAssetCases)(
    'GET $route serves the exact local asset without an API token',
    async ({ route, file, mediaType }) => {
      const response = await fetch(viewer.origin + route);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain(mediaType);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(Buffer.from(await response.arrayBuffer())).toEqual(
        readFileSync(new URL(file, import.meta.url)),
      );
    },
  );

  it.each(staticViewerAssetCases)(
    'GET $route rejects a non-loopback Host',
    async ({ route }) => {
      expect(await wrongHostStatus(route)).toBe(403);
    },
  );

  it('enforces viewer token, same-origin, method, and byte limits in the shared API handler', async () => {
    const noToken = await fetch(viewer.origin + '/api/projects', {
      method: 'POST',
      headers: { origin: viewer.origin, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(noToken.status).toBe(403);
    expect(await noToken.json()).toMatchObject({
      error: { code: 'FORBIDDEN' },
    });
    const unexpectedQuery = await post('/api/projects?unexpected=1', {});
    expect(unexpectedQuery.status).toBe(400);
    expect(await unexpectedQuery.json()).toMatchObject({
      error: { code: 'INVALID_REQUEST' },
    });
    const invalidToken = await fetch(viewer.origin + '/api/projects', {
      method: 'POST',
      headers: {
        origin: viewer.origin,
        'x-codethread-token': 'invalid-token',
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(invalidToken.status).toBe(403);
    expect(await invalidToken.json()).toMatchObject({
      error: { code: 'FORBIDDEN' },
    });
    const badOrigin = await fetch(viewer.origin + '/api/projects', {
      method: 'POST',
      headers: {
        origin: 'https://attacker.invalid',
        'x-codethread-token': token(),
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(badOrigin.status).toBe(403);
    const oversized = await post('/api/projects', {
      padding: 'x'.repeat(65_536),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({
      error: { code: 'REQUEST_TOO_LARGE' },
    });
    const wrongMethod = await fetch(viewer.origin + '/api/projects', {
      headers: { origin: viewer.origin, 'x-codethread-token': token() },
    });
    expect(wrongMethod.status).toBe(405);
  });
});
