import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { SemanticGold } from './semantic-corpus.ts';

type ExternalCall = SemanticGold['calls'][number] & {
  repository: string;
  revision: string;
  sourceSha256: string;
  end: [number, number];
  reason: string;
};
export type ExternalGold = Omit<SemanticGold, 'calls'> & {
  repository: string;
  revision: string;
  calls: ExternalCall[];
};
const diagnostics: Record<string, string | undefined> = {
  'property call': 'CALL_EXPRESSION_UNSUPPORTED',
  'external module': 'EXTERNAL_MODULE',
  'arrow-function owner': 'OWNER_UNSUPPORTED',
  'relative module excluded': 'TARGET_UNRESOLVED',
  'target declaration has compiler errors from unavailable Node inputs':
    'INVALID_BINDING',
  'local declaration': undefined,
  'relative named import': undefined,
};
export async function loadExternalCorpus(name: 'tinyexec' | 'todo') {
  const root = resolve('fixtures/external', name);
  const gold = JSON.parse(
    await readFile(resolve(root, 'gold.json'), 'utf8'),
  ) as ExternalGold;
  const fileEntries = Object.entries(gold.files);
  if (
    new Set(fileEntries.map(([path]) => basename(path))).size !==
    fileEntries.length
  )
    throw new Error('External source names collide');
  const files = await Promise.all(
    fileEntries.map(async ([path, sha256]) => {
      const bytes = await readFile(
        resolve(root, 'sources', basename(path) + '.txt'),
      );
      if (createHash('sha256').update(bytes).digest('hex') !== sha256)
        throw new Error(`External source hash mismatch: ${path}`);
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return { path, sha256, bytes };
    }),
  );
  const calls = gold.calls.map((call) => {
    if (
      call.repository !== gold.repository ||
      call.revision !== gold.revision ||
      call.sourceSha256 !== gold.files[call.file] ||
      !(call.reason in diagnostics)
    )
      throw new Error('Invalid external annotation provenance or reason');
    const diagnostic = diagnostics[call.reason];
    return { ...call, ...(diagnostic ? { diagnostic } : {}) };
  });
  return { gold: { ...gold, calls }, files };
}
