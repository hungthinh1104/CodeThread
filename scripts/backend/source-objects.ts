import { createHash } from 'node:crypto';
import type { Database } from './database.ts';

export interface SourceObjectInput {
  sha256: string;
  bytes: Uint8Array;
}

export function hashSourceBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function storeSourceObjects(
  db: Database,
  files: readonly SourceObjectInput[],
): Promise<void> {
  const unique = new Map<string, Uint8Array>();
  for (const file of files) {
    if (hashSourceBytes(file.bytes) !== file.sha256)
      throw new Error('Source hash mismatch before storage');
    const previous = unique.get(file.sha256);
    if (previous && !Buffer.from(previous).equals(Buffer.from(file.bytes)))
      throw new Error('Conflicting bytes share one source object hash');
    unique.set(file.sha256, file.bytes);
  }

  const entries = [...unique.entries()];
  for (let offset = 0; offset < entries.length; offset += 200) {
    const chunk = entries.slice(offset, offset + 200);
    const values = chunk.map((_, index) => {
      const parameter = index * 3;
      return `($${parameter + 1},$${parameter + 2},$${parameter + 3})`;
    });
    const parameters = chunk.flatMap(([sha256, bytes]) => [
      sha256,
      Buffer.from(bytes),
      bytes.byteLength,
    ]);
    await db.unsafe(
      `INSERT INTO codethread.source_object(sha256,bytes,byte_length)
       VALUES ${values.join(',')}
       ON CONFLICT (sha256) DO NOTHING`,
      parameters as Parameters<Database['unsafe']>[1],
    );
    const hashes = chunk.map(([sha256]) => sha256),
      slots = hashes.map((_, index) => `$${index + 1}`).join(',');
    const stored = await db.unsafe(
      `SELECT sha256,bytes,byte_length FROM codethread.source_object
       WHERE sha256 IN (${slots})`,
      hashes,
    );
    const byHash = new Map(stored.map((row) => [String(row.sha256), row]));
    for (const [sha256, expected] of chunk) {
      const actual = byHash.get(sha256),
        bytes = actual ? Uint8Array.from(actual.bytes as Uint8Array) : null;
      if (
        !bytes ||
        Number(actual!.byte_length) !== expected.byteLength ||
        hashSourceBytes(bytes) !== sha256
      )
        throw new Error(
          'Stored source object failed content-address verification',
        );
    }
  }
}
