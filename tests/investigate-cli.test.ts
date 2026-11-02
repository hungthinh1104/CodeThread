import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeManifest } from '@codethread/symbol-indexer';
import { acquireGitSources, GitSourceError } from '../scripts/git-source.ts';

const scriptPath = resolve(
  fileURLToPath(new URL('../scripts/investigate.ts', import.meta.url)),
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function manifestFile(
  files: readonly { path: string; source: string }[],
) {
  const directory = await mkdtemp(resolve(tmpdir(), 'codethread-investigate-'));
  temporaryDirectories.push(directory);
  const manifestPath = resolve(directory, 'manifest.json');
  const content = JSON.stringify({
    version: 1,
    repositoryId: '00000000-0000-4000-8000-000000000012',
    files: files.map(({ path, source }) => {
      const bytes = Buffer.from(source, 'utf8');
      return {
        path,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        contentBase64: bytes.toString('base64'),
      };
    }),
  });
  await writeFile(manifestPath, content, 'utf8');
  return manifestPath;
}

async function runCli(
  args: readonly string[],
  input = '',
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', scriptPath, ...args],
    {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let stdout = '',
    stderr = '';
  const outputLimit = 256 * 1024;
  let outputOverflow = false;
  const collect = (current: string, chunk: Buffer): string => {
    const next = current + chunk.toString('utf8');
    if (Buffer.byteLength(next) > outputLimit) {
      outputOverflow = true;
      child.kill();
      return current;
    }
    return next;
  };
  child.stdout.on('data', (chunk: Buffer) => {
    stdout = collect(stdout, chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = collect(stderr, chunk);
  });
  child.stdin.end(input);
  const code = await new Promise<number | null>((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('CLI exceeded the test harness deadline.'));
    }, 15_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (exitCode) => {
      clearTimeout(timer);
      resolveExit(exitCode);
    });
  });
  if (outputOverflow)
    throw new Error('CLI exceeded the test harness output bound.');
  return { code, stdout, stderr };
}

async function runGitFixture(
  cwd: string,
  args: readonly string[],
  input?: string | Buffer,
) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
  };
  for (const key of Object.keys(env))
    if (key.startsWith('GIT_') && key !== 'GIT_TERMINAL_PROMPT')
      delete env[key];
  const child = spawn('git', [...args], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '',
    stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.end(input);
  const code = await new Promise<number>((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Git fixture command exceeded its deadline.'));
    }, 10_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (exitCode) => {
      clearTimeout(timer);
      resolveExit(exitCode ?? -1);
    });
  });
  if (code !== 0)
    throw new Error(`Git fixture setup failed (${args[0]}): ${stderr}`);
  return stdout;
}

async function createCommittedRepository(
  files: readonly { path: string; source: string }[],
): Promise<{ directory: string; revision: string }> {
  const directory = await mkdtemp(resolve(tmpdir(), 'codethread-git-source-'));
  temporaryDirectories.push(directory);
  for (const file of files) {
    const absolute = resolve(directory, file.path);
    await mkdir(resolve(absolute, '..'), { recursive: true });
    await writeFile(absolute, file.source, 'utf8');
  }
  await runGitFixture(directory, ['init', '--quiet']);
  await runGitFixture(directory, [
    '-c',
    'user.name=CodeThread Test',
    '-c',
    'user.email=codethread-test@example.invalid',
    'add',
    '--',
    ...files.map((file) => file.path),
  ]);
  await runGitFixture(directory, [
    '-c',
    'user.name=CodeThread Test',
    '-c',
    'user.email=codethread-test@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'committed source fixture',
  ]);
  const revision = (
    await runGitFixture(directory, ['rev-parse', 'HEAD'])
  ).trim();
  return { directory, revision };
}

async function writeFixtureTree(
  directory: string,
  entries: readonly { mode: string; type: string; oid: string; name: string }[],
): Promise<string> {
  const sorted = [...entries].sort((left, right) =>
    Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)),
  );
  const input = Buffer.concat(
    sorted.map((entry) =>
      Buffer.concat([
        Buffer.from(`${entry.mode} ${entry.type} ${entry.oid}\t`, 'ascii'),
        Buffer.from(entry.name, 'utf8'),
        Buffer.from([0]),
      ]),
    ),
  );
  return (await runGitFixture(directory, ['mktree', '-z'], input)).trim();
}

describe('textual investigation CLI', () => {
  it('supports a pinned source investigation with typed references, follow and verified evidence', async () => {
    const result = await runCli(
      ['--demo', 'todo'],
      [
        'symbols controllers/todo.controller.ts',
        'inspect routes/todo.router.ts@4:1 calls,references outgoing',
        'follow controllers/todo.controller.ts@10:3 references incoming',
        'evidence symbol controllers/todo.controller.ts@10:3',
        'quit',
        '',
      ].join('\n'),
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('STATIC RELATIONSHIPS ONLY');
    expect(result.stdout).toContain('[REFERENCES exact] outgoing');
    expect(result.stdout).toContain('[REFERENCES exact] incoming');
    expect(result.stdout).toContain('Reference occurrence:');
    expect(result.stdout).not.toContain('[CALLS exact]');
    expect(result.stdout).toContain('controllers/todo.controller.ts@10:3');
    expect(result.stdout).toContain(
      'sha256:3d1a82e2db7af3c8af876ff445fce286517c3636ee571f4094ea22e9b48195c2',
    );
    expect(result.stdout).toContain('getAll');
    expect(result.stdout).toContain('getOne');
    expect(result.stdout).toContain('create');
    expect(result.stdout).not.toContain('Call site:');
    expect(result.stdout).not.toMatch(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/i);
  }, 20_000);

  it('rejects ambiguous display-name selection and keeps uncertain calls targetless', async () => {
    const ambiguousManifest = await manifestFile([
      { path: 'a.ts', source: 'export function same() {}\n' },
      { path: 'b.ts', source: 'export function same() {}\n' },
    ]);
    const ambiguous = await runCli(
      ['--manifest', ambiguousManifest],
      'help\ninspect name:same\nhelp\n',
    );
    expect(ambiguous.code).toBe(2);
    expect(ambiguous.stderr).toContain('ERROR[SYMBOL_AMBIGUOUS]');
    expect(ambiguous.stderr).toContain('a.ts@1:1');
    expect(ambiguous.stderr).toContain('b.ts@1:1');
    expect(ambiguous.stdout.match(/files — list manifest paths/g)).toHaveLength(
      1,
    );

    const uncertainManifest = await manifestFile([
      {
        path: 'main.ts',
        source: 'function root() { missing(); }\n',
      },
    ]);
    const uncertain = await runCli(
      ['--manifest', uncertainManifest],
      'inspect main.ts@1:1 calls outgoing\n',
    );
    expect(uncertain.code).toBe(0);
    expect(uncertain.stdout).toContain('[CALLS unresolved] outgoing');
    expect(uncertain.stdout).toContain('target unknown (unresolved)');
    expect(uncertain.stdout).not.toContain('[CALLS EXACT');
  });

  it('keeps calls as the default filter and treats empty partial views as non-exhaustive', async () => {
    const manifest = await manifestFile([
      {
        path: 'flow.ts',
        source:
          'function root() { target(); }\nfunction target() {}\nfunction empty() {}\n',
      },
    ]);
    const result = await runCli(
      ['--manifest', manifest],
      'inspect flow.ts@1:1\ninspect flow.ts@3:1\n',
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('[CALLS exact] outgoing');
    expect(result.stdout).toContain('No calls relationships were returned');
    expect(result.stdout).toContain('not proof that no relationship exists');
    expect(result.stdout).not.toContain('[REFERENCES');
  });

  it('reports returned graph truncation and separately bounded text omissions', async () => {
    const targets = Array.from({ length: 25 }, (_, index) => `target${index}`);
    const source = [
      `export function root() {\n  ${targets.map((name) => `${name}();`).join('\n  ')}\n}`,
      ...targets.map((name) => `export function ${name}() { leaf(); }`),
      'export function leaf() {}',
    ].join('\n');
    const manifest = await manifestFile([{ path: 'many.ts', source }]);
    const result = await runCli(
      ['--manifest', manifest],
      'inspect many.ts@1:1 calls outgoing\n',
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      'CLI display omitted 5 of 25 returned relationship occurrences',
    );
    expect(result.stdout).toContain('Query truncated:');
    expect(result.stdout).not.toContain('No calls relationships were returned');
  });

  it('does not allow following an exact target whose relationship row was byte-truncated', async () => {
    const targets = Array.from({ length: 20 }, (_, index) => `target${index}`);
    const bidi = String.fromCodePoint(0x202e);
    const source = [
      `export function root() {\n${targets
        .map((name) => `  ${name}('${bidi.repeat(320)}');`)
        .join('\n')}\n}`,
      ...targets.map((name) => `export function ${name}(_value: string) {}`),
    ].join('\n');
    const manifest = await manifestFile([{ path: 'truncated.ts', source }]);
    const hiddenTarget = await runCli(
      ['--manifest', manifest],
      [
        'inspect truncated.ts@1:1 calls outgoing',
        'follow truncated.ts@42:1 calls incoming',
      ].join('\n'),
    );
    expect(hiddenTarget.stdout).toContain('20 exact');
    expect(hiddenTarget.stdout).toContain('[Text response truncated');
    expect(hiddenTarget.stdout).not.toContain('target19" (function)');
    expect(hiddenTarget.code).toBe(2);
    expect(hiddenTarget.stderr).toContain('ERROR[TARGET_NOT_IN_LAST_RESULTS]');
    expect(hiddenTarget.stderr).toContain('truncated.ts@42:1');

    const displayedTarget = await runCli(
      ['--manifest', manifest],
      [
        'inspect truncated.ts@1:1 calls outgoing',
        'follow truncated.ts@23:1 calls incoming',
      ].join('\n'),
    );
    expect(displayedTarget.stdout).toContain('[Text response truncated');
    expect(displayedTarget.stdout).toContain('"target0" (function)');
    expect(displayedTarget.code).toBe(0);
    expect(displayedTarget.stderr).toBe('');
  });

  it('rejects duplicate JSON keys and unsafe paths before analysis', async () => {
    const directory = await mkdtemp(
      resolve(tmpdir(), 'codethread-investigate-'),
    );
    temporaryDirectories.push(directory);
    const manifestPath = resolve(directory, 'duplicate.json');
    await writeFile(
      manifestPath,
      '{"version":1,"version":1,"repositoryId":"00000000-0000-4000-8000-000000000012","files":[]}',
      'utf8',
    );
    const duplicate = await runCli(['--manifest', manifestPath]);
    expect(duplicate.code).toBe(2);
    expect(duplicate.stderr).toContain('ERROR[INVALID_MANIFEST]');

    const unsafePath = await manifestFile([
      { path: '../outside.ts', source: 'export function root() {}\n' },
    ]);
    const unsafe = await runCli(['--manifest', unsafePath]);
    expect(unsafe.code).toBe(2);
    expect(unsafe.stderr).toContain('ERROR[INVALID_MANIFEST]');

    const oversizedPath = resolve(directory, 'oversized.json');
    await writeFile(oversizedPath, Buffer.alloc(3 * 1024 * 1024 + 1, 0x20));
    const oversized = await runCli(['--manifest', oversizedPath]);
    expect(oversized.code).toBe(2);
    expect(oversized.stderr).toContain('ERROR[MANIFEST_TOO_LARGE]');
  });

  it('prints a reusable evidence continuation for long declarations and spaced paths', async () => {
    const payload = 'x'.repeat(5000);
    const manifest = await manifestFile([
      {
        path: 'page file.ts',
        source: `export function root() { const text = '${payload}'; }\n`,
      },
    ]);
    const result = await runCli(
      ['--manifest', manifest],
      [
        'evidence symbol "page file.ts@1:1"',
        'evidence symbol "page file.ts@1:1" 4096',
      ].join('\n'),
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('UTF-16 page [0, 4096)');
    expect(result.stdout).toContain(
      'Next page: evidence symbol "page file.ts@1:1" 4096',
    );
    expect(result.stdout).toContain('UTF-16 page [4096,');
    expect(result.stdout).toContain('End of verified evidence.');
  });

  it('prints safe, reversible selectors for legal unusual source paths', async () => {
    const formatCharacters = String.fromCodePoint(
      0x7f,
      0x85,
      0x202e,
      0x2066,
      0xe0001,
    );
    const paths = [
      '"leading.ts',
      `control${formatCharacters}.ts`,
      'folder with space/λ@file.ts',
    ];
    const manifest = await manifestFile(
      paths.map((path) => ({ path, source: 'export function root() {}\n' })),
    );
    const listing = await runCli(['--manifest', manifest], 'symbols\nquit\n');
    expect(listing.code).toBe(0);
    expect(listing.stdout).not.toMatch(/[\u007f\u0085\u202e\u2066]/u);
    expect(listing.stdout).not.toContain(String.fromCodePoint(0xe0001));

    const selectorRows = listing.stdout
      .split('\n')
      .filter((line) => line.includes('  function  "root"'));
    const selectors = selectorRows.map((line) =>
      line.slice(0, line.indexOf('  function  "root"')).trim(),
    );
    expect(selectors).toEqual([
      String.raw`"\"leading.ts@1:1"`,
      String.raw`"control\u007f\u0085\u202e\u2066\udb40\udc01.ts@1:1"`,
      String.raw`"folder with space/λ@file.ts@1:1"`,
    ]);

    const replay = await runCli(
      ['--manifest', manifest],
      [...selectors.map((selector) => `inspect ${selector}`), 'quit', ''].join(
        '\n',
      ),
    );
    expect(replay.code).toBe(0);
    expect(replay.stderr).toBe('');
    for (const selector of selectors) expect(replay.stdout).toContain(selector);
  });

  it('escapes terminal controls in source excerpts', async () => {
    const manifest = await manifestFile([
      {
        path: 'control.ts',
        source: `export function root() { /* ${String.fromCharCode(0x1b)}[31m */ }\n`,
      },
    ]);
    const result = await runCli(
      ['--manifest', manifest],
      'evidence symbol control.ts@1:1\n',
    );
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain(String.fromCharCode(0x1b));
    expect(result.stdout).toContain('\\u{1b}');
  });

  it('investigates explicitly selected committed source despite dirty working files', async () => {
    const { directory, revision } = await createCommittedRepository([
      {
        path: 'entry.ts',
        source:
          "import { helper } from './src/target';\nexport function root() { return helper(); }\n",
      },
      {
        path: 'src/target.ts',
        source: 'export function helper() { return 7; }\n',
      },
    ]);
    await writeFile(
      resolve(directory, 'entry.ts'),
      'export function poison() { return poisonTarget(); }\n',
      'utf8',
    );
    await writeFile(
      resolve(directory, 'src/target.ts'),
      'export function poisonTarget() {}\n',
      'utf8',
    );
    await runGitFixture(directory, ['add', '--', 'entry.ts', 'src/target.ts']);
    await runGitFixture(directory, [
      '-c',
      'user.name=CodeThread Test',
      '-c',
      'user.email=codethread-test@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'move branch away from pinned revision',
    ]);
    await writeFile(
      resolve(directory, 'entry.ts'),
      'export function dirtyWorkingTree() {}\n',
      'utf8',
    );

    const result = await runCli(
      [
        '--repo',
        directory,
        '--repository-id',
        '00000000-0000-4000-8000-000000000012',
        '--revision',
        revision,
        '--file',
        'entry.ts',
        '--file',
        'src/target.ts',
      ],
      'inspect entry.ts@2:1 calls outgoing\n',
    );
    const reordered = await runCli(
      [
        '--repo',
        directory,
        '--repository-id',
        '00000000-0000-4000-8000-000000000012',
        '--revision',
        revision,
        '--file',
        'src/target.ts',
        '--file',
        'entry.ts',
      ],
      'inspect entry.ts@2:1 calls outgoing\n',
    );
    const sourceFirst = await acquireGitSources({
        repositoryPath: directory,
        repositoryId: '00000000-0000-4000-8000-000000000012',
        revision,
        selectedPaths: ['entry.ts', 'src/target.ts'],
      }),
      sourceReordered = await acquireGitSources({
        repositoryPath: directory,
        repositoryId: '00000000-0000-4000-8000-000000000012',
        revision,
        selectedPaths: ['src/target.ts', 'entry.ts'],
      }),
      snapshotFirst = await analyzeManifest(sourceFirst.input),
      snapshotReordered = await analyzeManifest(sourceReordered.input);

    expect(result.code).toBe(0);
    expect(reordered.code).toBe(0);
    expect(reordered.stdout).toBe(result.stdout);
    expect(snapshotReordered.facts.identity).toEqual(
      snapshotFirst.facts.identity,
    );
    expect(snapshotReordered.facts.snapshotId).toBe(
      snapshotFirst.facts.snapshotId,
    );
    expect(snapshotReordered.facts.relations).toEqual(
      snapshotFirst.facts.relations,
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('2 selected, 2 admitted, 0 rejected');
    expect(result.stdout).toContain('[CALLS exact] outgoing');
    expect(result.stdout).toContain('"helper" (function)');
    expect(result.stdout).not.toContain('poison');
    expect(result.stdout).toContain('return 7;');
  }, 20_000);

  it('round-trips legal unusual Git paths through safe selectors', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'codethread-git-paths-'));
    temporaryDirectories.push(directory);
    await runGitFixture(directory, ['init', '--quiet']);
    const names = [
      '-leading.ts',
      'space name.ts',
      'quote"name.ts',
      'glob*[x].ts',
      'bidi\u202e.ts',
    ];
    const entries = [];
    for (const [index, name] of names.entries()) {
      const blob = (
        await runGitFixture(
          directory,
          ['hash-object', '-w', '--stdin'],
          `export function root${index}() { return ${index}; }\n`,
        )
      ).trim();
      entries.push({ mode: '100644', type: 'blob', oid: blob, name });
    }
    const tree = await writeFixtureTree(directory, entries),
      commit = (
        await runGitFixture(directory, [
          '-c',
          'user.name=CodeThread Test',
          '-c',
          'user.email=codethread-test@example.invalid',
          'commit-tree',
          tree,
          '-m',
          'unusual literal paths',
        ])
      ).trim();
    await runGitFixture(directory, ['update-ref', 'HEAD', commit]);
    const revision = (
        await runGitFixture(directory, ['rev-parse', 'HEAD'])
      ).trim(),
      inspectCommands = names.map((name) => {
        const selector = JSON.stringify(`${name}@1:1`).replaceAll(
          '\u202e',
          '\\u202e',
        );
        return `inspect ${selector} calls outgoing`;
      }),
      result = await runCli(
        [
          '--repo',
          directory,
          '--repository-id',
          '00000000-0000-4000-8000-000000000012',
          '--revision',
          revision,
          ...names.map((name) => `--file=${name}`),
        ],
        ['files', ...inspectCommands, 'quit', ''].join('\n'),
      );

    expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(
      '5 selected, 5 admitted, 0 rejected, 0 not admitted',
    );
    expect(result.stdout).toContain('"quote\\"name.ts"');
    expect(result.stdout).toContain('bidi\\u202e.ts');
    expect(result.stdout).toContain('glob*[x].ts');
    expect(result.stdout).toContain('"-leading.ts"');
    expect(result.stdout).not.toContain('\u202e');
    for (const index of names.keys())
      expect(result.stdout).toContain(`function "root${index}"`);
  }, 30_000);

  it('rejects unsafe revisions, missing files, and case-colliding selections atomically', async () => {
    const { directory, revision } = await createCommittedRepository([
      { path: 'safe.ts', source: 'export function safe() {}\n' },
    ]);
    const base = [
      '--repo',
      directory,
      '--repository-id',
      '00000000-0000-4000-8000-000000000012',
    ];
    const unsafeRevision = await runCli([
        ...base,
        '--revision',
        'HEAD~1',
        '--file',
        'safe.ts',
      ]),
      invalidQualifiedRef = await runCli([
        ...base,
        '--revision',
        'refs/heads/not..valid',
        '--file',
        'safe.ts',
      ]),
      duplicateRepositoryOption = await runCli([
        ...base,
        '--repo',
        directory,
        '--revision',
        revision,
        '--file',
        'safe.ts',
      ]),
      missingFile = await runCli([
        ...base,
        '--revision',
        revision,
        '--file',
        'missing.ts',
      ]),
      collision = await runCli([
        ...base,
        '--revision',
        revision,
        '--file',
        'safe.ts',
        '--file=SAFE.ts',
      ]);

    expect(unsafeRevision.code).toBe(2);
    expect(unsafeRevision.stderr).toContain('ERROR[INVALID_REVISION]');
    expect(unsafeRevision.stdout).not.toContain(
      'CodeThread textual investigation',
    );
    expect(invalidQualifiedRef.code).toBe(2);
    expect(invalidQualifiedRef.stderr).toContain('ERROR[INVALID_REVISION]');
    expect(invalidQualifiedRef.stdout).not.toContain(
      'CodeThread textual investigation',
    );
    expect(duplicateRepositoryOption.code).toBe(2);
    expect(duplicateRepositoryOption.stderr).toContain(
      'ERROR[INVALID_ARGUMENT]',
    );
    expect(missingFile.code).toBe(2);
    expect(missingFile.stderr).toContain('ERROR[FILE_NOT_FOUND]');
    expect(missingFile.stderr).toContain(
      '1 selected, 0 admitted, 1 rejected, 0 not admitted',
    );
    expect(missingFile.stdout).not.toContain(
      'CodeThread textual investigation',
    );
    expect(collision.code).toBe(2);
    expect(collision.stderr).toContain('ERROR[INVALID_SELECTION]');
    expect(collision.stderr).toContain(
      '2 selected, 0 admitted, 1 rejected, 1 not admitted',
    );
    expect(collision.stdout).not.toContain('CodeThread textual investigation');
  });

  it('rejects symlink and gitlink modes created through Git tree plumbing', async () => {
    const { directory, revision: parent } = await createCommittedRepository([
      { path: 'safe.ts', source: 'export function safe() {}\n' },
    ]);
    const safeBlob = (
        await runGitFixture(directory, ['rev-parse', `${parent}:safe.ts`])
      ).trim(),
      symlinkBlob = (
        await runGitFixture(
          directory,
          ['hash-object', '-w', '--stdin'],
          'safe.ts',
        )
      ).trim(),
      tree = await writeFixtureTree(directory, [
        { mode: '100644', type: 'blob', oid: safeBlob, name: 'safe.ts' },
        { mode: '120000', type: 'blob', oid: symlinkBlob, name: 'link.ts' },
        { mode: '160000', type: 'commit', oid: parent, name: 'submodule.ts' },
      ]),
      commit = (
        await runGitFixture(directory, [
          '-c',
          'user.name=CodeThread Test',
          '-c',
          'user.email=codethread-test@example.invalid',
          'commit-tree',
          tree,
          '-p',
          parent,
          '-m',
          'unsupported tree modes',
        ])
      ).trim();
    await runGitFixture(directory, ['update-ref', 'HEAD', commit]);

    for (const path of ['link.ts', 'submodule.ts']) {
      const result = await runCli([
        '--repo',
        directory,
        '--repository-id',
        '00000000-0000-4000-8000-000000000012',
        '--revision',
        commit,
        `--file=${path}`,
      ]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('ERROR[UNSUPPORTED_FILE_MODE]');
      expect(result.stderr).toContain(
        '1 selected, 0 admitted, 1 rejected, 0 not admitted',
      );
      expect(result.stdout).not.toContain('CodeThread textual investigation');
    }
  }, 30_000);

  it('ignores inherited Git overrides and never reads dirty source or executes configured filters', async () => {
    const { directory, revision } = await createCommittedRepository([
      {
        path: 'safe.ts',
        source: 'export function root() { return 3; }\n',
      },
      { path: '.gitattributes', source: '*.ts filter=codethread\n' },
    ]);
    await runGitFixture(directory, [
      'config',
      'filter.codethread.smudge',
      'codethread-filter-must-not-run',
    ]);
    await runGitFixture(directory, [
      'config',
      'core.hooksPath',
      resolve(directory, 'hooks-that-must-not-run'),
    ]);
    const foreign = await createCommittedRepository([
      { path: 'foreign.ts', source: 'export function poison() {}\n' },
    ]);
    await writeFile(
      resolve(directory, 'safe.ts'),
      'export function workingTreePoison() {}\n',
      'utf8',
    );
    const tracePath = resolve(directory, 'git-trace.log');
    const result = await runCli(
      [
        '--repo',
        directory,
        '--repository-id',
        '00000000-0000-4000-8000-000000000012',
        '--revision',
        revision,
        '--file',
        'safe.ts',
      ],
      'inspect safe.ts@1:1 calls outgoing\n',
      {
        GIT_DIR: resolve(foreign.directory, '.git'),
        GIT_WORK_TREE: foreign.directory,
        GIT_OBJECT_DIRECTORY: resolve(foreign.directory, '.git', 'objects'),
        GIT_TRACE: tracePath,
        GIT_NO_LAZY_FETCH: '0',
        GIT_NO_REPLACE_OBJECTS: '0',
      },
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Pinned Git commit:');
    expect(result.stdout).toContain('function "root"');
    expect(result.stdout).not.toContain('workingTreePoison');
    expect(result.stdout).not.toContain('poison');
    await expect(
      import('node:fs/promises').then(({ lstat }) => lstat(tracePath)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30_000);

  it('reports invalid committed UTF-8 with its source path and no partial session', async () => {
    const directory = await mkdtemp(
      resolve(tmpdir(), 'codethread-git-invalid-'),
    );
    temporaryDirectories.push(directory);
    await runGitFixture(directory, ['init', '--quiet']);
    const blob = (
      await runGitFixture(
        directory,
        ['hash-object', '-w', '--stdin'],
        Buffer.from([0xff, 0xfe]),
      )
    ).trim();
    const tree = await writeFixtureTree(directory, [
        { mode: '100644', type: 'blob', oid: blob, name: 'invalid.ts' },
      ]),
      commit = (
        await runGitFixture(directory, [
          '-c',
          'user.name=CodeThread Test',
          '-c',
          'user.email=codethread-test@example.invalid',
          'commit-tree',
          tree,
          '-m',
          'invalid UTF-8 fixture',
        ])
      ).trim();
    await runGitFixture(directory, ['update-ref', 'HEAD', commit]);
    const result = await runCli([
      '--repo',
      directory,
      '--repository-id',
      '00000000-0000-4000-8000-000000000012',
      '--revision',
      commit,
      '--file',
      'invalid.ts',
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('ERROR[INVALID_ENCODING]');
    expect(result.stderr).toContain('"invalid.ts": rejected');
    expect(result.stdout).not.toContain('CodeThread textual investigation');
  }, 30_000);

  it('attributes malformed committed source to its selected path', async () => {
    const malformed = await createCommittedRepository([
      { path: 'broken.ts', source: 'export function {\n' },
    ]);
    const result = await runCli([
      '--repo',
      malformed.directory,
      '--repository-id',
      '00000000-0000-4000-8000-000000000012',
      '--revision',
      malformed.revision,
      '--file',
      'broken.ts',
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('ERROR[MALFORMED_SOURCE]');
    expect(result.stderr).toContain('"broken.ts": rejected');
    expect(result.stdout).not.toContain('CodeThread textual investigation');
  }, 30_000);

  it('rejects invalid selections and pre-cancelled requests before probing a repository', async () => {
    const invalidPaths = [
      '../escape.ts',
      'folder\\unsafe.ts',
      'control\u0001.ts',
      String.fromCharCode(0xd800) + '.ts',
      'source.tsx',
      Array.from({ length: 65 }, () => 'd').join('/') + '/source.ts',
    ];
    for (const selectedPath of invalidPaths) {
      await expect(
        acquireGitSources({
          repositoryPath: 'no-such-repository',
          repositoryId: '00000000-0000-4000-8000-000000000012',
          revision: 'HEAD',
          selectedPaths: [selectedPath],
        }),
      ).rejects.toMatchObject({
        name: 'GitSourceError',
        code: 'INVALID_SELECTION',
      });
    }
    const controller = new AbortController();
    controller.abort();
    await expect(
      acquireGitSources({
        repositoryPath: 'no-such-repository',
        repositoryId: '00000000-0000-4000-8000-000000000012',
        revision: 'HEAD',
        selectedPaths: ['source.ts'],
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(GitSourceError);
    await expect(
      acquireGitSources({
        repositoryPath: 'no-such-repository',
        repositoryId: 'not-a-uuid',
        revision: 'HEAD',
        selectedPaths: ['source.ts'],
      }),
    ).rejects.toMatchObject({
      name: 'GitSourceError',
      code: 'INVALID_REPOSITORY_ID',
    });
    await expect(
      acquireGitSources({
        repositoryPath: 'no-such-repository',
        repositoryId: '00000000-0000-4000-8000-000000000012',
        revision: 'HEAD',
        selectedPaths: Array.from(
          { length: 21 },
          (_, index) => `file-${index}.ts`,
        ),
      }),
    ).rejects.toMatchObject({ name: 'GitSourceError', code: 'RESOURCE_LIMIT' });
  });

  it('returns typed missing and corrupt object failures without partial analysis', async () => {
    const missing = await createCommittedRepository([
        { path: 'source.ts', source: 'export function source() {}\n' },
      ]),
      missingBlob = (
        await runGitFixture(missing.directory, [
          'rev-parse',
          `${missing.revision}:source.ts`,
        ])
      ).trim();
    await runGitFixture(missing.directory, [
      'config',
      'extensions.partialClone',
      'origin',
    ]);
    await runGitFixture(missing.directory, [
      'config',
      'remote.origin.promisor',
      'true',
    ]);
    await runGitFixture(missing.directory, [
      'config',
      'remote.origin.url',
      'https://invalid.invalid/codethread-no-fetch-test.git',
    ]);
    await rm(
      resolve(
        missing.directory,
        '.git',
        'objects',
        missingBlob.slice(0, 2),
        missingBlob.slice(2),
      ),
    );
    const missingResult = await runCli([
      '--repo',
      missing.directory,
      '--repository-id',
      '00000000-0000-4000-8000-000000000012',
      '--revision',
      missing.revision,
      '--file',
      'source.ts',
    ]);

    const corrupt = await createCommittedRepository([
        { path: 'source.ts', source: 'export function source() {}\n' },
      ]),
      corruptBlob = (
        await runGitFixture(corrupt.directory, [
          'rev-parse',
          `${corrupt.revision}:source.ts`,
        ])
      ).trim();
    const corruptObjectPath = resolve(
      corrupt.directory,
      '.git',
      'objects',
      corruptBlob.slice(0, 2),
      corruptBlob.slice(2),
    );
    await chmod(corruptObjectPath, 0o644);
    await writeFile(corruptObjectPath, Buffer.from('damaged loose object'));
    const corruptResult = await runCli([
      '--repo',
      corrupt.directory,
      '--repository-id',
      '00000000-0000-4000-8000-000000000012',
      '--revision',
      corrupt.revision,
      '--file',
      'source.ts',
    ]);
    expect(missingResult.code).toBe(2);
    expect(missingResult.stderr).toContain('ERROR[MISSING_OBJECT]');
    expect(missingResult.stdout).not.toContain(
      'CodeThread textual investigation',
    );
    expect(corruptResult.code).toBe(2);
    expect(corruptResult.stderr).toContain('ERROR[CORRUPT_OBJECT]');
    expect(corruptResult.stdout).not.toContain(
      'CodeThread textual investigation',
    );
  }, 40_000);

  it('enforces the per-file object limit before retaining source bytes', async () => {
    const oversized = await createCommittedRepository([
      { path: 'large.ts', source: 'x'.repeat(256 * 1024 + 1) },
    ]);
    const result = await runCli([
      '--repo',
      oversized.directory,
      '--repository-id',
      '00000000-0000-4000-8000-000000000012',
      '--revision',
      oversized.revision,
      '--file',
      'large.ts',
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('ERROR[RESOURCE_LIMIT]');
    expect(result.stderr).toContain('"large.ts": rejected');
    expect(result.stdout).not.toContain('CodeThread textual investigation');
  }, 30_000);

  it('enforces the selected-tree entry limit before starting analysis', async () => {
    const directory = await mkdtemp(
      resolve(tmpdir(), 'codethread-git-tree-limit-'),
    );
    temporaryDirectories.push(directory);
    await runGitFixture(directory, ['init', '--quiet']);
    const blob = (
        await runGitFixture(
          directory,
          ['hash-object', '-w', '--stdin'],
          'export function selected() {}\n',
        )
      ).trim(),
      entries = Array.from({ length: 10_001 }, (_, index) => ({
        mode: '100644',
        type: 'blob',
        oid: blob,
        name: `file-${String(index).padStart(5, '0')}.ts`,
      })),
      tree = await writeFixtureTree(directory, entries),
      commit = (
        await runGitFixture(directory, [
          '-c',
          'user.name=CodeThread Test',
          '-c',
          'user.email=codethread-test@example.invalid',
          'commit-tree',
          tree,
          '-m',
          'tree entry resource boundary',
        ])
      ).trim();
    await runGitFixture(directory, ['update-ref', 'HEAD', commit]);
    const result = await runCli([
      '--repo',
      directory,
      '--repository-id',
      '00000000-0000-4000-8000-000000000012',
      '--revision',
      commit,
      '--file',
      'file-00000.ts',
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('ERROR[RESOURCE_LIMIT]');
    expect(result.stdout).not.toContain('CodeThread textual investigation');
  }, 40_000);

  it('rejects bare repositories and linked worktrees explicitly', async () => {
    const bare = await mkdtemp(resolve(tmpdir(), 'codethread-git-bare-'));
    temporaryDirectories.push(bare);
    await runGitFixture(bare, ['init', '--bare', '--quiet']);
    const bareResult = await runCli([
      '--repo',
      bare,
      '--repository-id',
      '00000000-0000-4000-8000-000000000012',
      '--revision',
      'HEAD',
      '--file',
      'source.ts',
    ]);
    expect(bareResult.code).toBe(2);
    expect(bareResult.stderr).toContain('ERROR[UNSUPPORTED_REPOSITORY_LAYOUT]');

    const repository = await createCommittedRepository([
        { path: 'source.ts', source: 'export function source() {}\n' },
      ]),
      linked = await mkdtemp(resolve(tmpdir(), 'codethread-git-linked-'));
    temporaryDirectories.push(linked);
    await rm(linked, { recursive: true, force: true });
    await runGitFixture(repository.directory, [
      'worktree',
      'add',
      '--detach',
      linked,
      repository.revision,
    ]);
    const linkedResult = await runCli([
      '--repo',
      linked,
      '--repository-id',
      '00000000-0000-4000-8000-000000000012',
      '--revision',
      repository.revision,
      '--file',
      'source.ts',
    ]);
    expect(linkedResult.code).toBe(2);
    expect(linkedResult.stderr).toContain(
      'ERROR[UNSUPPORTED_REPOSITORY_LAYOUT]',
    );
    expect(linkedResult.stderr).toContain(
      '1 selected, 0 admitted, 0 rejected, 1 not admitted',
    );

    const alternate = await createCommittedRepository([
      { path: 'source.ts', source: 'export function source() {}\n' },
    ]);
    await mkdir(resolve(alternate.directory, '.git', 'objects', 'info'), {
      recursive: true,
    });
    await writeFile(
      resolve(alternate.directory, '.git', 'objects', 'info', 'alternates'),
      'outside-object-store\n',
      'utf8',
    );
    const alternateResult = await runCli([
      '--repo',
      alternate.directory,
      '--repository-id',
      '00000000-0000-4000-8000-000000000012',
      '--revision',
      alternate.revision,
      '--file',
      'source.ts',
    ]);
    expect(alternateResult.code).toBe(2);
    expect(alternateResult.stderr).toContain(
      'ERROR[UNSUPPORTED_REPOSITORY_LAYOUT]',
    );
  }, 30_000);

  it('accepts the exact two-MiB source boundary and rejects one additional byte', async () => {
    const maxFileBytes = 256 * 1024,
      prefix = 'export function root() {}/*',
      suffix = '*/',
      exactFile =
        prefix +
        'x'.repeat(maxFileBytes - prefix.length - suffix.length) +
        suffix,
      files = Array.from({ length: 8 }, (_, index) => ({
        path: `file-${index}.ts`,
        source: exactFile,
      }));
    files.push({ path: 'zz-extra.ts', source: 'export function extra() {}\n' });
    const repository = await createCommittedRepository(files),
      common = [
        '--repo',
        repository.directory,
        '--repository-id',
        '00000000-0000-4000-8000-000000000012',
        '--revision',
        repository.revision,
      ],
      exact = await runCli([
        ...common,
        ...files.slice(0, 8).flatMap((file) => ['--file', file.path]),
      ]),
      over = await runCli([
        ...common,
        ...files.flatMap((file) => ['--file', file.path]),
      ]);
    expect(exact.code).toBe(0);
    expect(exact.stdout).toContain(
      '8 selected, 8 admitted, 0 rejected, 0 not admitted',
    );
    expect(over.code).toBe(2);
    expect(over.stderr).toContain('ERROR[RESOURCE_LIMIT]');
    expect(over.stderr).toContain(
      '9 selected, 0 admitted, 1 rejected, 8 not admitted',
    );
    expect(over.stdout).not.toContain('CodeThread textual investigation');
  }, 60_000);
});
