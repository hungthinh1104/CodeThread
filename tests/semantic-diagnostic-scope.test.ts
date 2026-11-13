import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { analysisResourceLimits } from '@codethread/code-model';
import { extractFacts } from '../packages/symbol-indexer/src/extract.ts';

const root = '/__codethread__/source/';

function fixture() {
  const caller = ts.createSourceFile(
      root + 'caller.ts',
      "import { target } from './target.js';\nfunction caller() { target(); }",
      ts.ScriptTarget.ES2023,
      true,
    ),
    target = ts.createSourceFile(
      root + 'target.ts',
      'function target() {}',
      ts.ScriptTarget.ES2023,
      true,
    ),
    unused = Array.from({ length: 63 }, (_, index) =>
      ts.createSourceFile(
        `${root}unused-${index}.ts`,
        `unused${index}();`,
        ts.ScriptTarget.ES2023,
        true,
      ),
    ),
    sourceFiles = [caller, target, ...unused],
    targetDeclaration = target.statements[0] as ts.FunctionDeclaration,
    importDeclaration = caller.statements[0] as ts.ImportDeclaration,
    importSpecifier = (
      importDeclaration.importClause!.namedBindings as ts.NamedImports
    ).elements[0]!,
    aliasSymbol = {
      flags: ts.SymbolFlags.Alias,
      declarations: [importSpecifier],
    } as unknown as ts.Symbol,
    moduleSymbol = { flags: 0, declarations: [target] } as unknown as ts.Symbol,
    targetSymbol = {
      flags: ts.SymbolFlags.Function | ts.SymbolFlags.Value,
      declarations: [targetDeclaration],
    } as unknown as ts.Symbol,
    queried: string[] = [],
    checker = {
      getSymbolAtLocation(node: ts.Node) {
        if (node === importDeclaration.moduleSpecifier) return moduleSymbol;
        return ts.isIdentifier(node) && node.text === 'target'
          ? aliasSymbol
          : undefined;
      },
      getAliasedSymbol: () => targetSymbol,
      resolveName: () => undefined,
    },
    program = {
      getTypeChecker: () => checker,
      getSourceFiles: () => sourceFiles,
      getSemanticDiagnostics(file: ts.SourceFile) {
        queried.push(file.fileName);
        if (file === caller)
          return [
            {
              category: ts.DiagnosticCategory.Error,
              code: 2304,
              file,
              start: file.text.indexOf('target()'),
              length: 'target()'.length,
              messageText: 'The target binding has a compiler error.',
            },
          ];
        if (file === target)
          return [
            {
              category: ts.DiagnosticCategory.Error,
              code: 2304,
              file,
              start: file.text.indexOf('target'),
              length: 'target'.length,
              messageText: 'The declaration has a compiler error.',
            },
          ];
        return [
          {
            category: ts.DiagnosticCategory.Error,
            code: 2304,
            file,
            start: 0,
            length: 1,
            messageText: 'An unrelated file has a compiler error.',
          },
        ];
      },
    } as unknown as ts.Program,
    files = sourceFiles.map((file, index) => {
      const bytes = Buffer.from(file.text);
      return {
        snapshotId: '00000000-0000-4000-8000-000000000001',
        id: `00000000-0000-4000-8000-${String(index + 2).padStart(12, '0')}`,
        path: file.fileName.slice(root.length),
        contentHash: createHash('sha256').update(bytes).digest('hex'),
        byteLength: bytes.length,
      };
    });
  return {
    caller,
    target,
    queried,
    program,
    base: {
      snapshotId: '00000000-0000-4000-8000-000000000001',
      files,
    } as unknown as Parameters<typeof extractFacts>[1],
  };
}

describe('project semantic diagnostic scope', () => {
  it('checks relationship source and target files, and discloses omitted diagnostics', () => {
    const input = fixture();
    const result = extractFacts(
      input.program,
      input.base,
      root,
      analysisResourceLimits('repository'),
      true,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(input.queried.sort()).toEqual(
      [input.caller.fileName, input.target.fileName].sort(),
    );
    expect(
      result.facts.observations.find((item) => item.relationId !== null),
    ).toMatchObject({ status: 'unresolved' });
    expect(result.facts.relations).toEqual([
      expect.objectContaining({
        resolution: expect.objectContaining({
          status: 'unresolved',
          targetId: null,
        }),
      }),
    ]);
    expect(result.facts.diagnostics.map((item) => item.code)).toContain(
      'INVALID_BINDING',
    );
    expect(result.contextDiagnostics).toEqual([
      expect.objectContaining({ code: 'SEMANTIC_DIAGNOSTICS_SCOPED' }),
    ]);
  });

  it('keeps full diagnostic collection in selected-file mode', () => {
    const input = fixture();
    const result = extractFacts(
      input.program,
      input.base,
      root,
      analysisResourceLimits('repository'),
    );

    expect(result.ok).toBe(true);
    expect(input.queried).toHaveLength(65);
    if (result.ok) expect(result.contextDiagnostics).toBeUndefined();
  });
});
