import { lstat, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { idSchema, isSnapshotPath, hashSchema } from '@codethread/code-model';
import { ANALYSIS_LIMITS, COMPILER_PROFILE } from '@codethread/symbol-indexer';
import type { AnalysisInput } from '@codethread/symbol-indexer';
import { CliError } from './commands.ts';
import {
  loadExternalCorpus,
  loadTodoClosure,
} from '../external-semantic-corpus.ts';
export const MAX_MANIFEST_BYTES = 3 * 1024 * 1024;
export const MAX_SOURCE_FILES = ANALYSIS_LIMITS.maxFiles;
export const MAX_SOURCE_FILE_BYTES = ANALYSIS_LIMITS.maxFileBytes;
export const MAX_TOTAL_SOURCE_BYTES = ANALYSIS_LIMITS.maxTotalBytes;
const DEFAULT_REPOSITORY_ID = '00000000-0000-4000-8000-000000000012';
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}

function estimatedBase64Bytes(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

export function parseManifest(bytes: Uint8Array): AnalysisInput {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new CliError('INVALID_MANIFEST', 'Manifest must be strict UTF-8.');
  }
  if (text.startsWith('\uFEFF')) text = text.slice(1);

  const document = parseDocument(text, { uniqueKeys: true, strict: true });
  if (document.errors.length > 0 || document.warnings.length > 0)
    throw new CliError(
      'INVALID_MANIFEST',
      'Manifest must be strict JSON with unique object keys.',
    );

  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new CliError('INVALID_MANIFEST', 'Manifest is not valid JSON.');
  }
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ['version', 'repositoryId', 'files']) ||
    raw['version'] !== 1 ||
    !Array.isArray(raw['files']) ||
    raw['files'].length < 1 ||
    raw['files'].length > MAX_SOURCE_FILES
  )
    throw new CliError(
      'INVALID_MANIFEST',
      `Expected version 1 and between 1 and ${MAX_SOURCE_FILES} files.`,
    );

  const repositoryId = idSchema.safeParse(raw['repositoryId']);
  if (!repositoryId.success)
    throw new CliError('INVALID_MANIFEST', 'repositoryId must be a UUID.');

  let totalBytes = 0;
  const seenPaths = new Set<string>();
  const files: AnalysisInput['files'][number][] = [];
  for (const [index, item] of raw['files'].entries()) {
    if (
      !isRecord(item) ||
      !hasExactKeys(item, ['path', 'sha256', 'contentBase64']) ||
      typeof item['path'] !== 'string' ||
      typeof item['sha256'] !== 'string' ||
      typeof item['contentBase64'] !== 'string'
    )
      throw new CliError(
        'INVALID_MANIFEST',
        `files[${index}] must contain path, sha256 and contentBase64.`,
      );

    const { path, sha256, contentBase64 } = item;
    if (!isSnapshotPath(path) || !hashSchema.safeParse(sha256).success)
      throw new CliError(
        'INVALID_MANIFEST',
        `files[${index}] has an unsafe path or invalid SHA-256.`,
      );
    if (seenPaths.has(path))
      throw new CliError('INVALID_MANIFEST', `Duplicate source path: ${path}`);
    seenPaths.add(path);
    if (contentBase64.length % 4 !== 0 || !BASE64_PATTERN.test(contentBase64))
      throw new CliError(
        'INVALID_MANIFEST',
        `files[${index}].contentBase64 is not canonical base64.`,
      );

    const expectedBytes = estimatedBase64Bytes(contentBase64);
    if (expectedBytes > MAX_SOURCE_FILE_BYTES)
      throw new CliError(
        'RESOURCE_LIMIT',
        `${path} exceeds the ${MAX_SOURCE_FILE_BYTES}-byte per-file limit.`,
      );
    totalBytes += expectedBytes;
    if (totalBytes > MAX_TOTAL_SOURCE_BYTES)
      throw new CliError(
        'RESOURCE_LIMIT',
        `Manifest sources exceed the ${MAX_TOTAL_SOURCE_BYTES}-byte total limit.`,
      );

    const sourceBytes = Buffer.from(contentBase64, 'base64');
    if (
      sourceBytes.byteLength !== expectedBytes ||
      sourceBytes.toString('base64') !== contentBase64
    )
      throw new CliError(
        'INVALID_MANIFEST',
        `files[${index}].contentBase64 is not canonical.`,
      );
    files.push({ path, sha256, bytes: sourceBytes });
  }

  return {
    repositoryId: repositoryId.data,
    compilerOptions: COMPILER_PROFILE,
    files,
  };
}

function sameFile(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
) {
  return left.dev === right.dev && left.ino === right.ino;
}

export async function readManifestFile(filePath: string): Promise<Uint8Array> {
  if (filePath.length > 4096)
    throw new CliError('INVALID_ARGUMENT', 'Manifest path is too long.');
  const absolutePath = resolve(filePath);
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(absolutePath);
  } catch {
    throw new CliError(
      'MANIFEST_UNAVAILABLE',
      'Cannot read the manifest file.',
    );
  }
  if (!before.isFile() || before.isSymbolicLink())
    throw new CliError(
      'INVALID_MANIFEST',
      'Manifest path must name a regular, non-symlink file.',
    );
  if (before.size > MAX_MANIFEST_BYTES)
    throw new CliError(
      'MANIFEST_TOO_LARGE',
      `Manifest exceeds the ${MAX_MANIFEST_BYTES}-byte file limit.`,
    );

  const handle = await open(absolutePath, 'r').catch(() => {
    throw new CliError(
      'MANIFEST_UNAVAILABLE',
      'Cannot read the manifest file.',
    );
  });
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      !sameFile(before, opened) ||
      opened.size !== before.size ||
      opened.size > MAX_MANIFEST_BYTES
    )
      throw new CliError(
        'MANIFEST_CHANGED',
        'Manifest changed while it was being opened.',
      );

    const buffer = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (
      length > MAX_MANIFEST_BYTES ||
      length !== opened.size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    )
      throw new CliError(
        length > MAX_MANIFEST_BYTES ? 'MANIFEST_TOO_LARGE' : 'MANIFEST_CHANGED',
        length > MAX_MANIFEST_BYTES
          ? `Manifest exceeds the ${MAX_MANIFEST_BYTES}-byte file limit.`
          : 'Manifest changed while it was being read.',
      );
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

export async function loadTodoDemo(): Promise<AnalysisInput> {
  const original = await loadExternalCorpus('todo');
  const closure = await loadTodoClosure();
  return {
    repositoryId: DEFAULT_REPOSITORY_ID,
    compilerOptions: COMPILER_PROFILE,
    files: [...original.files, ...closure].map(({ path, sha256, bytes }) => ({
      path,
      sha256,
      bytes,
    })),
  };
}
