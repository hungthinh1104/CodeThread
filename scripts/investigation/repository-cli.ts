import type { AnalysisSnapshot } from '@codethread/symbol-indexer';
import { analyzeGitRepository } from './repository-session.ts';
import type { RepositoryInvestigationSession } from './repository-session.ts';
import { createCliLineInput } from './input.ts';
import type { CliLineInput } from './input.ts';
import { CliError, MAX_SESSION_COMMANDS, tokenize } from './commands.ts';
import { printError, quoted, writePage } from './terminal.ts';
import { startSession } from './session.ts';
import { runRepositoryViewer } from '../viewer.ts';

function projectRows(session: RepositoryInvestigationSession) {
  return session.projects.map((item) => {
    const label = item.project.configPath ?? 'default';
    const detail = item.error?.code ?? item.project.diagnostics[0]?.code ?? '';
    return `${quoted(label)}: ${item.status}; ${item.project.rootPaths.length} root files${item.project.configPath === null ? '; default context for unassigned source' : ''}${detail ? '; ' + detail : ''}.`;
  });
}

async function chooseProject(
  session: RepositoryInvestigationSession,
  input: CliLineInput,
  budget: { used: number },
): Promise<AnalysisSnapshot | null> {
  writePage([
    'Commands: projects | find <name-or-path> | use <config-path|default> | quit',
    ...projectRows(session),
  ]);
  if (input.terminal) {
    input.setPrompt('ct-project> ');
    input.prompt();
  }
  for await (const line of input) {
    try {
      if (++budget.used > MAX_SESSION_COMMANDS)
        throw new CliError(
          'SESSION_LIMIT',
          'Repository session command limit exceeded.',
        );
      const [command, ...args] = tokenize(line);
      if (!command) continue;
      if (command === 'quit' || command === 'exit') return null;
      if (command === 'projects' && !args.length)
        writePage(projectRows(session));
      else if (command === 'find' && args.length === 1) {
        const query = args[0]!.toLowerCase();
        const matches = session.projects.flatMap(
          (item) =>
            item.snapshot?.facts.symbols
              .filter(
                (symbol) =>
                  symbol.name.toLowerCase().includes(query) ||
                  symbol.filePath.toLowerCase().includes(query),
              )
              .map(
                (symbol) =>
                  `${quoted(item.project.configPath ?? 'default')}: ${symbol.name} ${quoted(symbol.filePath)}@${symbol.range.start.line}:${symbol.range.start.column}`,
              ) ?? [],
        );
        writePage([
          `${matches.length} declarations across separate contexts; showing at most 50.`,
          ...matches.slice(0, 50),
        ]);
      } else if (command === 'use' && args.length === 1) {
        const item = session.projects.find(
          (item) =>
            (item.project.configPath ?? 'default') === args[0] ||
            item.project.id === args[0],
        );
        if (!item?.snapshot)
          throw new CliError(
            'PROJECT_UNAVAILABLE',
            'Select a ready project from projects.',
          );
        return item.snapshot;
      } else
        throw new CliError(
          'INVALID_COMMAND',
          'Use projects, find <text>, use <config-path|default>, or quit.',
        );
    } catch (error) {
      printError(error);
      if (error instanceof CliError && error.code === 'SESSION_LIMIT') {
        process.exitCode = 2;
        return null;
      }
    }
    if (input.terminal) input.prompt();
  }
  return null;
}

export async function runRepositoryCommand(command: {
  repositoryPath: string;
  repositoryId: string;
  revision: string;
  view: boolean;
}): Promise<void> {
  const controller = new AbortController(),
    onInterrupt = () => controller.abort();
  process.once('SIGINT', onInterrupt);
  let session: RepositoryInvestigationSession;
  try {
    process.stdout.write(
      'Analyzing pinned repository sources and project contexts...\n',
    );
    session = await analyzeGitRepository({
      ...command,
      signal: controller.signal,
    });
  } finally {
    process.removeListener('SIGINT', onInterrupt);
  }
  writePage([
    `Pinned Git commit: ${session.commitId} (${session.objectFormat}).`,
    `Repository ID: ${session.repositoryId} (session-local when omitted).`,
    `Source inventory: ${session.files.length} files, ${session.inventory.sourceBytes} bytes; complete=${session.inventory.complete}.`,
    `Source coverage complete=${session.sourceCoverageComplete}; project analysis complete=${session.analysisComplete}; project/type context complete=${session.contextComplete}.`,
    'Semantic coverage and query truncation are reported separately for each snapshot.',
    ...session.files
      .filter((file) => file.status !== 'analyzed')
      .slice(0, 50)
      .map(
        (file) => `${quoted(file.path)}: not analyzed; inspect project errors.`,
      ),
  ]);
  if (command.view) {
    await runRepositoryViewer(session);
    return;
  }
  const input = createCliLineInput(),
    budget = { used: 0 };
  try {
    const snapshot = await chooseProject(session, input, budget);
    if (snapshot) await startSession(snapshot, input, budget);
  } finally {
    input.close();
  }
}
