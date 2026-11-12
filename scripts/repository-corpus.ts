import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { hashSchema, snapshotPathSchema } from '@codethread/code-model';
import { z } from 'zod';

const pins = {
  ufo: {
    repository: 'https://github.com/unjs/ufo',
    revision: 'f06c800d0c59f2a4a1b9ba65eb6cb61a84419be6',
    files: 21,
  },
  sourcemaps: {
    repository: 'https://github.com/jridgewell/sourcemaps',
    revision: 'b7600158f4de012d246b7834a73c7c2190e75136',
    files: 53,
  },
} as const;
export type RepositoryCorpusName = keyof typeof pins;
const oid = z.string().regex(/^[a-f0-9]{40}$/);
const fileSchema = z.strictObject({
  path: snapshotPathSchema,
  blobId: oid,
  mode: z.enum(['100644', '100755']),
  byteLength: z
    .number()
    .int()
    .min(0)
    .max(1024 * 1024),
  sha256: hashSchema,
});
const objectSchema = z.strictObject({
  oid,
  base64: z.string().max(2 * 1024 * 1024),
});
const manifestSchema = z.strictObject({
  version: z.literal(1),
  repository: z.string(),
  revision: oid,
  objectFormat: z.literal('sha1'),
  rootTreeId: oid,
  scope: z.literal('all_regular_tracked_ts'),
  reviewStatus: z.literal('not_independently_reviewed'),
  files: z.array(fileSchema).min(1).max(1000),
  metadata: z.array(fileSchema).max(256),
  licenses: z.array(fileSchema).min(1).max(64),
  commit: objectSchema,
  trees: z.array(objectSchema).min(1).max(8192),
});
export type RepositoryCorpusManifest = z.infer<typeof manifestSchema>;
export interface CorpusGitObject {
  oid: string;
  type: 'commit' | 'tree' | 'blob';
  bytes: Uint8Array;
}

function gitObject(
  type: CorpusGitObject['type'],
  bytes: Uint8Array,
  expected: string,
): CorpusGitObject {
  const actual = createHash('sha1')
    .update(`${type} ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');
  if (actual !== expected) throw new Error('Pinned corpus Git object mismatch');
  return { oid: expected, type, bytes };
}
function decodeObject(
  type: 'commit' | 'tree',
  input: z.infer<typeof objectSchema>,
) {
  const bytes = Buffer.from(input.base64, 'base64');
  if (bytes.toString('base64') !== input.base64 || bytes.length > 1024 * 1024)
    throw new Error('Invalid corpus object encoding');
  return gitObject(type, bytes, input.oid);
}

/** Byte and Git identities are checked before any repository analysis or scoring. */
export async function loadRepositoryCorpus(name: RepositoryCorpusName) {
  const pin = pins[name];
  const root = resolve('fixtures/external', name),
    manifestPath = resolve(root, 'repository.json');
  if ((await lstat(manifestPath)).size > 16 * 1024 * 1024)
    throw new Error('Corpus manifest is too large');
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(manifestPath, 'utf8')),
  );
  if (
    manifest.repository !== pin.repository ||
    manifest.revision !== pin.revision ||
    manifest.commit.oid !== pin.revision ||
    manifest.files.length !== pin.files
  )
    throw new Error(
      'Corpus revision or independently inventoried source count changed',
    );
  const closure = await realpath(resolve(root, 'closure'));
  const paths = new Set<string>();
  const objects = new Map<string, CorpusGitObject>();
  const commit = decodeObject('commit', manifest.commit);
  objects.set(commit.oid, commit);
  const treeHeader = Buffer.from(commit.bytes)
    .toString('latin1')
    .split('\n')
    .filter((line) => line.startsWith('tree '));
  if (
    treeHeader.length !== 1 ||
    treeHeader[0] !== 'tree ' + manifest.rootTreeId
  )
    throw new Error('Corpus commit tree mismatch');
  for (const tree of manifest.trees) {
    const object = decodeObject('tree', tree);
    objects.set(object.oid, object);
  }
  if (!objects.has(manifest.rootTreeId))
    throw new Error('Corpus root tree proof is missing');
  const readInputs = async (
    records: readonly z.infer<typeof fileSchema>[],
    maximum: number,
  ) => {
    const files = [];
    let total = 0;
    for (const record of records) {
      if (paths.has(record.path.toLowerCase()))
        throw new Error('Corpus input paths collide');
      paths.add(record.path.toLowerCase());
      const path = resolve(closure, record.path),
        info = await lstat(path);
      if (
        !path.startsWith(closure + sep) ||
        !info.isFile() ||
        info.size !== record.byteLength ||
        !(await realpath(path)).startsWith(closure + sep)
      )
        throw new Error('Corpus source escaped or changed size');
      const bytes = await readFile(path);
      total += bytes.length;
      if (
        total > maximum ||
        createHash('sha256').update(bytes).digest('hex') !== record.sha256
      )
        throw new Error('Corpus raw source hash or byte bound mismatch');
      const object = gitObject('blob', bytes, record.blobId);
      objects.set(object.oid, object);
      files.push({ ...record, bytes });
    }
    return files;
  };
  const files = await readInputs(manifest.files, 32 * 1024 * 1024);
  const metadata = await readInputs(manifest.metadata, 4 * 1024 * 1024);
  const licenses = await readInputs(manifest.licenses, 4 * 1024 * 1024);
  return {
    name,
    manifest,
    files,
    metadata,
    licenses,
    objects: [...objects.values()],
  };
}
export type RepositoryCorpus = Awaited<ReturnType<typeof loadRepositoryCorpus>>;
