import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeGitRepository } from '../scripts/investigation/repository-session.ts';
import { repositoryWorkspaces } from '../scripts/investigation/repository-workspaces.ts';
import { createGitRepository } from './helpers/git-fixture.ts';
import { createHash } from 'node:crypto';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  for (const path of temporaryDirectories.splice(0))
    await rm(path, { recursive: true, force: true });
});
const repositoryId = '00000000-0000-4000-8000-000000000074';

describe('repository project execution', () => {
  it('retains a usable project when another project contains malformed source', async () => {
    const repository = await createGitRepository(
      [
        { path: 'package.json', source: '{"workspaces":["packages/*"]}' },
        {
          path: 'tsconfig.json',
          source:
            '{"files":[],"references":[{"path":"packages/good"},{"path":"packages/bad"}]}',
        },
        {
          path: 'packages/good/package.json',
          source: '{"name":"@fixture/good"}',
        },
        {
          path: 'packages/bad/package.json',
          source: '{"name":"@fixture/bad"}',
        },
        {
          path: 'packages/good/tsconfig.json',
          source:
            '{"compilerOptions":{"types":[],"target":"ES2023"},"files":["index.ts"]}',
        },
        {
          path: 'packages/bad/tsconfig.json',
          source:
            '{"compilerOptions":{"types":[],"target":"ES2023"},"files":["index.ts"]}',
        },
        {
          path: 'packages/good/index.ts',
          source:
            'export function target() {} export function entry(){ target(); }',
        },
        { path: 'packages/bad/index.ts', source: 'export function broken( {' },
      ],
      temporaryDirectories,
    );
    const session = await analyzeGitRepository({
      repositoryPath: repository.directory,
      repositoryId,
      revision: repository.revision,
    });
    expect(session.inventory.complete).toBe(true);
    expect(session.inventory.sourceFiles).toBe(2);
    expect(session.analysisComplete).toBe(false);
    expect(session.contextComplete).toBe(false);
    expect(session.sourceCoverageComplete).toBe(false);
    const good = session.projects.find(
      (project) => project.project.configPath === 'packages/good/tsconfig.json',
    )!;
    const bad = session.projects.find(
      (project) => project.project.configPath === 'packages/bad/tsconfig.json',
    )!;
    expect(good.status).toBe('ready');
    expect(good.snapshot?.facts.relations).toHaveLength(1);
    expect(good.snapshot?.facts.relations[0]?.resolution.status).toBe('exact');
    expect(bad).toMatchObject({
      status: 'failed',
      error: { code: 'MALFORMED_SOURCE' },
    });
    expect(bad.snapshot).toBeUndefined();
    expect(session.files.map((file) => [file.path, file.status])).toEqual([
      ['packages/bad/index.ts', 'not_analyzed'],
      ['packages/good/index.ts', 'analyzed'],
    ]);
    expect(session.metrics.resultBytes).toBeGreaterThan(0);
    expect(session.metrics.parentPeakRssBytes).toBeGreaterThan(0);
  }, 30000);

  it('does not choose an arbitrary package when workspace names collide', () => {
    const metadata = [
      ['package.json', '{"workspaces":["packages/*"]}'],
      ['packages/a/package.json', '{"name":"@fixture/duplicate"}'],
      ['packages/b/package.json', '{"name":"@fixture/duplicate"}'],
    ].map(([path, text]) => {
      const bytes = new TextEncoder().encode(text!);
      return {
        path: path!,
        bytes,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        blobId: 'a'.repeat(40),
        mode: '100644' as const,
      };
    });
    const result = repositoryWorkspaces(metadata);
    expect(result.packages).toEqual([]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'AMBIGUOUS_WORKSPACE_NAME',
      'AMBIGUOUS_WORKSPACE_NAME',
    ]);
  });
});
