import { createHash, timingSafeEqual } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { relative, isAbsolute, sep } from 'node:path';
import { z } from 'zod';

export const uuid = z.uuid();
export const hash = z.string().regex(/^[0-9a-f]{64}$/);
export const requestScan = z.strictObject({
  revision: z.string().min(1).max(1024),
  idempotencyKey: z.string().min(1).max(128),
});
export const registerRepository = z.strictObject({
  locator: z.string().min(1).max(4096),
});
export const querySymbols = z.strictObject({
  query: z.string().max(256).default(''),
  offset: z.number().int().min(0).max(20000).default(0),
});
export const bodyNeighbors = z.strictObject({ request: z.unknown() });
export const bodyEvidence = z.strictObject({ request: z.unknown() });
export function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
export function tokenMatch(actual: string | undefined, expected: string): boolean {
  if (!actual?.startsWith('Bearer ')) return false;
  const a = Buffer.from(actual.slice(7)), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export async function allowedRepository(locator: string, allowedRoot: string): Promise<string> {
  const root = await realpath(allowedRoot);
  const candidate = await realpath(locator);
  const remainder = relative(root, candidate);
  if (!isAbsolute(root) || remainder === '' || remainder === '..' ||
    remainder.startsWith('..' + sep) || isAbsolute(remainder))
    throw new Error('Repository locator is outside the permitted root');
  return candidate;
}
export function serviceConfig() {
  const url = process.env.CODETHREAD_DATABASE_URL;
  const secret = process.env.CODETHREAD_API_TOKEN;
  const root = process.env.CODETHREAD_ALLOWED_REPO_ROOT;
  const analyzerBuildHash = process.env.CODETHREAD_ANALYZER_BUILD_HASH;
  if (!url || !secret || secret.length < 32 || !root ||
      !analyzerBuildHash || !hash.safeParse(analyzerBuildHash).success)
    throw new Error('Database URL, 32+ character API token, allowed repository root and verified analyzer build hash are required');
  return { url, secret, root, analyzerBuildHash, port: 8765 };
}
