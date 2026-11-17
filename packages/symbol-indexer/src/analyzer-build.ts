import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** Fingerprint the installed executable analyzer and its pinned compiler inputs. */
export function analyzerBuildHash(): string {
  if (ts.version !== '6.0.3') throw new Error('Incorrect TypeScript version');
  const digest = createHash('sha256');
  digest.update(
    'codethread-analyzer-build-v3\0node-' + process.versions.node + '\0',
  );
  const add = (name: string, path: string) => {
    const contentHash = createHash('sha256')
      .update(readFileSync(path))
      .digest('hex');
    digest.update(name + '\0' + contentHash + '\0');
  };
  const addTree = (label: string, root: string, directory = '') => {
    for (const entry of readdirSync(join(root, directory), {
      withFileTypes: true,
    }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const relative = directory ? directory + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink())
        throw new Error(
          'Analyzer build inputs must not contain symbolic links',
        );
      if (entry.isDirectory()) addTree(label, root, relative);
      else if (entry.isFile() && /\.(?:js|cjs|json)$/.test(entry.name))
        add(label + '/' + relative, join(root, ...relative.split('/')));
    }
  };
  const own = dirname(fileURLToPath(import.meta.url));
  const model = fileURLToPath(import.meta.resolve('@codethread/code-model'));
  const modelDirectory = dirname(model);
  addTree('symbol-indexer', own);
  addTree('code-model', modelDirectory);
  const requireModel = createRequire(model);
  addTree('zod', dirname(realpathSync(requireModel.resolve('zod'))));
  const compiler = realpathSync(
    dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES2023 })),
  );
  for (const name of readdirSync(compiler).sort()) {
    if (name === 'typescript.js' || /^lib\.[a-z0-9.]+\.d\.ts$/.test(name))
      add('typescript/' + name, join(compiler, name));
  }
  return digest.digest('hex');
}
