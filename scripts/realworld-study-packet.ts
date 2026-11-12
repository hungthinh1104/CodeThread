import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const TASK_BANK_PATH = 'docs/evaluation/ct-realworld-001/tasks.json';
const REPOSITORY_SET_PATH =
  'docs/evaluation/ct-realworld-001/repositories.json';
const MAX_PACKET_BYTES = 16 * 1024 * 1024;
export const EXPECTED_TASK_BANK_SHA256 =
  'f5a9c52556d96ae70b90d5482efd3593b00fa68a596353e0a9d67709300f9e75';
export const EXPECTED_REPOSITORY_SET_SHA256 =
  'de14e354a9d2151f74736ab827cb746a534967b8f241f6dc427928aa59828de9';
const REPOSITORY_KEYS = ['hono', 'pinia', 'zod'] as const;
const TASK_COUNTS = { hono: 5, zod: 5, pinia: 5 } as const;
const LABEL_COUNTS = { exact: 22, non_exact: 4, no_exact_relation: 2 } as const;

export class RealworldStudyError extends Error {
  readonly code: string;
  readonly details: readonly unknown[];

  constructor(code: string, details: readonly unknown[] = []) {
    super(code);
    this.name = 'RealworldStudyError';
    this.code = code;
    this.details = details;
  }
}

export interface FrozenPacket {
  tasks: Record<string, unknown>;
  repositories: Record<string, unknown>;
  taskBankSha256: string;
  repositorySetSha256: string;
  taskCount: number;
  labelCounts: Record<keyof typeof LABEL_COUNTS, number>;
}

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function readRegularFile(
  path: string,
  maxBytes: number,
  missingCode: string,
  invalidCode: string,
  tooLargeCode: string,
): Promise<Buffer> {
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    throw new RealworldStudyError(missingCode);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new RealworldStudyError(invalidCode);
  }
  if (stat.size > maxBytes) throw new RealworldStudyError(tooLargeCode);
  try {
    return await readFile(path);
  } catch {
    throw new RealworldStudyError(invalidCode);
  }
}

export function parseJson(
  bytes: Buffer,
  code: string,
): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
    );
    if (!isRecord(value)) throw new Error('not an object');
    return value;
  } catch {
    throw new RealworldStudyError(code);
  }
}

function validatePacketShape(
  tasks: Record<string, unknown>,
  repositories: Record<string, unknown>,
): {
  taskCount: number;
  labelCounts: Record<keyof typeof LABEL_COUNTS, number>;
} {
  if (
    tasks['format'] !== 'codethread-ct-realworld-001-task-bank-v1' ||
    !Array.isArray(tasks['tasks']) ||
    tasks['tasks'].length !== 15
  ) {
    throw new RealworldStudyError('TASK_BANK_INVALID');
  }
  const seenTaskIds = new Set<string>();
  const taskCounts: Record<(typeof REPOSITORY_KEYS)[number], number> = {
    hono: 0,
    pinia: 0,
    zod: 0,
  };
  const labelCounts = { exact: 0, non_exact: 0, no_exact_relation: 0 };
  const seenLabelIds = new Set<string>();

  for (const value of tasks['tasks']) {
    if (!isRecord(value)) throw new RealworldStudyError('TASK_BANK_INVALID');
    const id = value['id'];
    const repository = value['repository'];
    if (
      typeof id !== 'string' ||
      seenTaskIds.has(id) ||
      typeof repository !== 'string' ||
      !Object.hasOwn(taskCounts, repository) ||
      typeof value['prompt'] !== 'string' ||
      value['prompt'].trim() === '' ||
      !Array.isArray(value['workflow']) ||
      value['workflow'].length === 0 ||
      !Array.isArray(value['labels'])
    ) {
      throw new RealworldStudyError('TASK_BANK_INVALID');
    }
    seenTaskIds.add(id);
    taskCounts[repository as keyof typeof taskCounts] += 1;

    for (const label of value['labels']) {
      if (!isRecord(label)) throw new RealworldStudyError('TASK_BANK_INVALID');
      const labelId = label['id'];
      const expected = label['expected'];
      if (
        typeof labelId !== 'string' ||
        seenLabelIds.has(labelId) ||
        !Object.hasOwn(labelCounts, expected as string) ||
        !['CALLS', 'REFERENCES'].includes(label['family'] as string)
      ) {
        throw new RealworldStudyError('TASK_BANK_INVALID');
      }
      seenLabelIds.add(labelId);
      labelCounts[expected as keyof typeof labelCounts] += 1;
    }
  }

  if (
    Object.entries(TASK_COUNTS).some(
      ([key, count]) => taskCounts[key as keyof typeof taskCounts] !== count,
    ) ||
    Object.entries(LABEL_COUNTS).some(
      ([key, count]) => labelCounts[key as keyof typeof labelCounts] !== count,
    ) ||
    seenLabelIds.size !== 28
  ) {
    throw new RealworldStudyError('TASK_BANK_INVALID');
  }

  if (
    repositories['format'] !==
      'codethread-ct-realworld-001-repository-set-v1' ||
    !Array.isArray(repositories['externalRepositories']) ||
    repositories['externalRepositories'].length !== REPOSITORY_KEYS.length
  ) {
    throw new RealworldStudyError('REPOSITORY_SET_INVALID');
  }
  const repositoryByKey = new Map<string, Record<string, unknown>>();
  for (const value of repositories['externalRepositories']) {
    if (!isRecord(value) || typeof value['key'] !== 'string') {
      throw new RealworldStudyError('REPOSITORY_SET_INVALID');
    }
    repositoryByKey.set(value['key'], value);
  }
  for (const key of REPOSITORY_KEYS) {
    const repository = repositoryByKey.get(key);
    const commit = repository?.['commit'];
    const tree = repository?.['tree'];
    const inventory = repository?.['inventory'];
    if (
      !repository ||
      !/^[0-9a-f]{40}$/.test(String(commit)) ||
      !/^[0-9a-f]{40}$/.test(String(tree)) ||
      !isRecord(inventory) ||
      typeof inventory['regularTsFiles'] !== 'number' ||
      typeof inventory['regularTsBytes'] !== 'number' ||
      inventory['regularTsFiles'] < 0 ||
      inventory['regularTsFiles'] > 1000 ||
      inventory['regularTsBytes'] < 0 ||
      inventory['regularTsBytes'] > 32 * 1024 * 1024
    ) {
      throw new RealworldStudyError('REPOSITORY_SET_INVALID');
    }
  }

  return { taskCount: seenTaskIds.size, labelCounts };
}

export async function loadFrozenPacket(
  repositoryRoot: string,
): Promise<FrozenPacket> {
  const taskBytes = await readRegularFile(
    resolve(repositoryRoot, TASK_BANK_PATH),
    MAX_PACKET_BYTES,
    'TASK_BANK_UNAVAILABLE',
    'TASK_BANK_INVALID',
    'TASK_BANK_TOO_LARGE',
  );
  const repositoryBytes = await readRegularFile(
    resolve(repositoryRoot, REPOSITORY_SET_PATH),
    MAX_PACKET_BYTES,
    'REPOSITORY_SET_UNAVAILABLE',
    'REPOSITORY_SET_INVALID',
    'REPOSITORY_SET_TOO_LARGE',
  );
  const taskBankSha256 = sha256(taskBytes);
  const repositorySetSha256 = sha256(repositoryBytes);
  if (
    taskBankSha256 !== EXPECTED_TASK_BANK_SHA256 ||
    repositorySetSha256 !== EXPECTED_REPOSITORY_SET_SHA256
  ) {
    throw new RealworldStudyError('FROZEN_PACKET_DIGEST_MISMATCH', [
      { taskBankSha256, repositorySetSha256 },
    ]);
  }
  const tasks = parseJson(taskBytes, 'TASK_BANK_INVALID');
  const repositories = parseJson(repositoryBytes, 'REPOSITORY_SET_INVALID');
  const shape = validatePacketShape(tasks, repositories);
  return {
    tasks,
    repositories,
    taskBankSha256,
    repositorySetSha256,
    ...shape,
  };
}
