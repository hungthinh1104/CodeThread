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
      'scripts/git-source/**/*.ts',
      'scripts/investigation/**/*.ts',
      'scripts/source-discovery-benchmark/**/*.ts',
      'scripts/benchmark-source-discovery.ts',
    ],
    rules: {
      'max-lines': ['error', { max: 500 }],
      'max-lines-per-function': ['error', { max: 150, IIFEs: true }],
    },
  },
  {
    files: [
      'tests/{contracts,contract-integrity,query-results,architecture,tooling}.test.ts',
      'tests/git-inventory*.test.ts',
      'tests/git-source-cli*.test.ts',
      'tests/investigate-cli.test.ts',
      'tests/source-browser-cli.test.ts',
      'tests/viewer-browser.ts',
      'tests/browser/*.ts',
    ],
    rules: { 'max-lines': ['error', { max: 700 }] },
  },
  // Viewer owner: retained as a single browser asset until the viewer refactor.
  // Baseline 97735acf30fddd359ddef314a494cdc41133cd64; cap 964 physical lines.
  {
    files: ['scripts/viewer.js'],
    rules: { 'max-lines': ['error', { max: 964 }] },
  },
  // Study owner: task bank remains a single module until the scheduled Study split.
  // Baseline 97735acf30fddd359ddef314a494cdc41133cd64; cap 912 physical lines.
  {
    files: ['scripts/study-tasks.ts'],
    rules: { 'max-lines': ['error', { max: 912 }] },
  },
  // Study owner: result validation and scoring remain together until that split.
  // Baseline 97735acf30fddd359ddef314a494cdc41133cd64; cap 904 physical lines.
  {
    files: ['scripts/study-results.ts'],
    rules: { 'max-lines': ['error', { max: 904 }] },
  },
  // Study owner: split the large integration suite by behavior in its own phase.
  // Baseline 97735acf30fddd359ddef314a494cdc41133cd64; cap 1073 physical lines.
  {
    files: ['tests/study-toolkit.test.ts'],
    rules: { 'max-lines': ['error', { max: 1073 }] },
  },
];
