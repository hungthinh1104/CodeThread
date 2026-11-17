import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import ts from 'typescript';
import { analyzerBuildHash } from './analyzer-build.js';
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
  return {
    files: new Map(
      [...contents].map(([name, source]) => [
        PROJECT_LIBRARY_ROOT + '/' + name,
        source,
      ]),
    ),
    buildHash: analyzerBuildHash(),
  };
}
