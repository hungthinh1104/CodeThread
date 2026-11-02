import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '.tooling/**',
      'artifacts/**',
      'fixtures/external/**/closure/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
];
