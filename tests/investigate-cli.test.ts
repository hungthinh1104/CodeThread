import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

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
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', scriptPath, ...args],
    { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] },
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
      'inspect name:same\n',
    );
    expect(ambiguous.code).toBe(2);
    expect(ambiguous.stderr).toContain('ERROR[SYMBOL_AMBIGUOUS]');
    expect(ambiguous.stderr).toContain('a.ts@1:1');
    expect(ambiguous.stderr).toContain('b.ts@1:1');

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
});
