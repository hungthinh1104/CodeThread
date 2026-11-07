import { ANALYSIS_LIMITS } from '@codethread/symbol-indexer';
import type {
  GitInventorySession,
  GitInventoryQuery,
  GitInventoryPage,
  GitSelectionPlan,
} from '../git-source/inventory-types.ts';
import { GitSourceError } from '../git-source/types.ts';
import { CliError, MAX_SESSION_COMMANDS, tokenize } from './commands.ts';
import {
  commandArgument,
  MAX_RESPONSE_BYTES,
  printError,
  writePage,
} from './terminal.ts';
import type { CliLineInput, SessionCommandBudget } from './input.ts';

interface BrowseState {
  session: GitInventorySession;
  selected: string[];
  last: { query: GitInventoryQuery; cursor: string | null } | null;
}
const usage = [
  'files [directory] | search <literal> [directory] | lookup <exact-path> | next [cursor]',
  'select <file> | select-module <directory> | remove <file> | selected [offset] | analyze | help | quit',
  'Paths and search text are literal and case-sensitive. Use JSON quotes for whitespace, quotes or formatting characters.',
  'A directory is relative with an optional trailing slash; . selects the repository root. No glob or dependency expansion occurs.',
];

function directoryPrefix(value: string | undefined): string {
  if (value === undefined || value === '.') return '';
  if (value.startsWith('/'))
    throw new CliError(
      'INVALID_COMMAND',
      'Directory selectors must be relative.',
    );
  return value.endsWith('/') ? value.slice(0, -1) : value;
}
function requireArguments(
  args: readonly string[],
  minimum: number,
  maximum: number,
  hint: string,
): void {
  if (args.length < minimum || args.length > maximum)
    throw new CliError('INVALID_COMMAND', hint);
}
function fitRows(rows: readonly string[]): number {
  // Reserve space for metadata, the bounded cursor, and the final output marker.
  let bytes = 16 * 1024,
    count = 0;
  for (const row of rows) {
    bytes += Buffer.byteLength(row + '\n');
    if (bytes > MAX_RESPONSE_BYTES) break;
    count++;
  }
  return count;
}

function pageBlocks(page: GitInventoryPage): string[] {
  return [
    `Verified matching paths: ${page.knownMatches}; displayed ${page.items.length}; applied page size ${page.appliedLimits.pageSize}.`,
    page.inventoryComplete
      ? 'Inventory is complete for committed .ts entries; symlinks and gitlinks cannot be selected.'
      : `Inventory is incomplete (${page.truncationReasons.join(', ')}); zero matches do not prove repository absence.`,
    ...page.items.map((file) => `${commandArgument(file.path)} [${file.mode}]`),
    page.nextCursor === null
      ? `End of verified results; repository inventory is ${page.inventoryComplete ? 'complete' : 'incomplete'}.`
      : `More verified results: next\nCursor: ${page.nextCursor}`,
  ];
}

function showQuery(state: BrowseState, query: GitInventoryQuery): void {
  let page = state.session.query(query);
  const shown = fitRows(
    page.items.map((file) => `${commandArgument(file.path)} [${file.mode}]`),
  );
  if (shown < page.items.length) {
    if (shown === 0)
      throw new CliError(
        'OUTPUT_LIMIT',
        'A source path exceeds the bounded display budget.',
      );
    page = state.session.query({ ...query, limit: shown });
  }
  const blocks = pageBlocks(page);
  if (writePage(blocks) !== blocks.length)
    throw new CliError(
      'OUTPUT_LIMIT',
      'The source page was not fully displayed.',
    );
  // Only a cursor for displayed rows becomes the next page state.
  const continuationQuery = { ...query };
  delete continuationQuery.cursor;
  state.last = { query: continuationQuery, cursor: page.nextCursor };
}

function showSelected(state: BrowseState, args: readonly string[]): void {
  requireArguments(args, 0, 1, 'Usage: selected [offset].');
  const raw = args[0] ?? '0';
  if (!/^(0|[1-9][0-9]*)$/.test(raw))
    throw new CliError(
      'INVALID_COMMAND',
      'Selection offset must be a nonnegative integer.',
    );
  const offset = Number(raw);
  if (!Number.isSafeInteger(offset) || offset > state.selected.length)
    throw new CliError(
      'INVALID_COMMAND',
      'Selection offset is outside the selected source set.',
    );
  const rows = state.selected
    .slice(offset)
    .map((path) => commandArgument(path));
  const shown = fitRows(rows);
  writePage([
    `Selected ${state.selected.length}/${ANALYSIS_LIMITS.maxFiles} exact files; sizes and content are verified only at analyze.`,
    ...rows.slice(0, shown),
    offset + shown < state.selected.length
      ? `More selected paths: selected ${offset + shown}`
      : 'End of selected source paths.',
  ]);
}

function executeCommand(
  state: BrowseState,
  command: string,
  args: readonly string[],
): GitSelectionPlan | 'quit' | null {
  if (command === 'help') {
    requireArguments(args, 0, 0, 'help takes no arguments.');
    writePage(usage);
  } else if (command === 'files') {
    requireArguments(args, 0, 1, 'Usage: files [directory].');
    showQuery(state, { prefix: directoryPrefix(args[0]) });
  } else if (command === 'search') {
    requireArguments(args, 1, 2, 'Usage: search <literal> [directory].');
    showQuery(state, { text: args[0]!, prefix: directoryPrefix(args[1]) });
  } else if (command === 'lookup') {
    requireArguments(args, 1, 1, 'Usage: lookup <exact-path>.');
    const result = state.session.lookup(args[0]);
    writePage([
      `Lookup ${commandArgument(args[0]!)}: ${result.status}${'code' in result ? ` (${result.code})` : ''}.`,
    ]);
  } else if (command === 'next') {
    requireArguments(args, 0, 1, 'Usage: next [cursor].');
    if (!state.last)
      throw new CliError(
        'INVALID_CURSOR',
        'Start a browse or search query before requesting a continuation.',
      );
    const cursor = args[0] ?? state.last.cursor;
    if (cursor === null)
      writePage([
        'End of verified results; use files or search to start another query.',
      ]);
    else showQuery(state, { ...state.last.query, cursor });
  } else if (command === 'select' || command === 'select-module') {
    requireArguments(
      args,
      1,
      1,
      `Usage: ${command} <${command === 'select' ? 'file-path' : 'directory'}>.`,
    );
    const plan =
      command === 'select'
        ? state.session.select({ paths: [...state.selected, args[0]!] })
        : state.session.select({
            paths: state.selected,
            directories: [directoryPrefix(args[0])],
          });
    const added = plan.selection.length - state.selected.length;
    state.selected = plan.selection.map((item) => item.path);
    const prefix = directoryPrefix(args[0]);
    writePage([
      `Selected ${added} files${command === 'select-module' ? ` from ${commandArgument(prefix ? prefix + '/' : '.')}` : ''} atomically.`,
      `${state.selected.length}/${ANALYSIS_LIMITS.maxFiles} source files selected.`,
    ]);
  } else if (command === 'remove') {
    requireArguments(args, 1, 1, 'Usage: remove <file-path>.');
    const index = state.selected.indexOf(args[0]!);
    if (index < 0)
      throw new CliError('FILE_NOT_FOUND', 'File is not selected.');
    state.selected.splice(index, 1);
    writePage([`Removed ${commandArgument(args[0]!)}.`]);
  } else if (command === 'selected') showSelected(state, args);
  else if (command === 'analyze') {
    requireArguments(args, 0, 0, 'analyze takes no arguments.');
    return state.session.select({ paths: state.selected });
  } else if (command === 'quit' || command === 'exit') {
    requireArguments(args, 0, 0, 'quit takes no arguments.');
    return 'quit';
  } else
    throw new CliError(
      'INVALID_COMMAND',
      `Unknown source-selection command ${commandArgument(command)}.`,
    );
  return null;
}

export async function startSourceSelectionSession(
  session: GitInventorySession,
  signal: AbortSignal,
  input: CliLineInput,
  budget: SessionCommandBudget,
): Promise<GitSelectionPlan | null> {
  const { inventory } = session;
  const state: BrowseState = { session, selected: [], last: null };
  const onAbort = () => input.close();
  signal.addEventListener('abort', onAbort, { once: true });
  writePage([
    `Pinned Git commit: ${inventory.commitId} (${inventory.objectFormat}); root tree: ${inventory.rootTreeId}.`,
    `Inventory ${inventory.inventoryId}: ${inventory.counts.files} committed .ts candidates, ${inventory.counts.uniqueTrees} verified trees, ${inventory.counts.treeVisits} tree-path visits, ${inventory.counts.treeEntries} tree entries.`,
    `Inventory status: ${inventory.truncated ? `incomplete (${inventory.truncationReasons.join(', ')})` : 'complete'}. Source blobs are not read until analyze.`,
    `Unsupported paths: ${inventory.counts.unsupportedPaths}; symlink/gitlink entries excluded from traversal: ${inventory.counts.nonregularEntries}.`,
    `Inventory limits: ${JSON.stringify(inventory.appliedLimits)}. Analysis: ${ANALYSIS_LIMITS.maxFiles} files, ${ANALYSIS_LIMITS.maxFileBytes} bytes/file, ${ANALYSIS_LIMITS.maxTotalBytes} bytes total.`,
    ...usage,
  ]);
  showQuery(state, {});
  if (input.terminal) {
    input.setPrompt('ct-source> ');
    input.prompt();
  }
  try {
    for await (const line of input) {
      try {
        if (signal.aborted) return null;
        if (++budget.used > MAX_SESSION_COMMANDS)
          throw new CliError(
            'SESSION_LIMIT',
            `Source selection is limited to ${MAX_SESSION_COMMANDS} commands.`,
          );
        const [command, ...args] = tokenize(line);
        if (command) {
          const result = executeCommand(state, command, args);
          if (result === 'quit') {
            input.close();
            return null;
          }
          if (result !== null) return result;
        }
      } catch (error) {
        // Preserve the browse CLI's existing error name while the adapter exposes its typed state.
        printError(
          error instanceof GitSourceError &&
            error.code === 'INCOMPLETE_INVENTORY'
            ? new GitSourceError(
                'SOURCE_INVENTORY_INCOMPLETE',
                error.message,
                error.selection,
              )
            : error,
        );
        if (!input.terminal) {
          process.exitCode = 2;
          input.close();
          return null;
        }
      }
      if (input.terminal) input.prompt();
    }
    return null;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
