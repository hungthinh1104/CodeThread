import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { repositoryWorkspaces } from '../scripts/investigation/repository-workspaces.ts';
import type { PinnedInput } from '../scripts/git-source/repository-metadata.ts';

function pinned(path: string, text: string): PinnedInput {
  const bytes = new TextEncoder().encode(text);
  return {
    path,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    blobId: '0'.repeat(40),
    mode: '100644',
  };
}

describe('pinned workspace declarations', () => {
  it('bounds workspace patterns and discloses unsupported globs', () => {
    const bounded = repositoryWorkspaces([
      pinned(
        'package.json',
        JSON.stringify({
          workspaces: Array.from({ length: 129 }, (_, index) => `pkg-${index}`),
        }),
      ),
      pinned('pkg-0/package.json', '{"name":"pkg-0"}'),
    ]);
    expect(bounded.packages).toEqual([]);
    expect(bounded.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'WORKSPACE_RESOURCE_LIMIT' }),
    );

    const unsupported = repositoryWorkspaces([
      pinned('package.json', '{"workspaces":["packages/{a,b}"]}'),
      pinned('packages/a/package.json', '{"name":"@scope/a"}'),
    ]);
    expect(unsupported.packages).toEqual([]);
    expect(unsupported.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'UNSUPPORTED_WORKSPACE_PATTERN' }),
    );
  });

  it('keeps duplicate package names unresolved and never reads package scripts', () => {
    const result = repositoryWorkspaces([
      pinned(
        'package.json',
        '{"workspaces":["packages/*"],"scripts":{"prepare":"throw new Error(1)"}}',
      ),
      pinned('packages/a/package.json', '{"name":"@scope/shared"}'),
      pinned('packages/b/package.json', '{"name":"@scope/shared"}'),
    ]);
    expect(result.packages).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'AMBIGUOUS_WORKSPACE_NAME' }),
    );
  });
});
