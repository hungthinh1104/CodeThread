import { rm } from 'node:fs/promises';
import * as codeModel from '@codethread/code-model';
import * as symbolIndexer from '@codethread/symbol-indexer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnalysisError } from '@codethread/symbol-indexer';
import { analyzeGitRepository } from '../scripts/investigation/repository-session.ts';
import { repositoryWorkspaces } from '../scripts/investigation/repository-workspaces.ts';
import { createGitRepository } from './helpers/git-fixture.ts';
import { createHash } from 'node:crypto';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  for (const path of temporaryDirectories.splice(0))
    await rm(path, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const repositoryId = '00000000-0000-4000-8000-000000000074';

describe('repository project execution', () => {
  it('reports missing module context separately from complete source acquisition', async () => {
    const repository = await createGitRepository(
      [
        {
          path: 'tsconfig.json',
          source:
            '{"compilerOptions":{"types":[],"target":"ES2023"},"files":["index.ts"]}',
        },
        {
          path: 'index.ts',
          source:
            "import { unavailable } from 'package-not-installed'; export function entry(){ return unavailable(); }",
        },
      ],
      temporaryDirectories,
    );
    const session = await analyzeGitRepository({
      repositoryPath: repository.directory,
      repositoryId,
      revision: repository.revision,
    });
    expect(session.inventory.complete).toBe(true);
    expect(session.sourceCoverageComplete).toBe(true);
    expect(session.analysisComplete).toBe(true);
    expect(
      session.projects[0]?.snapshot?.facts.diagnostics.some(
        (diagnostic) => diagnostic.code === 'TS_2307',
      ),
    ).toBe(true);
    expect(session.contextComplete).toBe(false);
  }, 30000);

  it('propagates caller cancellation through the repository session', async () => {
    const repository = await createGitRepository(
      [{ path: 'index.ts', source: 'export function entry() {}' }],
      temporaryDirectories,
    );
    const controller = new AbortController();
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    vi.spyOn(symbolIndexer, 'analyzeProject').mockImplementation((input) => {
      resolveStarted();
      return new Promise<
        Awaited<ReturnType<typeof symbolIndexer.analyzeProject>>
      >((_resolve, reject) => {
        const signal = input.signal;
        const onAbort = () =>
          reject(
            new AnalysisError('CANCELLED', 'Repository analysis cancelled.'),
          );
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      });
    });
    const pending = analyzeGitRepository({
      repositoryPath: repository.directory,
      repositoryId,
      revision: repository.revision,
      signal: controller.signal,
    });
    await started;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  }, 30000);

  it('returns completed contexts and marks remaining contexts when the session deadline expires', async () => {
    const repository = await createGitRepository(
      [
        { path: 'package.json', source: '{"workspaces":["packages/*"]}' },
        {
          path: 'tsconfig.json',
          source:
            '{"files":[],"references":[{"path":"packages/a-fast"},{"path":"packages/b-slow"},{"path":"packages/c-later"}]}',
        },
        ...['a-fast', 'b-slow', 'c-later'].flatMap((name) => [
          {
            path: `packages/${name}/package.json`,
            source: JSON.stringify({ name: `@fixture/${name}` }),
          },
          {
            path: `packages/${name}/tsconfig.json`,
            source:
              '{"compilerOptions":{"types":[],"target":"ES2023"},"files":["index.ts"]}',
          },
          {
            path: `packages/${name}/index.ts`,
            source: `export function ${name.replace('-', '')}() {}`,
          },
        ]),
      ],
      temporaryDirectories,
    );
    const originalLimits = codeModel.analysisResourceLimits;
    const originalAnalyzeProject = symbolIndexer.analyzeProject;
    const slowProjectStarted = vi.fn();
    vi.spyOn(codeModel, 'analysisResourceLimits').mockImplementation(
      (profile = 'selected') =>
        profile === 'repository'
          ? { ...originalLimits(profile), maxDeadlineMs: 8000 }
          : originalLimits(profile),
    );
    vi.spyOn(symbolIndexer, 'analyzeProject').mockImplementation(
      async (input) => {
        if (input.configPath === 'packages/b-slow/tsconfig.json') {
          slowProjectStarted();
          await new Promise<never>((_resolve, reject) => {
            const signal = input.signal;
            const onAbort = () =>
              reject(
                new AnalysisError(
                  'ANALYSIS_TIMEOUT',
                  'Repository analysis deadline exceeded.',
                ),
              );
            if (signal?.aborted) onAbort();
            else signal?.addEventListener('abort', onAbort, { once: true });
          });
        }
        return originalAnalyzeProject(input);
      },
    );

    const session = await analyzeGitRepository({
      repositoryPath: repository.directory,
      repositoryId,
      revision: repository.revision,
    });

    expect(slowProjectStarted).toHaveBeenCalledOnce();
    expect(session.inventory.complete).toBe(true);
    expect(session.projects).toContainEqual(
      expect.objectContaining({
        project: expect.objectContaining({
          configPath: 'packages/a-fast/tsconfig.json',
        }),
        status: 'ready',
        snapshot: expect.any(Object),
      }),
    );
    for (const name of ['b-slow', 'c-later']) {
      const project = session.projects.find(
        (entry) =>
          entry.project.configPath === `packages/${name}/tsconfig.json`,
      );
      expect(project).toMatchObject({
        status: 'not_analyzed',
        error: { code: 'ANALYSIS_TIMEOUT' },
      });
      expect(project?.snapshot).toBeUndefined();
    }
    expect(session.files.map((file) => [file.path, file.status])).toEqual([
      ['packages/a-fast/index.ts', 'analyzed'],
      ['packages/b-slow/index.ts', 'not_analyzed'],
      ['packages/c-later/index.ts', 'not_analyzed'],
    ]);
    expect(
      session.files
        .filter((file) => file.status === 'not_analyzed')
        .every((file) => file.analysisReason?.includes('ANALYSIS_TIMEOUT')),
    ).toBe(true);
    expect(session.sourceCoverageComplete).toBe(false);
    expect(session.analysisComplete).toBe(false);
    expect(session.contextComplete).toBe(false);
  }, 30000);

  it('records a deadline at the next project budget boundary after retaining completed contexts', async () => {
    const repository = await createGitRepository(
      [
        { path: 'package.json', source: '{"workspaces":["packages/*"]}' },
        {
          path: 'tsconfig.json',
          source:
            '{"files":[],"references":[{"path":"packages/a-fast"},{"path":"packages/b-later"}]}',
        },
        ...['a-fast', 'b-later'].flatMap((name) => [
          {
            path: `packages/${name}/package.json`,
            source: JSON.stringify({ name: `@fixture/${name}` }),
          },
          {
            path: `packages/${name}/tsconfig.json`,
            source:
              '{"compilerOptions":{"types":[],"target":"ES2023"},"files":["index.ts"]}',
          },
          {
            path: `packages/${name}/index.ts`,
            source: `export function ${name.replace('-', '')}() {}`,
          },
        ]),
      ],
      temporaryDirectories,
    );
    const originalNow = performance.now.bind(performance);
    const deadlineMs =
      codeModel.analysisResourceLimits('repository').maxDeadlineMs;
    let remainingBudgetCalculations = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      const stack = new Error().stack ?? '';
      if (stack.includes('remainingMs') && !stack.includes('throwIfStopped')) {
        remainingBudgetCalculations++;
        if (remainingBudgetCalculations === 2)
          return originalNow() + deadlineMs + 10_000;
      }
      return originalNow();
    });

    const session = await analyzeGitRepository({
      repositoryPath: repository.directory,
      repositoryId,
      revision: repository.revision,
    });

    expect(remainingBudgetCalculations).toBe(2);
    expect(session.projects).toContainEqual(
      expect.objectContaining({
        project: expect.objectContaining({
          configPath: 'packages/a-fast/tsconfig.json',
        }),
        status: 'ready',
        snapshot: expect.any(Object),
      }),
    );
    expect(session.projects).toContainEqual(
      expect.objectContaining({
        project: expect.objectContaining({
          configPath: 'packages/b-later/tsconfig.json',
        }),
        status: 'not_analyzed',
        error: expect.objectContaining({ code: 'ANALYSIS_TIMEOUT' }),
      }),
    );
    expect(session.files.map((file) => [file.path, file.status])).toEqual([
      ['packages/a-fast/index.ts', 'analyzed'],
      ['packages/b-later/index.ts', 'not_analyzed'],
    ]);
    expect(session.sourceCoverageComplete).toBe(false);
    expect(session.analysisComplete).toBe(false);
    expect(session.contextComplete).toBe(false);
  }, 30000);

  it('returns partial results when a worker reports cancellation after the session deadline', async () => {
    const repository = await createGitRepository(
      [
        { path: 'package.json', source: '{"workspaces":["packages/*"]}' },
        {
          path: 'tsconfig.json',
          source:
            '{"files":[],"references":[{"path":"packages/a-fast"},{"path":"packages/b-cancelled"}]}',
        },
        ...['a-fast', 'b-cancelled'].flatMap((name) => [
          {
            path: `packages/${name}/package.json`,
            source: JSON.stringify({ name: `@fixture/${name}` }),
          },
          {
            path: `packages/${name}/tsconfig.json`,
            source:
              '{"compilerOptions":{"types":[],"target":"ES2023"},"files":["index.ts"]}',
          },
          {
            path: `packages/${name}/index.ts`,
            source: `export function ${name.replace('-', '')}() {}`,
          },
        ]),
      ],
      temporaryDirectories,
    );
    const originalLimits = codeModel.analysisResourceLimits;
    const originalAnalyzeProject = symbolIndexer.analyzeProject;
    const originalNow = performance.now.bind(performance);
    const deadlineMs = 60_000;
    const startedAt = originalNow();
    let currentTime = startedAt;
    vi.spyOn(codeModel, 'analysisResourceLimits').mockImplementation(
      (profile = 'selected') =>
        profile === 'repository'
          ? { ...originalLimits(profile), maxDeadlineMs: deadlineMs }
          : originalLimits(profile),
    );
    vi.spyOn(performance, 'now').mockImplementation(() => currentTime);
    vi.spyOn(symbolIndexer, 'analyzeProject').mockImplementation(
      async (input) => {
        if (input.configPath === 'packages/b-cancelled/tsconfig.json') {
          currentTime = startedAt + deadlineMs + 1;
          throw new AnalysisError('CANCELLED', 'Analysis cancelled.');
        }
        return originalAnalyzeProject(input);
      },
    );

    const session = await analyzeGitRepository({
      repositoryPath: repository.directory,
      repositoryId,
      revision: repository.revision,
    });

    expect(session.projects).toContainEqual(
      expect.objectContaining({
        project: expect.objectContaining({
          configPath: 'packages/a-fast/tsconfig.json',
        }),
        status: 'ready',
        snapshot: expect.any(Object),
      }),
    );
    expect(session.projects).toContainEqual(
      expect.objectContaining({
        project: expect.objectContaining({
          configPath: 'packages/b-cancelled/tsconfig.json',
        }),
        status: 'not_analyzed',
        error: expect.objectContaining({ code: 'ANALYSIS_TIMEOUT' }),
      }),
    );
    expect(session.files.map((file) => [file.path, file.status])).toEqual([
      ['packages/a-fast/index.ts', 'analyzed'],
      ['packages/b-cancelled/index.ts', 'not_analyzed'],
    ]);
    expect(session.sourceCoverageComplete).toBe(false);
    expect(session.analysisComplete).toBe(false);
    expect(session.contextComplete).toBe(false);
  }, 30000);

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
    expect(session.files[0]?.analysisReason).toContain('MALFORMED_SOURCE');
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
