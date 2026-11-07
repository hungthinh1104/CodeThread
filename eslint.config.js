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
  {
    files: ['packages/contracts/src/**/*.ts'],
    rules: {
      'max-lines': ['error', { max: 500 }],
      'max-lines-per-function': ['error', { max: 150, IIFEs: true }],
    },
  },
  {
    files: [
      'tests/{contracts,contract-integrity,query-results,architecture,tooling}.test.ts',
    ],
    rules: { 'max-lines': ['error', { max: 700 }] },
  },
];
