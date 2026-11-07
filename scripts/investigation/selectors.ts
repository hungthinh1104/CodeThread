import type {
  CodeRelation,
  CodeSymbol,
  AnalysisFacts,
} from '@codethread/code-model';
import type { AnalysisSnapshot } from '@codethread/symbol-indexer';
import type { GraphNeighborsRequest } from '@codethread/contracts';
import { CliError } from './commands.ts';
import { commandArgument, quoted } from './terminal.ts';
const MAX_SYMBOL_ROWS = 100;

const supportedRelationKinds = [
  'calls',
  'references',
] as const satisfies readonly CodeRelation['kind'][];

export type RelationKind = (typeof supportedRelationKinds)[number];

export type Direction = GraphNeighborsRequest['direction'];
export function parseKinds(value: string | undefined): RelationKind[] {
  if (value === undefined) return ['calls'];
  const kinds = value.split(',');
  if (
    kinds.length < 1 ||
    kinds.length > 2 ||
    kinds.some(
      (kind) => !supportedRelationKinds.some((supported) => supported === kind),
    ) ||
    new Set(kinds).size !== kinds.length
  )
    throw new CliError(
      'INVALID_RELATION_FILTER',
      'Choose calls, references, or calls,references.',
    );
  const result: RelationKind[] = [];
  for (const kind of kinds) {
    if (isSupportedRelationKind(kind)) result.push(kind);
  }
  return result;
}

function isSupportedRelationKind(value: string): value is RelationKind {
  return supportedRelationKinds.some((kind) => kind === value);
}

export function parseDirection(value: string | undefined): Direction {
  if (value === undefined) return 'both';
  if (value === 'incoming' || value === 'outgoing' || value === 'both')
    return value;
  throw new CliError(
    'INVALID_DIRECTION',
    'Direction must be incoming, outgoing or both.',
  );
}

function parseLocationSelector(value: string) {
  if (value.length > 2048)
    throw new CliError('INVALID_SELECTOR', 'Source selector is too long.');
  const match = /^(.*)@([1-9][0-9]*):([1-9][0-9]*)$/.exec(value);
  if (!match)
    throw new CliError(
      'INVALID_SELECTOR',
      'Use a source selector in the form path@line:column.',
    );
  const line = Number(match[2]),
    column = Number(match[3]);
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column))
    throw new CliError(
      'INVALID_SELECTOR',
      'Line and column must be safe integers.',
    );
  return { filePath: match[1]!, line, column };
}

export function selectSymbol(
  facts: AnalysisFacts,
  selector: string,
): CodeSymbol {
  if (selector.startsWith('name:')) {
    const name = selector.slice('name:'.length);
    if (name.length === 0)
      throw new CliError('INVALID_SELECTOR', 'Display-name selector is empty.');
    const candidates = facts.symbols.filter((symbol) => symbol.name === name);
    if (candidates.length === 0)
      throw new CliError(
        'SYMBOL_NOT_FOUND',
        `No symbol is named ${quoted(name)}.`,
      );
    if (candidates.length > 1)
      throw new CliError(
        'SYMBOL_AMBIGUOUS',
        `Name ${quoted(name)} matches ${candidates.length} declarations; use one source selector: ${candidates.slice(0, 10).map(displaySelector).join(', ')}${candidates.length > 10 ? ', …' : ''}`,
      );
    return candidates[0]!;
  }

  const location = parseLocationSelector(selector);
  const matches = facts.symbols.filter(
    (symbol) =>
      symbol.filePath === location.filePath &&
      symbol.range.start.line === location.line &&
      symbol.range.start.column === location.column,
  );
  if (matches.length === 0)
    throw new CliError(
      'SYMBOL_NOT_FOUND',
      `No declaration starts at ${quoted(selector)}. Use symbols to list anchors.`,
    );
  if (matches.length > 1)
    throw new CliError(
      'SYMBOL_AMBIGUOUS',
      `${quoted(selector)} matches ${matches.length} declarations; narrow the source anchor.`,
    );
  return matches[0]!;
}

export function listFiles(snapshot: AnalysisSnapshot): string[] {
  if (snapshot.facts.files.length === 0)
    return ['No source files were analyzed.'];
  return snapshot.facts.files.map(
    (file) =>
      `${commandArgument(file.path)} (${file.byteLength} bytes, sha256:${file.contentHash})`,
  );
}

export function listSymbols(
  snapshot: AnalysisSnapshot,
  path?: string,
): string[] {
  if (
    path !== undefined &&
    !snapshot.facts.files.some((file) => file.path === path)
  )
    throw new CliError(
      'SOURCE_NOT_FOUND',
      `No manifest source named ${quoted(path)}.`,
    );
  const symbols = path
    ? snapshot.facts.symbols.filter((symbol) => symbol.filePath === path)
    : snapshot.facts.symbols;
  if (symbols.length === 0)
    return [`No supported declarations${path ? ` in ${quoted(path)}` : ''}.`];
  const rows = symbols
    .slice(0, MAX_SYMBOL_ROWS)
    .map(
      (symbol) =>
        `${displaySelector(symbol)}  ${symbol.kind}  ${quoted(symbol.name)}`,
    );
  if (symbols.length > MAX_SYMBOL_ROWS)
    rows.push(
      `Symbol list limited to ${MAX_SYMBOL_ROWS} of ${symbols.length}; filter by source path.`,
    );
  return rows;
}

export function sourceSelector(symbol: CodeSymbol): string {
  return `${symbol.filePath}@${symbol.range.start.line}:${symbol.range.start.column}`;
}

export function displaySelector(symbol: CodeSymbol): string {
  const selector = sourceSelector(symbol);
  return commandArgument(selector);
}
