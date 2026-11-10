import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { analyzeGitRepository } from '../scripts/investigation/repository-session.ts';
import { gitFixtureEnvironment } from './helpers/git-fixture.ts';

const repositoryId = '00000000-0000-4000-8000-000000000079';

async function cleanupRepository(path: string, parent: string): Promise<void> {
  const absolute = resolve(path);
  if (
    !absolute.startsWith(parent + sep) ||
    !basename(absolute).startsWith('codethread-self-')
  )
    throw new Error('Invalid self-repository cleanup boundary');
  await rm(absolute, { recursive: true, force: true });
}

/** The current CodeThread commit is the immutable monorepo input for this regression. */
describe('pinned CodeThread monorepo intake', () => {
  it('accounts for every committed .ts file and keeps package references separate', async () => {
    const parent = resolve(tmpdir());
    const repositoryPath = await mkdtemp(resolve(parent, 'codethread-self-'));
    try {
      const gitEnvironment = gitFixtureEnvironment();
      execFileSync('git', ['init', '--quiet', repositoryPath], {
        env: gitEnvironment,
        windowsHide: true,
        timeout: 30000,
      });
      execFileSync(
        'git',
        [
          '-C',
          repositoryPath,
          'fetch',
          '--depth=1',
          '--no-tags',
          process.cwd(),
          'HEAD',
        ],
        {
          env: gitEnvironment,
          windowsHide: true,
          timeout: 30000,
        },
      );
      const revision = execFileSync(
        'git',
        ['-C', repositoryPath, 'rev-parse', '--verify', 'FETCH_HEAD^{commit}'],
        { encoding: 'utf8', windowsHide: true },
      ).trim();
      const rows = execFileSync(
        'git',
        [
          '-C',
          repositoryPath,
          'ls-tree',
          '-r',
          '--long',
          '--full-tree',
          revision,
        ],
        { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      )
        .trimEnd()
        .split(/\r?\n/);
      const expected = rows.flatMap((row) => {
        const [header, path] = row.split('\t');
        const [mode, type, , byteLength] = (header ?? '').split(/\s+/);
        return (mode === '100644' || mode === '100755') &&
          type === 'blob' &&
          path?.endsWith('.ts')
          ? [{ path, byteLength: Number(byteLength) }]
          : [];
      });
      const session = await analyzeGitRepository({
        repositoryPath,
        repositoryId,
        revision,
      });
      expect(session.commitId).toBe(revision);
      expect(session.inventory.complete).toBe(true);
      expect(
        session.files.map(({ path, byteLength }) => ({ path, byteLength })),
      ).toEqual(expected);
      expect(session.sourceCoverageComplete).toBe(true);
      const packageContext = session.projects.find(
        (item) =>
          item.project.configPath === 'packages/symbol-indexer/tsconfig.json',
      );
      const codeModelContext = session.projects.find(
        (item) =>
          item.project.configPath === 'packages/code-model/tsconfig.json',
      );
      expect(packageContext?.snapshot).toBeDefined();
      expect(codeModelContext?.snapshot).toBeDefined();
      const snapshot = packageContext!.snapshot!;
      const owner = snapshot.facts.symbols.find(
        (symbol) => symbol.name === 'analyzeProject',
      );
      expect(owner).toBeDefined();
      expect(packageContext!.project.referencePaths).toContain(
        'packages/code-model/tsconfig.json',
      );
      expect(snapshot.facts.snapshotId).not.toBe(
        codeModelContext!.snapshot!.facts.snapshotId,
      );
    } finally {
      await cleanupRepository(repositoryPath, parent);
    }
  }, 180000);
});
