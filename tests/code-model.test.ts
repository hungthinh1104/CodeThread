import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import {
  positionAt,
  resolutionSchema,
  snapshotIdentitySchema,
  snapshotPathSchema,
  sourceRangeSchema,
  validateSourceRange,
} from '@codethread/code-model';
import { id } from './fixtures/trace.ts';

describe('CT-DB-007 source positions', () => {
  it.each([
    {
      start: { offset: 0, line: 1, column: 1 },
      end: { offset: 10, line: 1, column: 2 },
    },
    {
      start: { offset: 5, line: 1, column: 3 },
      end: { offset: 6, line: 1, column: 4 },
    },
    {
      start: { offset: 0, line: 3, column: 1 },
      end: { offset: 1, line: 3, column: 2 },
    },
  ])(
    'rejects coordinates provably inconsistent without source text',
    (range) => {
      expect(sourceRangeSchema.safeParse(range).success).toBe(false);
    },
  );
  it('agrees with the TypeScript line map for every UTF-16 offset, including CRLF, Unicode separators and surrogate pairs', () => {
    const source =
      '\uFEFFconst face = "😀";\r\nconst café = 1;\n\u2028end\u2029';
    const file = ts.createSourceFile(
      'unicode.ts',
      source,
      ts.ScriptTarget.Latest,
    );
    for (let offset = 0; offset <= source.length; offset++) {
      const expected = file.getLineAndCharacterOfPosition(offset);
      expect(positionAt(source, offset)).toEqual({
        offset,
        line: expected.line + 1,
        column: expected.character + 1,
      });
    }
  });
  it('validates source content as well as structurally valid coordinates', () => {
    const source = '😀\r\nx';
    const valid = { start: positionAt(source, 4), end: positionAt(source, 5) };
    expect(validateSourceRange(source, valid)).toBe(true);
    expect(
      validateSourceRange(source, {
        ...valid,
        end: { offset: 5, line: 2, column: 3 },
      }),
    ).toBe(false);
    expect(
      validateSourceRange(source, {
        ...valid,
        end: { offset: 6, line: 2, column: 3 },
      }),
    ).toBe(false);
    expect(() => positionAt(source, -1)).toThrow(RangeError);
    expect(() => positionAt(source, 0.5)).toThrow(RangeError);
  });
  it('rejects reversed and inconsistent empty spans', () => {
    expect(
      sourceRangeSchema.safeParse({
        start: { offset: 2, line: 1, column: 3 },
        end: { offset: 1, line: 1, column: 2 },
      }).success,
    ).toBe(false);
    expect(
      sourceRangeSchema.safeParse({
        start: { offset: 0, line: 1, column: 1 },
        end: { offset: 0, line: 2, column: 1 },
      }).success,
    ).toBe(false);
  });
});
describe('CT-DB-001 identity and safe paths', () => {
  it('requires all four analysis identity components and a build digest', () => {
    const identity = {
      repositoryId: id(1),
      sourceFingerprint: 'a'.repeat(64),
      analyzerVersion: '0.1.0',
      analyzerBuildHash: 'b'.repeat(64),
      configurationHash: 'c'.repeat(64),
    };
    expect(snapshotIdentitySchema.safeParse(identity).success).toBe(true);
    expect(
      snapshotIdentitySchema.safeParse({ ...identity, configurationHash: '' })
        .success,
    ).toBe(false);
    expect(
      snapshotIdentitySchema.safeParse({
        ...identity,
        sourceFingerprint: 'commit-sha',
      }).success,
    ).toBe(false);
    expect(
      snapshotIdentitySchema.safeParse({
        ...identity,
        analyzerBuildHash: undefined,
      }).success,
    ).toBe(false);
  });
  it.each([
    '../secret',
    '/absolute',
    'C:/source.ts',
    'src\\file.ts',
    'src//file.ts',
    'src/./file.ts',
    'src/../file.ts',
    'a\u0000b',
  ])('rejects unsafe path %j', (path) => {
    expect(snapshotPathSchema.safeParse(path).success).toBe(false);
  });
  it('preserves case and Unicode in Git paths', () => {
    expect(snapshotPathSchema.parse('Src/café.ts')).toBe('Src/café.ts');
  });
});
describe('CT-DB-005 relationship trust', () => {
  it('requires a target and actual evidence references for an exact resolution', () => {
    expect(
      resolutionSchema.safeParse({
        status: 'exact',
        targetId: id(2),
        evidenceIds: [id(3)],
      }).success,
    ).toBe(true);
    expect(
      resolutionSchema.safeParse({
        status: 'exact',
        targetId: null,
        evidenceIds: [id(3)],
      }).success,
    ).toBe(false);
    expect(
      resolutionSchema.safeParse({
        status: 'exact',
        targetId: id(2),
        evidenceIds: [],
      }).success,
    ).toBe(false);
  });
  it.each(['unresolved', 'ambiguous', 'unsupported'])(
    'preserves %s sites without guessed targets',
    (status) => {
      const resolution = {
        status,
        targetId: null,
        evidenceIds: [id(3)],
        diagnosticIds: [id(4)],
      };
      expect(resolutionSchema.safeParse(resolution).success).toBe(true);
      expect(
        resolutionSchema.safeParse({ ...resolution, targetId: id(5) }).success,
      ).toBe(false);
      expect(
        resolutionSchema.safeParse({ ...resolution, diagnosticIds: [] })
          .success,
      ).toBe(false);
    },
  );
});
