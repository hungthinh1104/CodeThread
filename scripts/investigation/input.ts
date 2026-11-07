import { createInterface } from 'node:readline';
import {
  CliError,
  MAX_COMMAND_LENGTH,
  MAX_SESSION_COMMANDS,
} from './commands.ts';

export interface CliLineInput extends AsyncIterable<string> {
  terminal: boolean;
  setPrompt(prompt: string): void;
  prompt(): void;
  close(): void;
}

export interface SessionCommandBudget {
  used: number;
}

export function createCliLineInput(): CliLineInput {
  const input = process.stdin,
    output = process.stdout,
    terminal = Boolean(input.isTTY && output.isTTY),
    readline = createInterface({ input, output, terminal }),
    queued: string[] = [],
    waiters: ((line: string | undefined) => void)[] = [];
  let closed = false,
    inputError: CliError | undefined;
  readline.on('line', (line) => {
    if (inputError) return;
    if (line.length > MAX_COMMAND_LENGTH) {
      inputError = new CliError(
        'COMMAND_TOO_LONG',
        `Command exceeds ${MAX_COMMAND_LENGTH} characters.`,
      );
      queued.length = 0;
      readline.close();
      return;
    }
    if (queued.length >= MAX_SESSION_COMMANDS) {
      inputError = new CliError(
        'SESSION_LIMIT',
        `Session is limited to ${MAX_SESSION_COMMANDS} commands.`,
      );
      queued.length = 0;
      readline.close();
      return;
    }
    const next = waiters.shift();
    if (next) next(line);
    else queued.push(line);
  });
  readline.once('close', () => {
    closed = true;
    while (waiters.length > 0) waiters.shift()!(undefined);
  });
  const nextLine = (): Promise<string | undefined> => {
    if (inputError) return Promise.reject(inputError);
    if (queued.length > 0) return Promise.resolve(queued.shift()!);
    if (closed) return Promise.resolve(undefined);
    return new Promise<string | undefined>((resolveLine) =>
      waiters.push(resolveLine),
    ).then((line) => {
      if (inputError) throw inputError;
      return line;
    });
  };
  return {
    terminal,
    setPrompt: (prompt) => readline.setPrompt(prompt),
    prompt: () => readline.prompt(),
    close: () => readline.close(),
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const line = await nextLine();
        if (line === undefined) return;
        yield line;
      }
    },
  };
}
