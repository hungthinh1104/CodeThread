import { channel } from 'node:diagnostics_channel';

type QueryTrace = {
  database?: string;
  queued?: number;
  sent?: number;
  complete?: number;
};
type PoolTrace = { database?: string; event?: string; waited?: number };

function percentiles(values: readonly number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number) =>
    Number(
      sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)]!.toFixed(2),
    );
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}

/** Reads postgres.js v4 diagnostics without recording SQL or parameter values. */
export class DatabaseTelemetry {
  private readonly database: string;
  private queueMs: number[] = [];
  private roundTripMs: number[] = [];
  private leaseWaitMs: number[] = [];
  private readonly queryChannel = channel('tracing:postgres:query:asyncEnd');
  private readonly poolChannel = channel('postgres:pool');
  private readonly onQuery = (value: unknown) => {
    const trace = value as QueryTrace;
    if (trace.database !== this.database) return;
    if (typeof trace.queued === 'number' && typeof trace.sent === 'number')
      this.queueMs.push(Math.max(0, trace.sent - trace.queued));
    if (typeof trace.sent === 'number' && typeof trace.complete === 'number')
      this.roundTripMs.push(Math.max(0, trace.complete - trace.sent));
  };
  private readonly onPool = (value: unknown) => {
    const trace = value as PoolTrace;
    if (
      trace.database === this.database &&
      trace.event === 'lease' &&
      typeof trace.waited === 'number'
    )
      this.leaseWaitMs.push(Math.max(0, trace.waited));
  };

  constructor(database: string) {
    this.database = database;
    this.queryChannel.subscribe(this.onQuery);
    this.poolChannel.subscribe(this.onPool);
  }

  reset() {
    this.queueMs = [];
    this.roundTripMs = [];
    this.leaseWaitMs = [];
  }

  result() {
    return {
      queryQueueMs: percentiles(this.queueMs),
      queryRoundTripMs: percentiles(this.roundTripMs),
      transactionLeaseWaitMs: percentiles(this.leaseWaitMs),
    };
  }

  close() {
    this.queryChannel.unsubscribe(this.onQuery);
    this.poolChannel.unsubscribe(this.onPool);
  }
}
