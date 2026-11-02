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
const todoClosure = [
  {
    path: 'routes/auth.router.ts',
    byteLength: 228,
    sha256: '10394dda38710b099f969261aea34cee35031960f1e0e9cda1b3164eabb45ff3',
    gitBlob: '397ac5a2c05307dc6bab2d28c511da303226cf6c',
  },
  {
    path: 'routes/user.router.ts',
    byteLength: 289,
    sha256: 'b5c300467588f00f7a23dd970b71ff0fff42b1420a7bf031c7771111b711c28b',
    gitBlob: '72bc9eae0f9a077e7836a4f983bdabec34a99343',
  },
  {
    path: 'config/passport.ts',
    byteLength: 1839,
    sha256: 'be8d28b84a3ac2632b905c5bec3b284c70c210d1a2d96015b1b7f469674d0c6c',
    gitBlob: '746ec3004287c7d333e2beb44813706bc5dcd6df',
  },
  {
    path: 'controllers/todo.controller.ts',
    byteLength: 2333,
    sha256: '3d1a82e2db7af3c8af876ff445fce286517c3636ee571f4094ea22e9b48195c2',
    gitBlob: '41be3af14444631c108724f261e77f3c0360c208',
  },
  {
    path: 'models/todo.ts',
    byteLength: 1447,
    sha256: '1e93beb954c55d2e2ca093264c8fcbe2a9d26d9591b3a0c8c846b4b60ad024ad',
    gitBlob: 'be04b61cd0ae1c766b27276536b7318f23115aea',
  },
] as const;
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

/** Additional source bytes from the same pinned ts-node-todo commit. */
export async function loadTodoClosure() {
  const root = resolve('fixtures/external/todo/closure');
  const files = await Promise.all(
    todoClosure.map(async ({ path, byteLength, sha256, gitBlob }) => {
      const bytes = await readFile(resolve(root, ...path.split('/')));
      const gitObjectHash = createHash('sha1')
        .update(`blob ${bytes.byteLength}\0`)
        .update(bytes)
        .digest('hex');
      if (
        bytes.byteLength !== byteLength ||
        createHash('sha256').update(bytes).digest('hex') !== sha256 ||
        gitObjectHash !== gitBlob
      )
        throw new Error(`Pinned upstream closure source mismatch: ${path}`);
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return { path, sha256, bytes };
    }),
  );
  return files;
}
