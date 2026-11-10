import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { hash } from './identity.js';
import { PROJECT_LIBRARY_ROOT } from './project-filesystem.js';

export function libraries(requested: readonly string[] = ['lib.es2023.d.ts']): {
  files: Map<string, string>;
  buildHash: string;
} {
  if (ts.version !== '6.0.3') throw new Error('Incorrect TypeScript version');
  const directory = realpathSync(
    dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES2023 })),
  );
  const contents = new Map<string, string>();
  const pending = [...requested];
  while (pending.length) {
    const name = pending.pop()!;
    if (contents.has(name)) continue;
    if (!/^lib\.[a-z0-9.]+\.d\.ts$/.test(name))
      throw new Error('Invalid compiler library');
    const path = realpathSync(join(directory, name));
    if (!path.startsWith(directory + sep))
      throw new Error('Compiler library escaped its toolchain');
    const source = readFileSync(path, 'utf8');
    contents.set(name, source);
    for (const match of source.matchAll(
      /<reference\s+lib="([a-z0-9.]+)"\s*\/>/g,
    ))
      pending.push(`lib.${match[1]}.d.ts`);
  }
  const digest = createHash('sha256');
  digest.update('codethread-analyzer-build-v2\0typescript-6.0.3\0');
  for (const [name, text] of [...contents].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  ))
    digest.update(name + '\0' + hash(text) + '\0');
  digest.update(hash(readFileSync(join(directory, 'typescript.js'))));
  const own = dirname(fileURLToPath(import.meta.url));
  for (const name of readdirSync(own)
    .filter((item) => item.endsWith('.js'))
    .sort()) {
    digest.update(
      name +
        '\0' +
        hash(readFileSync(join(own, name), 'utf8').replaceAll('\r\n', '\n')) +
        '\0',
    );
  }
  const model = fileURLToPath(import.meta.resolve('@codethread/code-model'));
  digest.update(hash(readFileSync(model, 'utf8').replaceAll('\r\n', '\n')));
  return {
    files: new Map(
      [...contents].map(([name, source]) => [
        PROJECT_LIBRARY_ROOT + '/' + name,
        source,
      ]),
    ),
    buildHash: digest.digest('hex'),
  };
}
