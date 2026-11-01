import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { analyzeManifest, COMPILER_PROFILE } from '@codethread/symbol-indexer';

const repositoryId = '00000000-0000-4000-8000-000000000001';

describe('CT-INDEX-001A immutable manifest boundary', () => {
  it('returns an explicit timeout when a caller lowers the analysis deadline', async () => {
    const bytes = new TextEncoder().encode('export function f() {}');
    await expect(
      analyzeManifest({
        repositoryId,
        compilerOptions: COMPILER_PROFILE,
        deadlineMs: 1,
        files: [
          {
            path: 'source.ts',
            bytes,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'ANALYSIS_TIMEOUT' });
  }, 15000);
  it('copies the caller buffer before asynchronous compilation', async () => {
    const bytes = new TextEncoder().encode('export const answer = 42;\n');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const pending = analyzeManifest({
      repositoryId,
      compilerOptions: COMPILER_PROFILE,
      files: [{ path: 'source.ts', bytes, sha256 }],
    });
    bytes.fill(0);
    const result = await pending;
    expect(result.facts.files[0]?.contentHash).toBe(sha256);
    expect(Object.isFrozen(result.facts.files)).toBe(true);
  }, 15000);
  it('reports malformed source as a failure, not an empty graph', async () => {
    const bytes = new TextEncoder().encode('export function broken( {');
    await expect(
      analyzeManifest({
        repositoryId,
        compilerOptions: COMPILER_PROFILE,
        files: [
          {
            path: 'source.ts',
            bytes,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'MALFORMED_SOURCE' });
  }, 15000);
  it('returns a bounded analysis for valid source without call sites', async () => {
    const bytes = new TextEncoder().encode('export const answer = 42;\n');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const result = await analyzeManifest({
      repositoryId,
      compilerOptions: COMPILER_PROFILE,
      files: [{ path: 'source.ts', bytes, sha256 }],
    });
    expect(result.facts.files).toHaveLength(1);
    expect(result.facts.files[0]?.contentHash).toBe(sha256);
    expect(result.facts.counts.callSites).toBe(0);
    expect(result.facts.symbols).toEqual([]);
  }, 15000);
  it('enforces file count and source byte limits before compilation', async () => {
    const bytes = new Uint8Array(1);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const files = Array.from({ length: 21 }, (_, index) => ({
      path: `${index}.ts`,
      bytes,
      sha256,
    }));
    await expect(
      analyzeManifest({
        repositoryId,
        compilerOptions: COMPILER_PROFILE,
        files,
      }),
    ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
    await expect(
      analyzeManifest({
        repositoryId,
        compilerOptions: COMPILER_PROFILE,
        files: [{ path: 'large.ts', bytes: new Uint8Array(262145), sha256 }],
      }),
    ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
  });
  it('rejects options outside the declared compiler profile', async () => {
    await expect(
      analyzeManifest({
        repositoryId,
        compilerOptions: {
          ...COMPILER_PROFILE,
          allowJs: true,
        } as unknown as typeof COMPILER_PROFILE,
        files: [],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_COMPILER_OPTIONS' });
  });
  it('rejects unsafe paths and case-equivalent paths before analysis', async () => {
    const bytes = new TextEncoder().encode('export {};');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    for (const paths of [['../escape.ts'], ['Folder/a.ts', 'folder/A.ts']]) {
      await expect(
        analyzeManifest({
          repositoryId,
          compilerOptions: COMPILER_PROFILE,
          files: paths.map((path) => ({ path, bytes, sha256 })),
        }),
      ).rejects.toMatchObject({ code: 'INVALID_MANIFEST' });
    }
  });
  it('rejects malformed UTF-8 even when the source hash matches', async () => {
    const bytes = new Uint8Array([0xc3, 0x28]);
    await expect(
      analyzeManifest({
        repositoryId,
        compilerOptions: COMPILER_PROFILE,
        files: [
          {
            path: 'source.ts',
            bytes,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ENCODING' });
  });
  it('rejects source bytes that do not match the declared hash', async () => {
    await expect(
      analyzeManifest({
        repositoryId,
        compilerOptions: COMPILER_PROFILE,
        files: [
          {
            path: 'source.ts',
            bytes: new TextEncoder().encode('export {};'),
            sha256: '0'.repeat(64),
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'HASH_MISMATCH' });
  });
});
