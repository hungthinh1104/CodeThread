import { execFileSync } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzerBuildHash } from '@codethread/symbol-indexer';

describe('installed analyzer identity', () => {
  it('is location independent and changes when executed dependencies change', async () => {
    await mkdir(join(process.cwd(), '.tooling'), { recursive: true });
    const root = await mkdtemp(join(process.cwd(), '.tooling', 'identity-'));
    try {
      const indexer = join(root, 'indexer');
      const model = join(root, 'node_modules', '@codethread', 'code-model');
      await mkdir(indexer, { recursive: true });
      await mkdir(model, { recursive: true });
      await cp('packages/symbol-indexer/dist', join(indexer, 'dist'), {
        recursive: true,
      });
      await cp('packages/code-model/dist', join(model, 'dist'), {
        recursive: true,
      });
      await writeFile(join(indexer, 'package.json'), '{"type":"module"}');
      await writeFile(
        join(model, 'package.json'),
        '{"type":"module","exports":"./dist/index.js"}',
      );
      const entry = pathToFileURL(
        join(indexer, 'dist', 'analyzer-build.js'),
      ).href;
      const fingerprint = () =>
        execFileSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `import {analyzerBuildHash} from ${JSON.stringify(entry)}; console.log(analyzerBuildHash());`,
          ],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
        ).trim();
      const expected = analyzerBuildHash();
      expect(fingerprint()).toBe(expected);
      const modelRuntime = join(model, 'dist', 'resources.js');
      const original = await readFile(modelRuntime);
      await writeFile(
        modelRuntime,
        Buffer.concat([original, Buffer.from('\n// changed\n')]),
      );
      expect(fingerprint()).not.toBe(expected);
      await writeFile(modelRuntime, original);
      const worker = join(indexer, 'dist', 'worker.js');
      const workerOriginal = await readFile(worker);
      await writeFile(
        worker,
        Buffer.concat([workerOriginal, Buffer.from('\n// changed\n')]),
      );
      expect(fingerprint()).not.toBe(expected);
      await writeFile(worker, workerOriginal);
      expect(fingerprint()).toBe(expected);

      const link = join(indexer, 'dist', 'linked-directory');
      await symlink(model, link, 'junction');
      expect(() => fingerprint()).toThrow();
      await unlink(link);

      const workerText = workerOriginal.toString('utf8');
      const marker = 'analyzerBuildHash: compiled.buildHash';
      expect(workerText).toContain(marker);
      await writeFile(
        worker,
        workerText.replace(marker, "analyzerBuildHash: '0'.repeat(64)"),
      );
      const index = pathToFileURL(join(indexer, 'dist', 'index.js')).href;
      const script = `
        import { analyzeManifest, COMPILER_PROFILE } from ${JSON.stringify(index)};
        import { createHash } from 'node:crypto';
        const bytes = Buffer.from('export const value = 1;');
        try {
          await analyzeManifest({ repositoryId: '11111111-1111-4111-8111-111111111111',
            compilerOptions: COMPILER_PROFILE,
            files: [{ path: 'index.ts', bytes, sha256: createHash('sha256').update(bytes).digest('hex') }] });
          console.log('unexpected success');
        } catch (error) { console.log(error.code); }
      `;
      expect(
        execFileSync(process.execPath, ['--input-type=module', '-e', script], {
          encoding: 'utf8',
          timeout: 20_000,
        }).trim(),
      ).toBe('ANALYZER_BUILD_MISMATCH');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
