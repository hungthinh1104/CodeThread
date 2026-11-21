import { createHash } from 'node:crypto';
import { analyzeManifest, COMPILER_PROFILE } from '@codethread/symbol-indexer';
import { expect, it } from 'vitest';
import { startWorkspaceApp } from './browser/workspace-app.ts';

it('serves the local Workspace while keeping its unused image optimizer unavailable', async () => {
  const bytes = Buffer.from('export function entry() { return 1; }');
  const snapshot = await analyzeManifest({
    repositoryId: '00000000-0000-4000-8000-000000000076',
    compilerOptions: COMPILER_PROFILE,
    files: [
      {
        path: 'entry.ts',
        bytes,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    ],
  });
  const app = await startWorkspaceApp(snapshot);
  try {
    const home = await fetch(app.origin);
    expect(home.status).toBe(200);
    expect(home.headers.get('content-security-policy')).toContain(
      "frame-ancestors 'none'",
    );
    expect(await home.text()).toContain('Investigation Workspace');
    const optimizer = await fetch(app.origin + '/_next/image');
    expect(optimizer.status).toBe(404);
    await optimizer.text();
  } finally {
    await app.close();
  }
}, 90_000);
