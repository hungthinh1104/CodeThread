import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpus, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import ts from 'typescript';
import {
  createSourcePositionIndex,
  positionAt,
  validateSourceRange,
} from '@codethread/code-model';

const median = (values: number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
let checksum = 0;
const workloads = [];
for (const lines of [100, 6000]) {
  const source = Array.from(
    { length: lines },
    (_, index) => `const value${index} = 'café 😀'; // deterministic input\r\n`,
  ).join('');
  const offsets = Array.from({ length: 3000 }, (_, index) =>
    Math.floor((((index * 104729) % 1000003) / 1000003) * (source.length + 1)),
  );
  const file = ts.createSourceFile(
    'benchmark.ts',
    source,
    ts.ScriptTarget.Latest,
  );
  const expected = (offset: number) => {
    const point = file.getLineAndCharacterOfPosition(offset);
    return { offset, line: point.line + 1, column: point.character + 1 };
  };
  const ranges = offsets.map((offset) => ({
    start: expected(offset),
    end: expected(Math.min(offset + 3, source.length)),
  }));
  const oracleIndex = createSourcePositionIndex(source);
  for (const offset of [0, source.length, ...offsets]) {
    if (
      JSON.stringify(oracleIndex.positionAt(offset)) !==
      JSON.stringify(expected(offset))
    )
      throw new Error('Position differs from TypeScript');
  }
  for (const range of ranges)
    if (!oracleIndex.validateRange(range))
      throw new Error('Range differs from TypeScript');
  for (const offset of offsets.slice(0, 25)) {
    positionAt(source, offset);
    oracleIndex.positionAt(offset);
  }
  const samples = [];
  for (let repeat = 0; repeat < 3; repeat++) {
    let start = performance.now();
    for (const offset of offsets) checksum += positionAt(source, offset).column;
    const legacyLookupMs = performance.now() - start;
    start = performance.now();
    const indexed = createSourcePositionIndex(source);
    const constructionMs = performance.now() - start;
    start = performance.now();
    for (const offset of offsets) checksum += indexed.positionAt(offset).column;
    const indexedLookupMs = performance.now() - start;
    start = performance.now();
    for (const range of ranges)
      checksum += Number(validateSourceRange(source, range));
    const legacyValidationMs = performance.now() - start;
    start = performance.now();
    for (const range of ranges)
      checksum += Number(indexed.validateRange(range));
    const indexedValidationMs = performance.now() - start;
    samples.push({
      legacyLookupMs,
      constructionMs,
      indexedLookupMs,
      legacyValidationMs,
      indexedValidationMs,
      legacyTotalMs: legacyLookupMs + legacyValidationMs,
      indexedTotalMs: constructionMs + indexedLookupMs + indexedValidationMs,
    });
  }
  const legacyMedianMs = median(samples.map((sample) => sample.legacyTotalMs)),
    indexedMedianMs = median(samples.map((sample) => sample.indexedTotalMs));
  workloads.push({
    lines,
    utf16Length: source.length,
    utf8Bytes: Buffer.byteLength(source),
    sha256: createHash('sha256').update(source).digest('hex'),
    positions: offsets.length,
    ranges: ranges.length,
    samples,
    legacyMedianMs,
    indexedMedianMs,
    speedup: legacyMedianMs / indexedMedianMs,
  });
}
let revision = 'unavailable',
  dirty: boolean | null = null;
try {
  revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  dirty =
    execFileSync('git', ['--no-optional-locks', 'status', '--porcelain'], {
      encoding: 'utf8',
    }).trim().length > 0;
} catch {
  /* A source export need not have Git metadata. */
}
process.stdout.write(
  JSON.stringify(
    {
      revision,
      dirty,
      node: process.version,
      typescript: ts.version,
      platform: process.platform,
      arch: process.arch,
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      memoryBytes: totalmem(),
      methodology:
        'Deterministic 3000 offsets and ranges; TypeScript oracle outside timings; 25 warmup lookups; 3 repeats; indexed total includes construction; no CI timing assertions; synthetic input only',
      workloads,
      checksum,
    },
    null,
    2,
  ) + '\n',
);
