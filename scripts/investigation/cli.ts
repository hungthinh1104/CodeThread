import { analyzeManifest, AnalysisError } from '@codethread/symbol-indexer';
import type {
  AnalysisInput,
  AnalysisSnapshot,
} from '@codethread/symbol-indexer';
import { GitSourceError } from '../git-source/types.ts';
import type {
  AcquiredGitSources,
  GitSelectionStatus,
} from '../git-source/types.ts';
import { acquireGitSources } from '../git-source/acquire.ts';
import { openGitInventory } from '../git-source/inventory.ts';
import { summarizeSelection } from '../git-source/selection.ts';
import { createCliLineInput } from './input.ts';
import type { CliLineInput, SessionCommandBudget } from './input.ts';
import { runViewer } from '../viewer.ts';
import { startSourceSelectionSession } from './source-browser.ts';
import { parseArguments } from './arguments.ts';
import { runRepositoryCommand } from './repository-cli.ts';
import {
  loadTodoDemo,
  parseManifest,
  readManifestFile,
  MAX_MANIFEST_BYTES,
  MAX_SOURCE_FILES,
  MAX_SOURCE_FILE_BYTES,
  MAX_TOTAL_SOURCE_BYTES,
} from './manifest.ts';
import { startSession } from './session.ts';
import { printError, quoted, writePage } from './terminal.ts';

export async function runInvestigationCli(
  args = process.argv.slice(2),
): Promise<void> {
  let acquired: AcquiredGitSources | undefined,
    cliInput: CliLineInput | undefined;
  const commandBudget: SessionCommandBudget = { used: 0 };
  try {
    const command = parseArguments(args);
    if (command.kind === 'help') {
      writePage([
        'CodeThread bounded textual source investigation.',
        'Usage: pnpm investigate -- [--view] --manifest <manifest.json>',
        '       pnpm investigate -- [--view] --repo <root> --repository-id <uuid> --revision <revision> (--browse | --file <path> [--file=<path> ...])',
        '       pnpm investigate -- --repo <root> --revision <revision> --scope repository [--repository-id <uuid>] [--view]',
        'Repository profile: 1,000 .ts files, 32 MiB total, 1 MiB/file, 32 contexts; 120 seconds per session.',
        'Pinned examples: pnpm demo:investigation | pnpm demo:visual',
        `Manifest limit: ${MAX_MANIFEST_BYTES} bytes; source limits: ${MAX_SOURCE_FILES} files, ${MAX_SOURCE_FILE_BYTES} bytes/file, ${MAX_TOTAL_SOURCE_BYTES} bytes total.`,
      ]);
      return;
    }
    if (command.kind === 'repository') {
      await runRepositoryCommand(command);
      return;
    }
    let input: AnalysisInput;
    if (command.kind === 'demo') input = await loadTodoDemo();
    else if (command.kind === 'manifest')
      input = parseManifest(await readManifestFile(command.path));
    else {
      const controller = new AbortController(),
        onInterrupt = () => controller.abort();
      process.once('SIGINT', onInterrupt);
      try {
        if (command.browse) {
          const session = await openGitInventory({
            repositoryPath: command.repositoryPath,
            repositoryId: command.repositoryId,
            revision: command.revision,
            signal: controller.signal,
          });
          cliInput = createCliLineInput();
          const selected = await startSourceSelectionSession(
            session,
            controller.signal,
            cliInput,
            commandBudget,
          );
          if (controller.signal.aborted)
            throw new GitSourceError(
              'CANCELLED',
              'Git source selection cancelled.',
            );
          if (selected === null) return;
          acquired = await session.acquire(selected, controller.signal);
        } else
          acquired = await acquireGitSources({
            repositoryPath: command.repositoryPath,
            repositoryId: command.repositoryId,
            revision: command.revision,
            selectedPaths: command.selectedPaths,
            signal: controller.signal,
          });
      } finally {
        process.removeListener('SIGINT', onInterrupt);
      }
      input = acquired.input;
    }
    let snapshot: AnalysisSnapshot;
    try {
      snapshot = await analyzeManifest(input);
    } catch (error) {
      if (error instanceof AnalysisError && acquired) {
        const failedPath = error.sourcePath;
        const selection: GitSelectionStatus[] = acquired.selection.map(
          (item) => ({
            path: item.path,
            status:
              failedPath === undefined
                ? 'not-admitted'
                : item.path === failedPath
                  ? 'rejected'
                  : 'not-admitted',
          }),
        );
        process.stderr.write(
          `Source selection: ${summarizeSelection(selection)}.\n`,
        );
        for (const item of selection)
          process.stderr.write(`  ${quoted(item.path)}: ${item.status}\n`);
      }
      throw error;
    }
    if (acquired) {
      writePage([
        `Pinned Git commit: ${acquired.provenance.commitId} (${acquired.provenance.objectFormat}).`,
        `Source selection: ${summarizeSelection(acquired.selection)}.`,
        ...acquired.provenance.files.map(
          (file) =>
            `Git object ${quoted(file.path)}: ${file.blobId} (${file.mode}, sha256:${file.sha256}).`,
        ),
      ]);
    }
    if (command.view) {
      cliInput?.close();
      await runViewer(snapshot);
    } else await startSession(snapshot, cliInput, commandBudget);
  } catch (error) {
    cliInput?.close();
    printError(error);
    process.exitCode =
      (error instanceof GitSourceError || error instanceof AnalysisError) &&
      error.code === 'CANCELLED'
        ? 130
        : 2;
  }
}
