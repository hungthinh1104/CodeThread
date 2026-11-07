import { CliError } from './commands.ts';
import { quoted } from './terminal.ts';

export type InvestigationCommand =
  | { kind: 'manifest'; path: string; view: boolean }
  | { kind: 'demo'; view: boolean }
  | {
      kind: 'git';
      repositoryPath: string;
      repositoryId: string;
      revision: string;
      selectedPaths: string[];
      browse: boolean;
      view: boolean;
    }
  | { kind: 'help' };

export function parseArguments(args: readonly string[]): InvestigationCommand {
  const viewCount = args.filter((argument) => argument === '--view').length;
  if (viewCount > 1)
    throw new CliError('INVALID_ARGUMENT', '--view may be specified once.');
  const view = viewCount === 1,
    sourceArgs = args.filter((argument) => argument !== '--view');
  if (
    sourceArgs.length === 1 &&
    (sourceArgs[0] === '--help' || sourceArgs[0] === '-h')
  )
    return { kind: 'help' };
  if (
    sourceArgs.length === 2 &&
    sourceArgs[0] === '--manifest' &&
    sourceArgs[1]!.length > 0
  )
    return { kind: 'manifest', path: sourceArgs[1]!, view };
  if (
    sourceArgs.length === 2 &&
    sourceArgs[0] === '--demo' &&
    sourceArgs[1] === 'todo'
  )
    return { kind: 'demo', view };
  if (
    sourceArgs[0] === '--repo' ||
    sourceArgs.some((argument) => argument.startsWith('--repo='))
  ) {
    let repositoryPath: string | undefined,
      repositoryId: string | undefined,
      revision: string | undefined,
      browse = false;
    const selectedPaths: string[] = [];
    const setValue = (option: string, value: string): void => {
      if (option === '--repo') {
        if (repositoryPath !== undefined)
          throw new CliError(
            'INVALID_ARGUMENT',
            '--repo may be specified once.',
          );
        repositoryPath = value;
      } else if (option === '--repository-id') {
        if (repositoryId !== undefined)
          throw new CliError(
            'INVALID_ARGUMENT',
            '--repository-id may be specified once.',
          );
        repositoryId = value;
      } else if (option === '--revision') {
        if (revision !== undefined)
          throw new CliError(
            'INVALID_ARGUMENT',
            '--revision may be specified once.',
          );
        revision = value;
      } else selectedPaths.push(value);
    };
    for (let index = 0; index < sourceArgs.length; index++) {
      const argument = sourceArgs[index]!;
      if (argument === '--browse') {
        if (browse)
          throw new CliError(
            'INVALID_ARGUMENT',
            '--browse may be specified once.',
          );
        browse = true;
        continue;
      }
      const equals = /^(--repo|--repository-id|--revision|--file)=(.*)$/.exec(
        argument,
      );
      if (equals) {
        const value = equals[2]!;
        setValue(equals[1]!, value);
        continue;
      }
      if (
        argument === '--repo' ||
        argument === '--repository-id' ||
        argument === '--revision' ||
        argument === '--file'
      ) {
        const value = sourceArgs[++index];
        if (value === undefined || value.length === 0)
          throw new CliError(
            'INVALID_ARGUMENT',
            `${argument} requires a value.`,
          );
        setValue(argument, value);
        continue;
      }
      throw new CliError(
        'INVALID_ARGUMENT',
        `Unknown Git source option ${quoted(argument)}.`,
      );
    }
    if (
      !repositoryPath ||
      !repositoryId ||
      !revision ||
      (browse ? selectedPaths.length !== 0 : selectedPaths.length === 0)
    )
      throw new CliError(
        'INVALID_ARGUMENT',
        'Usage: pnpm investigate -- --repo <root> --repository-id <uuid> --revision <commit|HEAD|refs/heads/...|refs/tags/...> (--browse | --file <path> [--file=<path> ...]).',
      );
    return {
      kind: 'git',
      repositoryPath,
      repositoryId,
      revision,
      selectedPaths,
      browse,
      view,
    };
  }
  throw new CliError(
    'INVALID_ARGUMENT',
    'Usage: pnpm investigate -- --manifest <manifest.json> | --repo <root> --repository-id <uuid> --revision <revision> --file <path> | pnpm demo:investigation',
  );
}
