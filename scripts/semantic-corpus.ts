import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface GoldAnchor {
  file: string;
  start: [number, number];
  end: [number, number];
}
export interface GoldCall {
  file: string;
  line: number;
  column: number;
  end?: [number, number];
  text: string;
  owner: GoldAnchor | null;
  status: 'exact' | 'unresolved' | 'ambiguous' | 'unsupported';
  target?: GoldAnchor;
  diagnostic?: string;
  eligible: boolean;
}
export interface SemanticGold {
  authorship: string;
  review: string;
  files: Record<string, string>;
  declarations: {
    file: string;
    name: string;
    kind?: 'function' | 'method';
    start: [number, number];
    end: [number, number];
  }[];
  calls: GoldCall[];
}
export async function loadSemanticCorpus() {
  const root = resolve('fixtures/semantic');
  const gold = JSON.parse(
    await readFile(resolve(root, 'gold.json'), 'utf8'),
  ) as SemanticGold;
  const files = await Promise.all(
    Object.entries(gold.files).map(async ([path, sha256]) => ({
      path,
      sha256,
      bytes: await readFile(resolve(root, 'sources', path + '.txt')),
    })),
  );
  return { gold, files };
}
