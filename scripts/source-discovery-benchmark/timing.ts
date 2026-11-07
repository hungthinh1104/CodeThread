import { performance } from 'node:perf_hooks';
import type { GitInventorySession } from '../git-source/inventory-types.ts';
import { repeats, type StageMeasurement } from './config.ts';

export function median(samplesMs: readonly number[]): number {
  const sorted = [...samplesMs].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

export async function measure(
  operationsPerSample: number,
  operation: () => void | Promise<void>,
): Promise<StageMeasurement> {
  const samplesMs: number[] = [];
  let peakDelta = 0;
  for (let sample = 0; sample < repeats; sample++) {
    global.gc?.();
    const initialRss = process.memoryUsage().rss;
    let peakRss = initialRss;
    const timer = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }, 5);
    const started = performance.now();
    try {
      await operation();
    } finally {
      clearInterval(timer);
    }
    samplesMs.push(Number((performance.now() - started).toFixed(3)));
    peakDelta = Math.max(
      peakDelta,
      Math.max(0, peakRss - initialRss) / (1024 * 1024),
    );
  }
  const elapsed = samplesMs.reduce((total, value) => total + value, 0);
  return {
    samplesMs,
    medianMs: median(samplesMs),
    operationsPerSample,
    meanMsPerOperation: Number(
      (elapsed / repeats / operationsPerSample).toFixed(6),
    ),
    peakRssDeltaMiB: Number(peakDelta.toFixed(2)),
  };
}

export async function pageAll(session: GitInventorySession): Promise<string[]> {
  const paths: string[] = [];
  let cursor: string | undefined;
  do {
    const page = session.query({ limit: 50, ...(cursor ? { cursor } : {}) });
    paths.push(...page.items.map((file) => file.path));
    cursor = page.nextCursor ?? undefined;
    await new Promise<void>((resolveNext) => setImmediate(resolveNext));
  } while (cursor);
  if (new Set(paths).size !== paths.length)
    throw new Error('Pagination returned a duplicate path.');
  return paths;
}
