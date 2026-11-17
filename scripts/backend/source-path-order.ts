/** PostgreSQL COLLATE "C" order for valid UTF-8 Git paths. */
export function compareSourcePaths(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
