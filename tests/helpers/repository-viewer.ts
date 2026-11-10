import { analyzeGitRepository } from '../../scripts/investigation/repository-session.ts';
import { createGitRepository } from './git-fixture.ts';

export async function repositoryViewerFixture(directories: string[]) {
  const options = {
    target: 'ES2023',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    types: [],
    strict: true,
  };
  const config = (files: string[], extra = {}) =>
    JSON.stringify({ compilerOptions: { ...options, ...extra }, files });
  const repository = await createGitRepository(
    [
      { path: 'package.json', source: '{"type":"module"}' },
      {
        path: 'tsconfig.json',
        source:
          '{"files":[],"references":[{"path":"projects/a"},{"path":"projects/b"},{"path":"projects/c"},{"path":"projects/broken"}]}',
      },
      {
        path: 'projects/a/tsconfig.json',
        source: config(['../../src/entry.ts', '../../src/types.ts']),
      },
      {
        path: 'projects/b/tsconfig.json',
        source: config(['../../src/shared.ts']),
      },
      {
        path: 'projects/c/tsconfig.json',
        source: config(['../../src/shared.ts'], { strict: false }),
      },
      {
        path: 'projects/broken/tsconfig.json',
        source: config(['../../src/broken.ts']),
      },
      {
        path: 'src/entry.ts',
        source:
          'import { target } from "./shared.js";\nexport function entry(){ target(); target(); }',
      },
      {
        path: 'src/shared.ts',
        source: 'export function target(){ return 1; }',
      },
      {
        path: 'src/types.ts',
        source: 'export interface Config { value: string; }',
      },
      { path: 'src/broken.ts', source: 'export function broken( {' },
    ],
    directories,
  );
  const session = await analyzeGitRepository({
    repositoryPath: repository.directory,
    revision: repository.revision,
    repositoryId: '00000000-0000-4000-8000-000000000078',
  });
  return { session, repository };
}
