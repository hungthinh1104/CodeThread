import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import * as model from '@codethread/code-model';

describe('Caller-owned source-position index', () => {
  it('keeps indexes immutable and independent for different source texts', () => {
    const first = model.createSourcePositionIndex('a\nb'),
      second = model.createSourcePositionIndex('abc');
    expect(Reflect.set(first, 'positionAt', () => null)).toBe(false);
    expect(first.positionAt(2)).toEqual({ offset: 2, line: 2, column: 1 });
    expect(second.positionAt(2)).toEqual({ offset: 2, line: 1, column: 3 });
  });
  it.each([-1, 0.5, NaN, Infinity, 100])(
    'rejects invalid offset %s',
    (offset) => {
      expect(() =>
        model.createSourcePositionIndex('😀\r\nx').positionAt(offset),
      ).toThrow(RangeError);
    },
  );
  it('validates empty/EOF ranges and rejects stale coordinates and file bounds', () => {
    const index = model.createSourcePositionIndex('😀\r\nx');
    const end = { offset: 5, line: 2, column: 2 };
    expect(index.validateRange({ start: end, end })).toBe(true);
    expect(
      index.validateRange({ start: { offset: 4, line: 2, column: 1 }, end }),
    ).toBe(true);
    expect(
      index.validateRange({
        start: { offset: 4, line: 2, column: 1 },
        end: { offset: 5, line: 2, column: 3 },
      }),
    ).toBe(false);
    expect(
      index.validateRange({
        start: end,
        end: { offset: 6, line: 2, column: 3 },
      }),
    ).toBe(false);
  });
  it('agrees with the independent compiler line map for thousands of large-file positions and ranges', () => {
    const source = Array.from(
      { length: 6000 },
      (_, index) => 'const value' + index + " = 'café 😀';\r\n",
    ).join('');
    const indexed = model.createSourcePositionIndex(source),
      file = ts.createSourceFile('large.ts', source, ts.ScriptTarget.Latest);
    const expected = (offset: number) => {
      const position = file.getLineAndCharacterOfPosition(offset);
      return {
        offset,
        line: position.line + 1,
        column: position.character + 1,
      };
    };
    for (let index = 0; index < 3000; index++) {
      const offset = Math.floor(
        (((index * 104729) % 1000003) / 1000003) * (source.length + 1),
      );
      expect(indexed.positionAt(offset)).toEqual(expected(offset));
      expect(
        indexed.validateRange({
          start: expected(offset),
          end: expected(Math.min(offset + 3, source.length)),
        }),
      ).toBe(true);
    }
  });
  it.each([
    '',
    '\r\n',
    '\uFEFFx\r\ny\n',
    '😀café\u2028x\u2029',
    '\r\n\r\n\n\r',
    'a\u0085b',
  ])('matches TypeScript at every offset including EOF: %j', (source) => {
    const index = model.createSourcePositionIndex(source);
    const file = ts.createSourceFile(
      'source.ts',
      source,
      ts.ScriptTarget.Latest,
    );
    for (let offset = 0; offset <= source.length; offset++) {
      const expected = file.getLineAndCharacterOfPosition(offset);
      expect(index.positionAt(offset)).toEqual({
        offset,
        line: expected.line + 1,
        column: expected.character + 1,
      });
    }
  });
});
