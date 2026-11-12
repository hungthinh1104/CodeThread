import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, basename, sep } from 'node:path';
import { deflateSync } from 'node:zlib';
import { resolveGitExecutable } from './git-source/process.ts';
import type { RepositoryCorpus } from './repository-corpus.ts';

/** Restore pinned object bytes into fresh trusted Git metadata, without checking out source. */
export async function materializeRepositoryCorpus(corpus: RepositoryCorpus) {
  const parent = resolve(tmpdir()),
    directory = await mkdtemp(resolve(parent, 'codethread-corpus-'));
  const cleanup = async () => {
    const absolute = resolve(directory);
    if (
      !absolute.startsWith(parent + sep) ||
      !basename(absolute).startsWith('codethread-corpus-')
    )
      throw new Error('Invalid corpus cleanup boundary');
    await rm(absolute, { recursive: true, force: true });
  };
  try {
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (key.startsWith('GIT_')) delete env[key];
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
    env.GIT_TERMINAL_PROMPT = '0';
    const executable = await resolveGitExecutable(directory);
    await promisify(execFile)(
      executable,
      ['init', '--quiet', '--object-format=sha1', directory],
      {
        env,
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 64 * 1024,
      },
    );
    for (const object of corpus.objects) {
      const path = resolve(
        directory,
        '.git',
        'objects',
        object.oid.slice(0, 2),
        object.oid.slice(2),
      );
      const bytes = Buffer.concat([
        Buffer.from(`${object.type} ${object.bytes.length}\0`),
        Buffer.from(object.bytes),
      ]);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, deflateSync(bytes));
    }
    return { directory, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
