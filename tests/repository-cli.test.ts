import { rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArguments } from '../scripts/investigation/arguments.ts';
import { runInvestigationCli } from './helpers/investigation-cli.ts';
import { createGitRepository } from './helpers/git-fixture.ts';

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});

describe('whole repository investigation CLI', () => {
  it('creates an ephemeral repository ID only for repository scope', () => {
    const command = parseArguments([
      '--repo',
      '.',
      '--revision',
      'HEAD',
      '--scope',
      'repository',
      '--view',
    ]);
    expect(command).toMatchObject({
      kind: 'repository',
      repositoryPath: '.',
      revision: 'HEAD',
      view: true,
    });
    if (command.kind !== 'repository')
      throw new Error('Repository scope was not selected');
    expect(command.repositoryId).toMatch(
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/,
    );
    expect(() =>
      parseArguments(['--repo', '.', '--revision', 'HEAD', '--file', 'a.ts']),
    ).toThrow(/Usage/);
  });

  it.each([['--file', 'a.ts'], ['--browse'], ['--scope', 'repository']])(
    'rejects mixed or repeated repository selection: %j',
    (...extra) => {
      expect(() =>
        parseArguments([
          '--repo',
          '.',
          '--revision',
          'HEAD',
          '--scope',
          'repository',
          ...extra,
        ]),
      ).toThrow();
    },
  );

  it('analyzes every pinned source and enters a chosen project without reading dirty source', async () => {
    const repository = await createGitRepository(
      [
        {
          path: 'tsconfig.json',
          source:
            '{"compilerOptions":{"types":[],"target":"ES2023"},"files":["src/a.ts","src/b.ts"]}',
        },
        {
          path: 'src/a.ts',
          source:
            'import { target } from "./b";\nexport function entry(){ target(); }',
        },
        { path: 'src/b.ts', source: 'export function target(){}' },
        { path: 'unassigned.ts', source: 'export function unassigned(){}' },
      ],
      directories,
    );
    await writeFile(
      resolve(repository.directory, 'src/a.ts'),
      'dirty source must not be used',
    );
    const result = await runInvestigationCli(
      [
        '--repo',
        repository.directory,
        '--revision',
        repository.revision,
        '--scope',
        'repository',
      ],
      'projects\nfind target\nuse tsconfig.json\ninspect src/a.ts@2:1 calls outgoing\nevidence symbol src/a.ts@2:1\nquit\n',
    );
    expect(result.code, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain(
      `Pinned Git commit: ${repository.revision}`,
    );
    expect(result.stdout).toContain('Source inventory: 3 files');
    expect(result.stdout).toContain('unassigned');
    expect(result.stdout).toContain('tsconfig.json');
    expect(result.stdout).toContain('target');
    expect(result.stdout).toContain('[CALLS exact]');
    expect(result.stdout).toContain('export function entry()');
    expect(result.stdout).not.toContain('dirty source must not be used');
  }, 45000);
});
