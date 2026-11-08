import { CliError } from './commands.ts';
import { AnalysisError } from '@codethread/symbol-indexer';
import { TraceError } from '@codethread/trace-engine';
import { GitSourceError } from '../git-source/types.ts';
import { summarizeSelection } from '../git-source/selection.ts';

export const MAX_RESPONSE_BYTES = 64 * 1024;

export function escapeTerminal(value: string): string {
  let result = '';
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (isTerminalUnsafe(character, point))
      result += `\\u{${point.toString(16)}}`;
    else result += character;
  }
  return result;
}

export function isTerminalUnsafe(character: string, point: number): boolean {
  return (
    point < 0x20 ||
    (point >= 0x7f && point <= 0x9f) ||
    point === 0x2028 ||
    point === 0x2029 ||
    /^\p{Cf}$/u.test(character)
  );
}

export function quoted(value: string): string {
  return JSON.stringify(escapeTerminal(value));
}

export function commandArgument(value: string): string {
  let result = '';
  for (const character of JSON.stringify(value)) {
    const point = character.codePointAt(0)!;
    if (isTerminalUnsafe(character, point)) {
      if (point <= 0xffff)
        result += `\\u${point.toString(16).padStart(4, '0')}`;
      else {
        const scalar = point - 0x10000,
          high = 0xd800 + (scalar >> 10),
          low = 0xdc00 + (scalar & 0x3ff);
        result += `\\u${high.toString(16)}\\u${low.toString(16)}`;
      }
    } else result += character;
  }
  return result;
}

export function appendBounded(blocks: readonly string[]): {
  text: string;
  visibleBlockCount: number;
} {
  const marker = `[Text response truncated at ${MAX_RESPONSE_BYTES} bytes; whole later rows omitted.]`;
  const markerBytes = Buffer.byteLength(marker + '\n');
  const result: string[] = [];
  let used = 0,
    visibleBlockCount = 0;
  for (const block of blocks) {
    const chunk = block.endsWith('\n') ? block : `${block}\n`;
    const bytes = Buffer.byteLength(chunk);
    if (used + bytes + markerBytes > MAX_RESPONSE_BYTES) {
      result.push(marker);
      break;
    }
    result.push(chunk);
    used += bytes;
    visibleBlockCount++;
  }
  return { text: result.join('').trimEnd() + '\n', visibleBlockCount };
}

export function writePage(blocks: readonly string[]): number {
  const page = appendBounded(blocks);
  process.stdout.write(page.text);
  return page.visibleBlockCount;
}

export function printError(error: unknown): void {
  const code =
    error instanceof CliError ||
    error instanceof AnalysisError ||
    error instanceof TraceError ||
    error instanceof GitSourceError
      ? error.code
      : 'INTERNAL_ERROR';
  const message =
    error instanceof Error
      ? escapeTerminal(error.message)
      : 'Unexpected failure.';
  process.stderr.write(`ERROR[${code}] ${message}\n`);
  if (error instanceof GitSourceError && error.selection.length > 0) {
    process.stderr.write(
      `Source selection: ${summarizeSelection(error.selection)}.\n`,
    );
    for (const item of error.selection)
      process.stderr.write(`  ${quoted(item.path)}: ${item.status}\n`);
  }
}
