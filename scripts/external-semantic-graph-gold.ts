export type CorpusName = 'tinyexec' | 'todo';
export type PositionAnchor = { line: number; column: number };
export type RangeAnchor = { start: PositionAnchor; end: PositionAnchor };
export type SymbolAnchor = {
  file: string;
  name: string;
  range: RangeAnchor;
};
export type ExternalGraphExpectation = {
  repository: string;
  revision: string;
  sourceHashes: Readonly<Record<string, string>>;
  root: SymbolAnchor;
  target: SymbolAnchor;
  edge: {
    file: string;
    range: RangeAnchor;
    text: string;
    kind: 'calls';
  };
};

/**
 * These expectations were transcribed from the pinned source bytes, not from
 * analyzer output or generated symbol and relation IDs.
 */
export const externalGraphExpectations = {
  tinyexec: {
    repository: 'https://github.com/tinylibs/tinyexec',
    revision: '4a2aca1cf11943445c7bae6c767086a8c61291ef',
    sourceHashes: {
      'src/env.ts':
        '3e592708f39d6542112a8c4726854d0af38b311366d2ce913f4148cce7589bb5',
    },
    root: {
      file: 'src/env.ts',
      name: 'computeEnv',
      range: { start: { line: 59, column: 1 }, end: { line: 77, column: 2 } },
    },
    target: {
      file: 'src/env.ts',
      name: 'getPathFromEnv',
      range: { start: { line: 18, column: 1 }, end: { line: 36, column: 2 } },
    },
    edge: {
      file: 'src/env.ts',
      range: { start: { line: 73, column: 45 }, end: { line: 73, column: 75 } },
      text: 'getPathFromEnv(envWithDefault)',
      kind: 'calls',
    },
  },
  todo: {
    repository: 'https://github.com/vunb/ts-node-todo',
    revision: 'c64bdfaf3f36a3fde88fba8191ad0a98d4acbc8c',
    sourceHashes: {
      'routes/index.ts':
        'e361911be0b6b29857eb8eac273de29fb4b3980f324f7326b582a141d5732531',
      'routes/todo.router.ts':
        'a698ded96d38c6afb4f7eb6d385ae8add0ec3340eb7aa29a979540147a074442',
    },
    root: {
      file: 'routes/index.ts',
      name: 'routes',
      range: { start: { line: 9, column: 1 }, end: { line: 63, column: 2 } },
    },
    target: {
      file: 'routes/todo.router.ts',
      name: 'todoRouter',
      range: { start: { line: 4, column: 1 }, end: { line: 17, column: 2 } },
    },
    edge: {
      file: 'routes/index.ts',
      range: { start: { line: 42, column: 20 }, end: { line: 42, column: 32 } },
      text: 'todoRouter()',
      kind: 'calls',
    },
  },
} as const satisfies Record<CorpusName, ExternalGraphExpectation>;
