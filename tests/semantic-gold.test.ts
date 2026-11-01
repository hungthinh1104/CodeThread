import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type Position = [number, number];
type Anchor = { file: string; start: Position; end: Position };
type Gold = {
  review: string;
  files: Record<string, string>;
  declarations: {
    file: string;
    name: string;
    start: Position;
    end: Position;
  }[];
  calls: {
    file: string;
    line: number;
    column: number;
    text: string;
    owner: Anchor | null;
    status: 'exact' | 'unresolved' | 'ambiguous' | 'unsupported';
    target?: Anchor;
    diagnostic?: string;
    eligible: boolean;
  }[];
};

async function goldFixture() {
  const root = resolve('fixtures/semantic');
  const gold = JSON.parse(
    await readFile(resolve(root, 'gold.json'), 'utf8'),
  ) as Gold;
  const sources = new Map<string, string[]>();
  for (const [path, expectedHash] of Object.entries(gold.files)) {
    const bytes = await readFile(resolve(root, 'sources', path + '.txt'));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(expectedHash);
    const text = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    sources.set(path, text.split(/\r\n|\r|\n|\u2028|\u2029/));
  }
  return { gold, sources };
}

describe('CT-INDEX-001A manually authored semantic ground truth', () => {
  it('pins source bytes and validates occurrence positions independently of the analyzer', async () => {
    const { gold, sources } = await goldFixture();
    expect(gold.review).toContain('not independently reviewed');
    const anchorKey = (anchor: Anchor) =>
      JSON.stringify([anchor.file, anchor.start, anchor.end]);
    const anchors = new Set(gold.declarations.map(anchorKey));
    expect(anchors.size).toBe(gold.declarations.length);
    const locations = new Set<string>();
    for (const call of gold.calls) {
      const line = sources.get(call.file)?.[call.line - 1];
      expect(
        line?.slice(call.column - 1, call.column - 1 + call.text.length),
      ).toBe(call.text);
      const location = `${call.file}:${call.line}:${call.column}`;
      expect(locations.has(location)).toBe(false);
      locations.add(location);
      if (call.owner) {
        expect(call.owner.file).toBe(call.file);
        expect(anchors.has(anchorKey(call.owner))).toBe(true);
        const [startLine, startColumn] = call.owner.start;
        const [endLine, endColumn] = call.owner.end;
        expect(
          call.line > startLine ||
            (call.line === startLine && call.column >= startColumn),
        ).toBe(true);
        expect(
          call.line < endLine ||
            (call.line === endLine &&
              call.column + call.text.length <= endColumn),
        ).toBe(true);
      }
      if (call.target) expect(anchors.has(anchorKey(call.target))).toBe(true);
      if (call.status === 'exact') {
        expect(call.owner).toBeTruthy();
        expect(call.target).toBeTruthy();
        expect(call.diagnostic).toBeUndefined();
      } else {
        expect(call.target).toBeUndefined();
        expect(call.diagnostic).toBeTruthy();
      }
    }
    for (const declaration of gold.declarations) {
      const lines = sources.get(declaration.file)!;
      const [startLine, startColumn] = declaration.start;
      const [endLine, endColumn] = declaration.end;
      const span = lines.slice(startLine - 1, endLine);
      expect(span.length).toBeGreaterThan(0);
      span[0] = span[0]!.slice(startColumn - 1);
      if (span.length === 1)
        span[0] = span[0]!.slice(0, endColumn - startColumn);
      else span[span.length - 1] = span.at(-1)!.slice(0, endColumn - 1);
      expect(span.join('\n')).toContain(`function ${declaration.name}`);
      expect(span.at(-1)?.endsWith('}')).toBe(true);
    }
    expect(gold.calls.filter((call) => call.status === 'exact')).toHaveLength(
      13,
    );
    expect(gold.calls.filter((call) => call.status !== 'exact')).toHaveLength(
      17,
    );
  });
});
