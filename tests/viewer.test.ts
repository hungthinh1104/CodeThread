import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { describe, expect, it } from 'vitest';
import { COMPILER_PROFILE, analyzeManifest } from '@codethread/symbol-indexer';
import type { AnalysisSnapshot } from '@codethread/symbol-indexer';
import { loadExternalCorpus } from '../scripts/external-semantic-corpus.ts';
import { createViewer } from '../scripts/viewer.ts';

const repositoryId = '00000000-0000-4000-8000-000000000019';
let tinySnapshot: Promise<AnalysisSnapshot> | undefined;

function loadTinySnapshot(): Promise<AnalysisSnapshot> {
  tinySnapshot ??= loadExternalCorpus('tinyexec').then(({ files }) =>
    analyzeManifest({
      repositoryId,
      compilerOptions: COMPILER_PROFILE,
      files,
    }),
  );
  return tinySnapshot;
}

function tokenFor(url: string): string {
  const token = new URL(url).hash.slice(1);
  if (!/^[a-f0-9]{64}$/i.test(token)) throw new Error('Missing viewer token');
  return token;
}

function request(
  origin: string,
  token: string,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
) {
  return fetch(`${origin}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      origin,
      'x-codethread-token': token,
      ...(options.body === undefined
        ? {}
        : { 'content-type': 'application/json' }),
      ...options.headers,
    },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
}

function wrongHostRequest(origin: string, token: string): Promise<number> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: '127.0.0.1',
        port: Number(url.port),
        path: '/api/session',
        method: 'GET',
        headers: {
          host: 'evil.example',
          origin,
          'x-codethread-token': token,
        },
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

describe('CT-VIEW-001 loopback viewer', () => {
  it('binds to loopback, protects its API, and returns contract-validated projections', async () => {
    const snapshot = await loadTinySnapshot();
    const viewer = await createViewer(snapshot);
    const token = tokenFor(viewer.url);
    try {
      const page = await fetch(viewer.origin);
      const html = await page.text();
      expect(page.status).toBe(200);
      expect(page.headers.get('content-security-policy')).toContain(
        "default-src 'none'",
      );
      expect(page.headers.get('referrer-policy')).toBe('no-referrer');
      expect(html).not.toContain(token);
      expect(html).toContain('/viewer.js');

      expect(await wrongHostRequest(viewer.origin, token)).toBe(403);
      const wrongOrigin = await request(viewer.origin, token, '/api/session', {
        method: 'POST',
        body: {},
        headers: { origin: 'https://attacker.invalid' },
      });
      expect(wrongOrigin.status).toBe(403);
      const wrongToken = await request(
        viewer.origin,
        '0'.repeat(64),
        '/api/session',
        { method: 'POST', body: {} },
      );
      expect(wrongToken.status).toBe(403);

      const session = await request(viewer.origin, token, '/api/session', {
        method: 'POST',
        body: {},
      });
      expect(session.status).toBe(200);
      const search = await request(viewer.origin, token, '/api/symbols', {
        method: 'POST',
        body: { query: 'computeEnv', offset: 0 },
      });
      const symbols = (await search.json()) as {
        items: { id: string; name: string }[];
      };
      const root = symbols.items.find((symbol) => symbol.name === 'computeEnv');
      expect(root).toBeDefined();
      if (!root)
        throw new Error('Pinned tinyexec computeEnv symbol is missing.');
      const snapshotId = snapshot.facts.snapshotId;
      const graphResponse = await request(
        viewer.origin,
        token,
        '/api/neighbors',
        {
          method: 'POST',
          body: {
            snapshotId,
            symbolId: root.id,
            direction: 'outgoing',
            relationKinds: ['calls'],
            depth: 1,
            nodeLimit: 20,
          },
        },
      );
      expect(graphResponse.status).toBe(200);
      const projection = (await graphResponse.json()) as {
        graph: {
          relations: {
            kind: string;
            siteEvidenceId: string;
            resolution: { status: string; targetId: string | null };
          }[];
          symbols: { id: string; name: string }[];
        };
      };
      const call = projection.graph.relations.find(
        (relation) =>
          relation.kind === 'calls' && relation.resolution.status === 'exact',
      );
      expect(call).toBeDefined();
      if (!call)
        throw new Error('Pinned exact getPathFromEnv call is missing.');
      expect(
        projection.graph.symbols.find(
          (symbol) => symbol.id === call.resolution.targetId,
        )?.name,
      ).toBe('getPathFromEnv');

      const evidence = await request(viewer.origin, token, '/api/evidence', {
        method: 'POST',
        body: { snapshotId, evidenceIds: [call.siteEvidenceId] },
      });
      expect(evidence.status).toBe(200);
      const evidenceResult = (await evidence.json()) as {
        items: {
          status: string;
          text?: string;
          evidence?: { contentHash: string };
        }[];
      };
      expect(evidenceResult.items[0]).toMatchObject({
        status: 'available',
        evidence: { contentHash: expect.any(String) },
      });
      expect(evidenceResult.items[0]?.text).toContain(
        'getPathFromEnv(envWithDefault)',
      );

      const unselectedKind = await request(
        viewer.origin,
        token,
        '/api/neighbors',
        {
          method: 'POST',
          body: {
            snapshotId,
            symbolId: root.id,
            direction: 'outgoing',
            relationKinds: ['constructs'],
            depth: 1,
            nodeLimit: 20,
          },
        },
      );
      expect(unselectedKind.status).toBe(400);
      expect(await unselectedKind.json()).toMatchObject({
        error: { code: 'INVALID_REQUEST' },
      });
    } finally {
      await viewer.close();
    }
  });

  it('rejects oversized request bodies and retains malformed input as a typed error', async () => {
    const viewer = await createViewer(await loadTinySnapshot());
    const token = tokenFor(viewer.url);
    try {
      const oversized = await request(viewer.origin, token, '/api/symbols', {
        method: 'POST',
        body: { query: 'x'.repeat(70 * 1024), offset: 0 },
      });
      expect(oversized.status).toBe(413);
      expect(await oversized.json()).toMatchObject({
        error: { code: 'REQUEST_TOO_LARGE' },
      });
      const invalid = await request(viewer.origin, token, '/api/symbols', {
        method: 'POST',
        body: { query: 'x', offset: -1 },
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({
        error: { code: 'INVALID_REQUEST' },
      });
      const missing = await request(viewer.origin, token, '/api/neighbors', {
        method: 'POST',
        body: {
          snapshotId: '00000000-0000-4000-8000-000000000099',
          symbolId: '00000000-0000-4000-8000-000000000098',
          direction: 'outgoing',
          relationKinds: ['calls'],
          depth: 1,
          nodeLimit: 20,
        },
      });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({
        error: { code: 'SNAPSHOT_NOT_FOUND' },
      });
    } finally {
      await viewer.close();
    }
  });

  it('keeps exact source evidence bound to the analysis source hash', async () => {
    const bytes = Buffer.from(
      'export function sample() { return "<script>bad()</script>"; }\r\n',
      'utf8',
    );
    const snapshot = await analyzeManifest({
      repositoryId,
      compilerOptions: COMPILER_PROFILE,
      files: [
        {
          path: 'src/sample.ts',
          bytes,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    });
    const viewer = await createViewer(snapshot);
    const token = tokenFor(viewer.url);
    try {
      const search = await request(viewer.origin, token, '/api/symbols', {
        method: 'POST',
        body: { query: 'sample', offset: 0 },
      });
      const result = (await search.json()) as {
        items: { declarationEvidenceId: string }[];
      };
      const evidence = await request(viewer.origin, token, '/api/evidence', {
        method: 'POST',
        body: {
          snapshotId: snapshot.facts.snapshotId,
          evidenceIds: [result.items[0]!.declarationEvidenceId],
        },
      });
      const evidenceResult = (await evidence.json()) as {
        items: { status: string; text?: string }[];
      };
      expect(evidenceResult.items[0]).toMatchObject({ status: 'available' });
      expect(evidenceResult.items[0]?.text).toContain('<script>bad()</script>');
      const retained = snapshot.source.readFile(snapshot.facts.files[0]!.id);
      expect(retained).not.toBeNull();
      if (!retained)
        throw new Error('Verified retained source is unavailable.');
      expect([...retained]).toEqual([...bytes]);
    } finally {
      await viewer.close();
    }
  });

  it('returns a typed failure when a valid evidence batch exceeds the response budget', async () => {
    const files = Array.from({ length: 20 }, (_, index) => {
      const source = `export function sample${String(index).padStart(2, '0')}() { return "${'x'.repeat(60000)}"; }\n`;
      const bytes = Buffer.from(source, 'utf8');
      return {
        path: `src/file-${String(index).padStart(2, '0')}.ts`,
        bytes,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    });
    const snapshot = await analyzeManifest({
      repositoryId,
      compilerOptions: COMPILER_PROFILE,
      files,
    });
    const viewer = await createViewer(snapshot);
    const token = tokenFor(viewer.url);
    try {
      const search = await request(viewer.origin, token, '/api/symbols', {
        method: 'POST',
        body: { query: '', offset: 0 },
      });
      const symbols = (await search.json()) as {
        items: { declarationEvidenceId: string }[];
      };
      const evidence = await request(viewer.origin, token, '/api/evidence', {
        method: 'POST',
        body: {
          snapshotId: snapshot.facts.snapshotId,
          evidenceIds: symbols.items
            .slice(0, 18)
            .map((symbol) => symbol.declarationEvidenceId),
        },
      });
      expect(evidence.status).toBe(413);
      expect(await evidence.json()).toMatchObject({
        error: { code: 'RESPONSE_TOO_LARGE' },
      });
    } finally {
      await viewer.close();
    }
  });
});
