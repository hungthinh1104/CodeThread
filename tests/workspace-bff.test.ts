import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  aiStatus,
  forwardViewerOperation,
  openWorkspace,
  parseRequestJson,
  synthesizeWorkspaceAi,
  WorkspaceBffError,
  workspaceMetadata,
} from '../packages/investigation-workspace/src/server/workspace-bff.ts';
import {
  sessionCookie,
  trustedLocalRequest,
} from '../packages/investigation-workspace/src/server/http.ts';
import { POST as workspaceOperation } from '../packages/investigation-workspace/src/app/api/workspace/[...path]/route.ts';

const scanId = '11111111-1111-4111-8111-111111111111';
const repositoryId = '22222222-2222-4222-8222-222222222222';
const commitId = 'a'.repeat(40);
const viewerToken = 'b'.repeat(64);

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function scanResponse() {
  const now = new Date().toISOString();
  return {
    id: scanId,
    repository_id: repositoryId,
    generation: '1',
    state: 'succeeded',
    attempt: 1,
    revision_selector: 'HEAD',
    git_commit_oid: commitId,
    git_tree_oid: null,
    activation_result: 'activated',
    error_code: null,
    error_message: null,
    created_at: now,
    updated_at: now,
  };
}

function projectsResponse() {
  return {
    mode: 'repository',
    initialProjectId: null,
    repositoryId,
    commitId,
    source: null,
    items: [],
  };
}

function backendAndViewerFetch(
  viewerResponse: unknown = projectsResponse(),
  viewerUrl = `http://127.0.0.1:43123/#${viewerToken}`,
) {
  const seen: { url: string; headers: Headers; body?: string }[] = [];
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === 'string' ? init.body : undefined;
      seen.push({ url, headers, ...(body === undefined ? {} : { body }) });
      if (url === `http://127.0.0.1:8765/v1/scans/${scanId}`)
        return json(scanResponse());
      if (url === `http://127.0.0.1:8765/v1/scans/${scanId}/viewer`)
        return json({
          url: viewerUrl,
          expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
        });
      if (url === 'http://127.0.0.1:43123/api/projects')
        return json(viewerResponse);
      return json({ error: { code: 'NOT_FOUND', message: 'Not found.' } }, 404);
    },
  );
  vi.stubGlobal('fetch', fetcher);
  return { fetcher, seen };
}

describe('local Investigation Workspace BFF', () => {
  beforeEach(() => {
    vi.stubEnv('CODETHREAD_API_TOKEN', 'server-only-test-token');
    vi.stubEnv('CODETHREAD_WORKSPACE_PORT', '3000');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('bounds concurrent new sessions and restores admission after failure and expiry', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 31 * 60_000);
    const { fetcher } = backendAndViewerFetch();
    const forward = fetcher.getMockImplementation()!;
    let release = () => {};
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    let scanReads = 0;
    const unavailable = () =>
      json(
        {
          error: { code: 'UNAVAILABLE', message: 'Fixture scan read failed.' },
        },
        503,
      );
    fetcher.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/scans/' + scanId)) {
        const read = ++scanReads;
        await stalled;
        if (read === 1) return unavailable();
      }
      return forward(input, init);
    });
    const pending = Promise.allSettled(
      Array.from({ length: 5 }, () => openWorkspace(scanId)),
    );
    try {
      release();
      const outcomes = await pending;
      expect(
        outcomes.filter(({ status }) => status === 'fulfilled'),
      ).toHaveLength(3);
      expect(outcomes[0]).toMatchObject({
        status: 'rejected',
        reason: { status: 503 },
      });
      expect(outcomes[4]).toMatchObject({
        status: 'rejected',
        reason: { status: 429, code: 'WORKSPACE_CAPACITY' },
      });
      expect(scanReads).toBe(4);
      await expect(openWorkspace(scanId)).resolves.toMatchObject({
        metadata: { scanId },
      });
      await expect(openWorkspace(scanId)).rejects.toMatchObject({
        status: 429,
      });
      clock.mockReturnValue(now + 62 * 60_000);
      await expect(openWorkspace(scanId)).resolves.toMatchObject({
        metadata: { scanId },
      });
    } finally {
      clock.mockReturnValue(now + 93 * 60_000);
      fetcher.mockImplementation(async () => unavailable());
      try {
        await openWorkspace(scanId);
      } catch {
        /* Cleanup leaves the registry empty. */
      }
      clock.mockRestore();
    }
  });

  it('keeps both upstream credentials server-side and validates each projection', async () => {
    const { seen } = backendAndViewerFetch();
    const opened = await openWorkspace(scanId);
    expect(JSON.stringify(opened)).not.toContain(viewerToken);
    expect(JSON.stringify(opened)).not.toContain('server-only-test-token');
    expect(opened.metadata.commitId).toBe(commitId);

    const result = await forwardViewerOperation(
      opened.sessionId,
      scanId,
      'projects',
      {},
    );
    expect(result).toEqual(projectsResponse());
    const backendRequest = seen.find((item) =>
      item.url.endsWith(`/scans/${scanId}`),
    );
    const viewerRequest = seen.find((item) =>
      item.url.endsWith('/api/projects'),
    );
    expect(backendRequest?.headers.get('authorization')).toBe(
      'Bearer server-only-test-token',
    );
    expect(viewerRequest?.headers.get('x-codethread-token')).toBe(viewerToken);
    expect(viewerRequest?.headers.get('origin')).toBe('http://127.0.0.1:43123');
    expect(viewerRequest?.headers.get('authorization')).toBeNull();
  });

  it('returns validated workspace metadata from the meta route', async () => {
    backendAndViewerFetch();
    const opened = await openWorkspace(scanId);
    const metadataRequest = (body: string) =>
      new Request('http://127.0.0.1:3000/api/workspace/meta', {
        method: 'POST',
        headers: {
          host: '127.0.0.1:3000',
          origin: 'http://127.0.0.1:3000',
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
          'x-codethread-scan-id': scanId,
          cookie: `ct_workspace_session_${scanId}=${opened.sessionId}`,
        },
        body,
      });
    const response = await workspaceOperation(metadataRequest('{}'), {
      params: Promise.resolve({ path: ['meta'] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ workspace: opened.metadata });

    const invalid = await workspaceOperation(
      metadataRequest('{"extra":true}'),
      {
        params: Promise.resolve({ path: ['meta'] }),
      },
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: { code: 'INVALID_REQUEST' },
    });
  });

  it('rejects a viewer address outside the exact IPv4 loopback origin', async () => {
    const { seen } = backendAndViewerFetch(
      projectsResponse(),
      `http://127.0.0.1.attacker.test:43123/#${viewerToken}`,
    );
    await expect(openWorkspace(scanId)).rejects.toMatchObject({
      code: 'VIEWER_ADDRESS_REJECTED',
    });
    expect(
      seen.every((item) => item.url.startsWith('http://127.0.0.1:8765/')),
    ).toBe(true);
  });

  it('accepts only the configured Host and same Origin for BFF mutations', () => {
    const trusted = new Request('http://127.0.0.1:3000/api/workspace/open', {
      method: 'POST',
      headers: {
        host: '127.0.0.1:3000',
        origin: 'http://127.0.0.1:3000',
        'sec-fetch-site': 'same-origin',
      },
    });
    const wrongHost = new Request('http://127.0.0.1:3000/api/workspace/open', {
      method: 'POST',
      headers: {
        host: 'localhost:3000',
        origin: 'http://127.0.0.1:3000',
      },
    });
    const wrongOrigin = new Request(
      'http://127.0.0.1:3000/api/workspace/open',
      {
        method: 'POST',
        headers: {
          host: '127.0.0.1:3000',
          origin: 'http://attacker.example',
        },
      },
    );
    expect(trustedLocalRequest(trusted, true)).toBe(true);
    expect(trustedLocalRequest(wrongHost, true)).toBe(false);
    expect(trustedLocalRequest(wrongOrigin, true)).toBe(false);
    const sameSite = new Request('http://127.0.0.1:3000/api/repositories', {
      method: 'GET',
      headers: {
        host: '127.0.0.1:3000',
        'sec-fetch-site': 'same-site',
      },
    });
    expect(trustedLocalRequest(sameSite, false)).toBe(false);
    vi.stubEnv('CODETHREAD_WORKSPACE_PORT', '80');
    const port80 = new Request('http://127.0.0.1/api/workspace/open', {
      method: 'POST',
      headers: {
        host: '127.0.0.1',
        origin: 'http://127.0.0.1',
        'sec-fetch-site': 'same-origin',
      },
    });
    expect(trustedLocalRequest(port80, true)).toBe(true);
    vi.stubEnv('CODETHREAD_WORKSPACE_PORT', '3000');
    expect(
      sessionCookie(
        scanId,
        'c'.repeat(64),
        new Date(Date.now() + 60_000).toISOString(),
      ),
    ).toMatch(/HttpOnly; SameSite=Strict; Max-Age=/);
  });

  it('rejects a backend origin that does not resolve to exact IPv4 loopback', async () => {
    vi.stubEnv('CODETHREAD_API_ORIGIN', 'http://127.0.0.1.attacker.test:8765');
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(openWorkspace(scanId)).rejects.toMatchObject({
      code: 'BACKEND_NOT_CONFIGURED',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects unknown operations and malformed inputs before forwarding', async () => {
    const { seen } = backendAndViewerFetch();
    const opened = await openWorkspace(scanId);
    const sentBefore = seen.length;
    await expect(
      forwardViewerOperation(
        opened.sessionId,
        scanId,
        'https://example.test',
        {},
      ),
    ).rejects.toMatchObject({ code: 'WORKSPACE_OPERATION_NOT_FOUND' });
    await expect(
      forwardViewerOperation(opened.sessionId, scanId, 'projects', {
        unexpected: true,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(
      forwardViewerOperation(opened.sessionId, scanId, 'toString', {}),
    ).rejects.toMatchObject({ code: 'WORKSPACE_OPERATION_NOT_FOUND' });
    await expect(
      forwardViewerOperation(opened.sessionId, repositoryId, 'files', {
        offset: 0,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'WORKSPACE_SCAN_MISMATCH' });
    expect(seen).toHaveLength(sentBefore);
  });

  it('rejects response contract drift and oversized upstream bodies', async () => {
    const invalid = backendAndViewerFetch({
      ...projectsResponse(),
      extra: true,
    });
    const opened = await openWorkspace(scanId);
    await expect(
      forwardViewerOperation(opened.sessionId, scanId, 'projects', {}),
    ).rejects.toMatchObject({ code: 'UPSTREAM_CONTRACT_MISMATCH' });

    const oversizedBody = JSON.stringify({
      ...projectsResponse(),
      extra: 'x'.repeat(1024 * 1024),
    });
    invalid.fetcher.mockImplementation(async (input) => {
      if (String(input).endsWith('/api/projects'))
        return new Response(oversizedBody, {
          headers: {
            'content-type': 'application/json',
            'content-length': String(oversizedBody.length),
          },
        });
      return json({ error: { code: 'NOT_FOUND', message: 'Not found.' } }, 404);
    });
    await expect(
      forwardViewerOperation(opened.sessionId, scanId, 'projects', {}),
    ).rejects.toMatchObject({ code: 'UPSTREAM_RESPONSE_TOO_LARGE' });
  });

  it('bounds request bodies even when Content-Length is missing', async () => {
    const request = new Request('http://127.0.0.1:3000/api/workspace/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'x'.repeat(70 * 1024) }),
    });
    const failure = await parseRequestJson(request).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(WorkspaceBffError);
    expect(failure).toMatchObject({ code: 'REQUEST_TOO_LARGE' });
  });

  it('preserves sessions on transient viewer timeout and evicts stale 403/near-expiry sessions', async () => {
    const baseNow = Date.now() + 120 * 60_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(baseNow);
    const { fetcher } = backendAndViewerFetch();
    const normal = fetcher.getMockImplementation()!;
    try {
      const opened = await openWorkspace(scanId);
      // Transient viewer timeout in workspaceMetadata must return 504 without deleting the session.
      fetcher.mockImplementationOnce(async () => {
        throw new DOMException('Timed out', 'TimeoutError');
      });
      await expect(
        workspaceMetadata(opened.sessionId, scanId),
      ).rejects.toMatchObject({ status: 504, code: 'VIEWER_TIMEOUT' });
      fetcher.mockImplementation(normal);
      await expect(
        workspaceMetadata(opened.sessionId, scanId),
      ).resolves.toEqual(opened.metadata);

      // A stale 403 (e.g. rebound viewer port) must evict the cached session on open/meta.
      fetcher.mockImplementationOnce(async () =>
        json({ error: { code: 'FORBIDDEN', message: 'Wrong token' } }, 403),
      );
      const reopened = await openWorkspace(scanId, opened.sessionId);
      expect(reopened.sessionId).not.toBe(opened.sessionId);

      // A near-expiry session (< 5s remaining) must be refreshed rather than issuing Max-Age=0.
      clock.mockReturnValue(Date.parse(reopened.metadata.expiresAt) - 500);
      const refreshed = await openWorkspace(scanId, reopened.sessionId);
      expect(refreshed.sessionId).not.toBe(reopened.sessionId);
    } finally {
      clock.mockReturnValue(baseNow + 180 * 60_000);
      fetcher.mockImplementation(async () =>
        json({ error: { code: 'UNAVAILABLE', message: 'Cleanup' } }, 503),
      );
      try {
        await openWorkspace(scanId);
      } catch {
        /* Cleanup leaves the registry empty. */
      }
      clock.mockRestore();
    }
  });

  it('adapts optional AI status and scan-scoped AI synthesis with strict bounds and session checks', async () => {
    const snapshotId = '00000000-0000-4000-8000-000000000601';
    const symbolId = '00000000-0000-4000-8000-000000000602';
    const validSynthesis = {
      version: 1,
      snapshotId,
      rootSymbolId: symbolId,
      task: 'explain_trace',
      evidenceBasis: 'static_generated_unverified',
      disclaimer:
        'Generated static synthesis (unverified). Static relationships do not prove runtime execution.',
      provenance: {
        provider: 'openai_compatible',
        model: 'qwen2.5-coder:7b',
        packetHash: 'a'.repeat(64),
        promptVersion: 'ct-ai-prompt-v2',
      },
      context: {
        truncated: false,
        truncationReasons: [],
        omitted: { symbols: 0, relations: 0, excerpts: 0, diagnostics: 0 },
        redactedExcerpts: 0,
      },
      summary: 'entry statically calls helper.',
      claims: [],
      nextSteps: [],
      uncertainties: [],
      verification: {
        verifiedClaims: 0,
        rejectedClaims: 0,
        verifiedNextSteps: 0,
        rejectedNextSteps: 0,
        rejectedItems: [],
      },
    };

    const { fetcher } = backendAndViewerFetch();
    const baseImpl = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/v1/ai/status')) {
        return json({ enabled: false });
      }
      if (url.endsWith('/ai/synthesize')) {
        return json(validSynthesis);
      }
      return baseImpl(input, init);
    });

    await expect(aiStatus()).resolves.toEqual({ enabled: false });
    const opened = await openWorkspace(scanId);

    // Missing cookie -> 401; scan mismatch -> 409; invalid request -> 400.
    await expect(
      synthesizeWorkspaceAi(undefined, scanId, {
        projectId: 'root',
        request: {
          task: 'explain_trace',
          neighbors: { snapshotId, symbolId },
        },
      }),
    ).rejects.toMatchObject({ status: 401, code: 'WORKSPACE_SESSION_EXPIRED' });

    await expect(
      synthesizeWorkspaceAi(opened.sessionId, repositoryId, {
        projectId: 'root',
        request: {
          task: 'explain_trace',
          neighbors: { snapshotId, symbolId },
        },
      }),
    ).rejects.toMatchObject({ status: 409, code: 'WORKSPACE_SCAN_MISMATCH' });

    await expect(
      synthesizeWorkspaceAi(opened.sessionId, scanId, {
        projectId: 'root',
        request: {
          task: 'explain_trace',
          neighbors: { snapshotId, symbolId, depth: 5 },
        },
      }),
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_REQUEST' });

    // Valid synthesis succeeds and never exposes backend bearer token.
    const ok = await synthesizeWorkspaceAi(opened.sessionId, scanId, {
      projectId: 'root',
      request: {
        task: 'explain_trace',
        neighbors: { snapshotId, symbolId },
      },
    });
    expect(ok.summary).toBe('entry statically calls helper.');
    expect(JSON.stringify(ok)).not.toContain(
      process.env.CODETHREAD_API_TOKEN ?? 'backend-secret',
    );

    // Context mismatch from backend is rejected as 502 UPSTREAM_CONTRACT_MISMATCH.
    fetcher.mockImplementationOnce(async () =>
      json({ ...validSynthesis, task: 'explain_unknowns' }),
    );
    await expect(
      synthesizeWorkspaceAi(opened.sessionId, scanId, {
        projectId: 'root',
        request: {
          task: 'explain_trace',
          neighbors: { snapshotId, symbolId },
        },
      }),
    ).rejects.toMatchObject({
      status: 502,
      code: 'UPSTREAM_CONTRACT_MISMATCH',
    });

    // Response > 64 KiB is rejected; timeout maps to 504 AI_PROVIDER_TIMEOUT.
    const huge = JSON.stringify({
      ...validSynthesis,
      extra: 'x'.repeat(70 * 1024),
    });
    fetcher.mockImplementationOnce(
      async () =>
        new Response(huge, {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'content-length': String(huge.length),
          },
        }),
    );
    await expect(
      synthesizeWorkspaceAi(opened.sessionId, scanId, {
        projectId: 'root',
        request: {
          task: 'explain_trace',
          neighbors: { snapshotId, symbolId },
        },
      }),
    ).rejects.toMatchObject({
      status: 502,
      code: 'UPSTREAM_RESPONSE_TOO_LARGE',
    });

    fetcher.mockImplementationOnce(async () => {
      throw new DOMException('Timed out', 'TimeoutError');
    });
    await expect(
      synthesizeWorkspaceAi(opened.sessionId, scanId, {
        projectId: 'root',
        request: {
          task: 'explain_trace',
          neighbors: { snapshotId, symbolId },
        },
      }),
    ).rejects.toMatchObject({ status: 504, code: 'AI_PROVIDER_TIMEOUT' });
  });
});
