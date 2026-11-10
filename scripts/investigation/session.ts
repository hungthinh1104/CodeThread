import type { CodeSymbol } from '@codethread/code-model';
import type { AnalysisSnapshot } from '@codethread/symbol-indexer';
import { createInvestigation } from '@codethread/trace-engine';
import { CliError, MAX_SESSION_COMMANDS, tokenize } from './commands.ts';
import { printError, quoted, writePage } from './terminal.ts';
import { createCliLineInput } from './input.ts';
import type { SessionCommandBudget } from './input.ts';
import {
  parseKinds,
  parseDirection,
  selectSymbol,
  listFiles,
  listSymbols,
  sourceSelector,
  displaySelector,
} from './selectors.ts';
import type { Direction, RelationKind } from './selectors.ts';
import { overviewBlocks, helpBlocks } from './render-common.ts';
import { inspectBlocks } from './render-inspection.ts';
import { evidenceBlocks } from './render-evidence.ts';

export async function startSession(
  snapshot: AnalysisSnapshot,
  input = createCliLineInput(),
  budget: SessionCommandBudget = { used: 0 },
): Promise<void> {
  const investigation = createInvestigation(snapshot.facts, snapshot.source, {
      resourceProfile: snapshot.resourceProfile ?? 'selected',
    }),
    targets = new Map<string, CodeSymbol>(),
    terminal = input.terminal;
  let lastKinds: RelationKind[] = ['calls'],
    lastDirection: Direction = 'both';
  writePage(overviewBlocks(snapshot));
  if (terminal) {
    input.setPrompt('ct> ');
    input.prompt();
  }
  try {
    for await (const line of input) {
      budget.used++;
      try {
        if (budget.used > MAX_SESSION_COMMANDS)
          throw new CliError(
            'SESSION_LIMIT',
            `Session is limited to ${MAX_SESSION_COMMANDS} commands.`,
          );
        const tokens = tokenize(line),
          [command, ...args] = tokens;
        if (!command) {
          if (terminal) input.prompt();
          continue;
        }
        if (command === 'quit' || command === 'exit') {
          input.close();
          break;
        }
        if (command === 'help') {
          if (args.length !== 0)
            throw new CliError('INVALID_COMMAND', 'help takes no arguments.');
          writePage(helpBlocks());
        } else if (command === 'files') {
          if (args.length !== 0)
            throw new CliError('INVALID_COMMAND', 'files takes no arguments.');
          writePage(listFiles(snapshot));
        } else if (command === 'symbols') {
          if (args.length > 1)
            throw new CliError(
              'INVALID_COMMAND',
              'Usage: symbols [source-path].',
            );
          writePage(listSymbols(snapshot, args[0]));
        } else if (command === 'inspect' || command === 'follow') {
          if (args.length < 1 || args.length > 3)
            throw new CliError(
              'INVALID_COMMAND',
              `Usage: ${command} <source-selector> [kinds] [direction].`,
            );
          const selected = selectSymbol(snapshot.facts, args[0]!);
          if (command === 'follow') {
            if (args[0]!.startsWith('name:'))
              throw new CliError(
                'INVALID_SELECTOR',
                'Follow targets by the source selector printed with each relationship.',
              );
            if (!targets.has(sourceSelector(selected)))
              throw new CliError(
                'TARGET_NOT_IN_LAST_RESULTS',
                `${displaySelector(selected)} was not a displayed exact target of the previous inspection.`,
              );
          }
          const kinds = parseKinds(
              args[1] ??
                (command === 'follow' ? lastKinds.join(',') : undefined),
            ),
            direction = parseDirection(
              args[2] ?? (command === 'follow' ? lastDirection : undefined),
            );
          const nextTargets = new Map<number, CodeSymbol>(),
            blocks = inspectBlocks(
              snapshot,
              investigation,
              selected,
              kinds,
              direction,
              nextTargets,
            );
          lastKinds = kinds;
          lastDirection = direction;
          const visibleBlockCount = writePage(blocks);
          targets.clear();
          for (const [rowIndex, symbol] of nextTargets)
            if (rowIndex < visibleBlockCount)
              targets.set(sourceSelector(symbol), symbol);
        } else if (command === 'evidence') {
          if (args.length < 2 || args.length > 3)
            throw new CliError(
              'INVALID_COMMAND',
              'Usage: evidence symbol <selector> [offset] | evidence site <path@range> [offset].',
            );
          writePage(
            evidenceBlocks(
              snapshot,
              investigation,
              args[0]!,
              args[1]!,
              args[2],
            ),
          );
        } else
          throw new CliError(
            'INVALID_COMMAND',
            `Unknown command ${quoted(command)}. Type help for commands.`,
          );
      } catch (error) {
        printError(error);
        if (!terminal) {
          process.exitCode = 2;
          input.close();
          break;
        }
      }
      if (terminal) input.prompt();
    }
  } finally {
    input.close();
  }
}
