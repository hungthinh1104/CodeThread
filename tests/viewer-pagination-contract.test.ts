import { rm } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRepositoryViewer } from '../scripts/viewer.ts';
import type { ViewerHandle } from '../scripts/viewer.ts';
import { repositoryViewerFixture } from './helpers/repository-viewer.ts';

const directories: string[] = [],
  additionalSources = Array.from({ length: 51 }, (_, index) => {
    const number = String(index).padStart(3, '0');
    return {
      path: `paged/extra-${number}.ts`,
      source: `export function pageSymbol${number}() { return ${index}; }`,
    };
  });
let fixture: Awaited<ReturnType<typeof repositoryViewerFixture>>,
  viewer: ViewerHandle;

async function post(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(viewer.origin + path, {
      method: 'POST',
      headers: {
        origin: viewer.origin,
        'x-codethread-token': new URL(viewer.url).hash.slice(1),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
    text = await response.text();
  expect(response.status, text).toBe(200);
  return JSON.parse(text) as unknown;
}

describe('repository viewer HTTP pagination contracts', () => {
  // Setting up the fixture scans a pinned Git repository before serving pages.
  beforeAll(async () => {
    fixture = await repositoryViewerFixture(directories, additionalSources);
    viewer = await createRepositoryViewer(fixture.session);
  }, 30_000);

  afterAll(async () => {
    await viewer?.close();
    await Promise.all(
      directories.map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it('returns ordered first and second pages with exact continuations', async () => {
    const catalogFirst = (await post('/api/catalog', {
        query: 'pageSymbol',
        offset: 0,
      })) as {
        total: number;
        nextOffset: number | null;
        items: { symbol: { name: string } }[];
      },
      catalogSecond = (await post('/api/catalog', {
        query: 'pageSymbol',
        offset: 50,
      })) as typeof catalogFirst;
    expect(catalogFirst.total).toBe(51);
    expect(catalogFirst.items).toHaveLength(50);
    expect(catalogFirst.nextOffset).toBe(50);
    expect(catalogSecond.items).toHaveLength(1);
    expect(catalogSecond.nextOffset).toBeNull();
    expect(
      [...catalogFirst.items, ...catalogSecond.items].map(
        (item) => item.symbol.name,
      ),
    ).toEqual(
      additionalSources.map(
        (_, index) => `pageSymbol${String(index).padStart(3, '0')}`,
      ),
    );

    const filesFirst = (await post('/api/files', { offset: 0 })) as {
        total: number;
        nextOffset: number | null;
        items: { path: string }[];
      },
      filesSecond = (await post('/api/files', {
        offset: 50,
      })) as typeof filesFirst,
      filePaths = [...filesFirst.items, ...filesSecond.items].map(
        (item) => item.path,
      );
    expect(filesFirst.total).toBeGreaterThan(50);
    expect(filesFirst.items).toHaveLength(50);
    expect(filesFirst.nextOffset).toBe(50);
    expect(filesSecond.items).toHaveLength(filesFirst.total - 50);
    expect(filesSecond.nextOffset).toBeNull();
    expect(filePaths).toEqual([...filePaths].sort());
    expect(new Set(filePaths).size).toBe(filesFirst.total);

    const owner = fixture.session.projects.find((candidate) =>
        candidate.snapshot?.facts.symbols.some((symbol) =>
          symbol.name.startsWith('pageSymbol'),
        ),
      ),
      projectId = owner?.project.id;
    expect(projectId).toBeDefined();
    const firstSymbols = (await post('/api/symbols', {
        projectId,
        request: { query: 'pageSymbol', offset: 0 },
      })) as {
        result: {
          total: number;
          nextOffset: number | null;
          items: { name: string }[];
        };
      },
      secondSymbols = (await post('/api/symbols', {
        projectId,
        request: { query: 'pageSymbol', offset: 50 },
      })) as typeof firstSymbols;
    expect(firstSymbols.result.total).toBe(51);
    expect(firstSymbols.result.items).toHaveLength(50);
    expect(firstSymbols.result.nextOffset).toBe(50);
    expect(secondSymbols.result.items).toHaveLength(1);
    expect(secondSymbols.result.nextOffset).toBeNull();
    expect(
      [...firstSymbols.result.items, ...secondSymbols.result.items].map(
        (symbol) => symbol.name,
      ),
    ).toEqual(
      additionalSources.map(
        (_, index) => `pageSymbol${String(index).padStart(3, '0')}`,
      ),
    );
  });
});
