import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

describe('Scoped minimatch override consumer compatibility', () => {
  it('preserves repository ignore globs and TypeScript linting', async () => {
    const eslint = new ESLint();
    expect(await eslint.isPathIgnored('.tooling/generated.ts')).toBe(true);
    const [valid] = await eslint.lintText('export const value: number = 1;\n', {
      filePath: 'tests/compatibility.ts',
    });
    expect(valid?.messages).toEqual([]);
    const [invalid] = await eslint.lintText('const unused: number = 1;\n', {
      filePath: 'tests/compatibility.ts',
    });
    expect(invalid?.messages.map((message) => message.ruleId)).toContain(
      '@typescript-eslint/no-unused-vars',
    );
  });

  it('preserves config-array brace, recursive and exclusion patterns', async () => {
    const eslint = new ESLint({
      overrideConfigFile: true,
      overrideConfig: [
        {
          files: ['**/*.{ts,tsx}'],
          ignores: ['**/generated/**'],
          languageOptions: { parser: tseslint.parser },
          rules: { 'no-debugger': 'error' },
        },
      ],
    });
    for (const filePath of ['nested/input.ts', 'nested/input.tsx']) {
      const [result] = await eslint.lintText('debugger;', { filePath });
      expect(result?.messages.map((message) => message.ruleId)).toEqual([
        'no-debugger',
      ]);
    }
    for (const filePath of ['nested/generated/input.ts', 'nested/input.js']) {
      expect(
        (
          await eslint.lintText('debugger;', { filePath, warnIgnored: false })
        ).flatMap((result) => result.messages),
      ).toEqual([]);
    }
  });

  it('preserves typescript-estree default-project matching including dot files', async () => {
    const eslint = new ESLint({
      overrideConfigFile: true,
      overrideConfig: [
        {
          files: ['**/*.ts'],
          languageOptions: {
            parser: tseslint.parser,
            parserOptions: {
              tsconfigRootDir: process.cwd(),
              projectService: { allowDefaultProject: ['.codethread-*.ts'] },
            },
          },
          plugins: { '@typescript-eslint': tseslint.plugin },
          rules: { '@typescript-eslint/await-thenable': 'error' },
        },
      ],
    });
    const [result] = await eslint.lintText(
      'export async function example() { await 42; }',
      { filePath: '.codethread-override-probe.ts' },
    );
    expect(result?.messages.map((message) => message.ruleId)).toEqual([
      '@typescript-eslint/await-thenable',
    ]);
    const [unmatched] = await eslint.lintText('export const value = 1;', {
      filePath: '.unmatched-probe.ts',
    });
    expect(unmatched?.fatalErrorCount).toBe(1);
    expect(unmatched?.messages[0]?.message).toContain('allowDefaultProject');
  });
});
