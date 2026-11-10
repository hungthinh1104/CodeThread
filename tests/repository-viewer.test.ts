import { rm } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRepositoryViewer } from '../scripts/viewer.ts';
import type { ViewerHandle } from '../scripts/viewer.ts';
import { repositoryViewerFixture } from './helpers/repository-viewer.ts';

let data: Awaited<ReturnType<typeof repositoryViewerFixture>>,
  viewer: ViewerHandle;
const directories: string[] = [];
beforeAll(async () => {
  data = await repositoryViewerFixture(directories);
  viewer = await createRepositoryViewer(data.session);
}, 60000);
afterAll(async () => {
  await viewer?.close();
  for (const path of directories)
    await rm(path, { recursive: true, force: true });
});
async function post(path: string, body: unknown, headers = {}) {
  return fetch(viewer.origin + path, {
    method: 'POST',
    headers: {
      origin: viewer.origin,
      'x-codethread-token': new URL(viewer.url).hash.slice(1),
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
function project(label: string) {
  return data.session.projects.find(
    (item) => item.project.configPath === label,
  )!;
}
function scoped(id: string, request: unknown) {
  return { projectId: id, request };
}

describe('project-scoped repository viewer', () => {
  it('lists failed contexts and accounts for files with no declarations', async () => {
    const response = await post('/api/projects', {}),
      metadata = await response.json();
    expect(response.status).toBe(200);
    expect(metadata.mode).toBe('repository');
    expect(metadata.source).toMatchObject({
      files: 4,
      inventoryComplete: true,
      sourceCoverageComplete: false,
      analysisComplete: false,
      contextComplete: false,
    });
    expect(
      metadata.items.find(
        (item: { label: string }) =>
          item.label === 'projects/broken/tsconfig.json',
      ).status,
    ).toBe('failed');
    const files = await (await post('/api/files', {})).json();
    expect(
      files.items.find((item: { path: string }) => item.path === 'src/types.ts')
        .status,
    ).toBe('analyzed');
    expect(
      files.items.find(
        (item: { path: string }) => item.path === 'src/broken.ts',
      ).status,
    ).toBe('not_analyzed');
  });
  it('searches the entire catalog without collapsing contexts', async () => {
    const response = await post('/api/catalog', { query: 'target' }),
      catalog = await response.json();
    expect(response.status).toBe(200);
    expect(catalog.total).toBe(3);
    expect(
      new Set(
        catalog.items.map((item: { projectId: string }) => item.projectId),
      ).size,
    ).toBe(3);
    expect(
      new Set(
        catalog.items.map((item: { snapshotId: string }) => item.snapshotId),
      ).size,
    ).toBe(3);
  });
  it('keeps repeated call occurrences and asks for an explicit declaration context', async () => {
    const a = project('projects/a/tsconfig.json'),
      snapshot = a.snapshot!,
      entry = snapshot.facts.symbols.find((symbol) => symbol.name === 'entry')!;
    const graph = await (
      await post(
        '/api/neighbors',
        scoped(a.project.id, {
          snapshotId: snapshot.facts.snapshotId,
          symbolId: entry.id,
          depth: 1,
          nodeLimit: 50,
          direction: 'outgoing',
          relationKinds: ['calls'],
        }),
      )
    ).json();
    expect(graph.projectId).toBe(a.project.id);
    expect(graph.result.graph.relations).toHaveLength(2);
    const target = snapshot.facts.symbols.find(
      (symbol) => symbol.name === 'target',
    )!;
    const follow = await (
      await post(
        '/api/follow-context',
        scoped(a.project.id, {
          snapshotId: snapshot.facts.snapshotId,
          symbolId: target.id,
        }),
      )
    ).json();
    expect(follow.requiresChoice).toBe(true);
    expect(
      follow.candidates.map(
        (item: { projectLabel: string }) => item.projectLabel,
      ),
    ).toEqual(['projects/b/tsconfig.json', 'projects/c/tsconfig.json']);
    const sharedDeclaration = project('projects/b/tsconfig.json'),
      sharedTarget = sharedDeclaration.snapshot!.facts.symbols.find(
        (symbol) => symbol.name === 'target',
      )!;
    const sharedFollow = await (
      await post(
        '/api/follow-context',
        scoped(sharedDeclaration.project.id, {
          snapshotId: sharedDeclaration.snapshot!.facts.snapshotId,
          symbolId: sharedTarget.id,
        }),
      )
    ).json();
    expect(sharedFollow.requiresChoice).toBe(true);
    expect(
      sharedFollow.candidates.map(
        (item: { projectLabel: string }) => item.projectLabel,
      ),
    ).toEqual(['projects/b/tsconfig.json', 'projects/c/tsconfig.json']);
    const destination = follow.candidates[0];
    const session = await (
      await post('/api/session', scoped(destination.projectId, {}))
    ).json();
    expect(session.result.snapshotId).toBe(destination.snapshotId);
  });
  it('rejects swapped context IDs, snapshot IDs and failed contexts', async () => {
    const a = project('projects/a/tsconfig.json'),
      b = project('projects/b/tsconfig.json');
    const request = {
      snapshotId: a.snapshot!.facts.snapshotId,
      symbolId: a.snapshot!.facts.symbols.find(
        (symbol) => symbol.name === 'entry',
      )!.id,
      depth: 1,
      nodeLimit: 50,
      direction: 'outgoing',
      relationKinds: ['calls'],
    };
    expect(
      (await post('/api/neighbors', scoped(b.project.id, request))).status,
    ).toBe(404);
    expect((await post('/api/session', {})).status).toBe(400);
    expect((await post('/api/session', scoped('missing', {}))).status).toBe(
      404,
    );
    expect(
      (
        await post(
          '/api/session',
          scoped(project('projects/broken/tsconfig.json').project.id, {}),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await post(
          '/api/follow-context',
          scoped(b.project.id, {
            snapshotId: a.snapshot!.facts.snapshotId,
            symbolId: request.symbolId,
          }),
        )
      ).status,
    ).toBe(404);
  });
  it.each(['/api/projects', '/api/catalog', '/api/files'])(
    'retains origin, token and request bounds on %s',
    async (path) => {
      expect(
        (await post(path, {}, { origin: 'https://outside.invalid' })).status,
      ).toBe(403);
      expect(
        (await post(path, {}, { 'x-codethread-token': 'wrong' })).status,
      ).toBe(403);
      expect((await post(path, { unexpected: true })).status).toBe(400);
      expect((await post(path, { query: 'x'.repeat(70000) })).status).toBe(413);
    },
  );
});
