export const MAX_SESSION_COMMANDS = 100;

export const MAX_COMMAND_LENGTH = 4096;

export class CliError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CliError';
    this.code = code;
  }
}

export function tokenize(line: string): string[] {
  if (line.length > MAX_COMMAND_LENGTH)
    throw new CliError('COMMAND_TOO_LONG', 'Command exceeds 4096 characters.');
  const tokens: string[] = [];
  let index = 0;
  while (index < line.length) {
    while (/\s/.test(line[index] ?? '')) index++;
    if (index >= line.length) break;
    if (line[index] === '"') {
      const start = index++;
      let escaped = false;
      for (; index < line.length; index++) {
        const character = line[index]!;
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') {
          index++;
          break;
        }
      }
      if (line[index - 1] !== '"')
        throw new CliError('INVALID_COMMAND', 'Unclosed JSON-quoted argument.');
      let value: unknown;
      try {
        value = JSON.parse(line.slice(start, index)) as unknown;
      } catch {
        throw new CliError('INVALID_COMMAND', 'Invalid JSON-quoted argument.');
      }
      if (typeof value !== 'string')
        throw new CliError(
          'INVALID_COMMAND',
          'Quoted arguments must be strings.',
        );
      tokens.push(value);
      if (index < line.length && !/\s/.test(line[index]!))
        throw new CliError(
          'INVALID_COMMAND',
          'Separate quoted arguments with spaces.',
        );
    } else {
      const start = index;
      while (index < line.length && !/\s/.test(line[index]!)) index++;
      tokens.push(line.slice(start, index));
    }
  }
  return tokens;
}
