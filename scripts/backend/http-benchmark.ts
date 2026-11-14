import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { performance } from 'node:perf_hooks';
import type { AnalysisFacts } from '@codethread/code-model';
import type { Database } from './database.ts';
import { connect } from './database.ts';
import { makeApi } from './http.ts';
import { ScanService } from './service.ts';
import { DatabaseTelemetry } from './benchmark-telemetry.ts';

type QueryTotals = { count: number; durationMs: number };
type ApiOperation = {
  name: 'symbols' | 'neighbors' | 'paths' | 'evidence';
  path: string;
  method: 'GET' | 'POST';
  body?: object;
};
type ApiSample = {
  latencyMs: number;
  responseBytes: number;
  outcome: string;
  queryCount?: number;
  databaseQueryLatencyMs?: number;
};

export type HttpBenchmarkInput = {
  databaseUrl: string;
  root: string;
  analyzerBuildHash: string;
  scanId: string;
  projectId: string;
  snapshotId: string;
  facts: AnalysisFacts;
  iterations?: number;
  coldSamples?: number;
};

export class DatabaseQueryTimer implements QueryTotals {
  count = 0;
  durationMs = 0;

  reset() {
    this.count = 0;
    this.durationMs = 0;
  }

  record(durationMs: number) {
    this.count++;
    this.durationMs += durationMs;
  }
}

function trackQuery<T>(query: T, timer: DatabaseQueryTimer): T {
  if (!query || (typeof query !== 'object' && typeof query !== 'function'))
    return query;
  return new Proxy(query as object, {
    get(target, property, receiver) {
      if (property !== 'then') return Reflect.get(target, property, receiver);
      const then = Reflect.get(target, property, target);
      if (typeof then !== 'function') return then;
      return (
        fulfilled?: (value: unknown) => unknown,
        rejected?: (error: unknown) => unknown,
      ) => {
        const started = performance.now();
        return Reflect.apply(then, target, [
          (value: unknown) => {
            timer.record(performance.now() - started);
            return fulfilled ? fulfilled(value) : value;
          },
          (error: unknown) => {
            timer.record(performance.now() - started);
            if (rejected) return rejected(error);
            throw error;
          },
        ]);
      };
    },
  }) as T;
}

export function instrumentDatabase(
  client: Database,
  timer: DatabaseQueryTimer,
): Database {
  const wrap = (raw: Database): Database =>
    new Proxy(raw, {
      apply(target, _thisArg, args) {
        return trackQuery(Reflect.apply(target, target, args), timer);
      },
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === 'begin' && typeof value === 'function')
          return (...args: unknown[]) => {
            const callbackIndex = args.findIndex(
              (argument) => typeof argument === 'function',
            );
            if (callbackIndex < 0) return Reflect.apply(value, target, args);
            const callback = args[callbackIndex] as (
              transaction: Database,
            ) => unknown;
            const wrappedArgs = [...args];
            wrappedArgs[callbackIndex] = (transaction: Database) =>
              callback(wrap(transaction));
            return Reflect.apply(value, target, wrappedArgs);
          };
        if (
          (property === 'unsafe' || property === 'file') &&
          typeof value === 'function'
        )
          return (...args: unknown[]) =>
            trackQuery(Reflect.apply(value, target, args), timer);
        if (typeof value === 'function') return value.bind(target);
        return value;
      },
    });
  return wrap(client);
}

async function reservePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  if (!address || typeof address === 'string')
    throw new Error('Loopback benchmark port reservation failed');
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function listenApi(
  db: Database,
  scans: ScanService,
): Promise<{ server: Server; baseUrl: string; secret: string }> {
  const port = await reservePort(),
    secret = randomUUID(),
    server = makeApi(db, scans, secret, port);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return { server, baseUrl: `http://127.0.0.1:${port}`, secret };
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function requestJson<T>(
  api: { baseUrl: string; secret: string },
  path: string,
  method: 'GET' | 'POST' = 'GET',
  body?: object,
): Promise<{ value: T; bytes: number; elapsedMs: number }> {
  const started = performance.now(),
    response = await fetch(api.baseUrl + path, {
      method,
      headers: {
        Authorization: `Bearer ${api.secret}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: 'no-store',
    }),
    text = await response.text();
  if (!response.ok)
    throw new Error(`HTTP benchmark request returned ${response.status}`);
  return {
    value: JSON.parse(text) as T,
    bytes: Buffer.byteLength(text),
    elapsedMs: performance.now() - started,
  };
}

function percentile(values: readonly number[], fraction: number): number {
  if (!values.length) throw new Error('Cannot summarize an empty sample');
  const sorted = [...values].sort((a, b) => a - b),
    index = Math.max(0, Math.ceil(fraction * sorted.length) - 1);
  return Number(sorted[index]!.toFixed(2));
}

function summarizeSamples(samples: readonly ApiSample[]) {
  const outcomes: Record<string, number> = {};
  for (const sample of samples)
    outcomes[sample.outcome] = (outcomes[sample.outcome] ?? 0) + 1;
  const successful = samples.filter((sample) => sample.outcome === 'ok');
  return {
    sampleCount: samples.length,
    outcomes,
    latencyMs: {
      p50: percentile(
        samples.map((sample) => sample.latencyMs),
        0.5,
      ),
      p95: percentile(
        samples.map((sample) => sample.latencyMs),
        0.95,
      ),
      p99: percentile(
        samples.map((sample) => sample.latencyMs),
        0.99,
      ),
    },
    successfulLatencyMs: successful.length
      ? {
          p50: percentile(
            successful.map((sample) => sample.latencyMs),
            0.5,
          ),
          p95: percentile(
            successful.map((sample) => sample.latencyMs),
            0.95,
          ),
          p99: percentile(
            successful.map((sample) => sample.latencyMs),
            0.99,
          ),
        }
      : null,
    responseBytes: {
      p50: percentile(
        samples.map((sample) => sample.responseBytes),
        0.5,
      ),
      p95: percentile(
        samples.map((sample) => sample.responseBytes),
        0.95,
      ),
      max: Math.max(...samples.map((sample) => sample.responseBytes)),
    },
    ...(samples.some((sample) => sample.queryCount !== undefined)
      ? {
          databaseQueryCount: samples.reduce(
            (total, sample) => total + (sample.queryCount ?? 0),
            0,
          ),
          databaseQueryLatencyMsTotal: Number(
            samples
              .reduce(
                (total, sample) => total + (sample.databaseQueryLatencyMs ?? 0),
                0,
              )
              .toFixed(2),
          ),
        }
      : {}),
  };
}

function makeOperations(input: HttpBenchmarkInput): ApiOperation[] {
  const symbolsById = new Map(
      input.facts.symbols.map((symbol) => [symbol.id, symbol]),
    ),
    exactCall = input.facts.relations.find(
      (relation) =>
        relation.kind === 'calls' && relation.resolution.status === 'exact',
    ),
    root = exactCall
      ? symbolsById.get(exactCall.sourceSymbolId)
      : input.facts.symbols[0],
    target =
      exactCall?.resolution.status === 'exact'
        ? symbolsById.get(exactCall.resolution.targetId)
        : input.facts.symbols.find((symbol) => symbol.id !== root?.id);
  const declarationEvidenceId = root?.declarationEvidenceId;
  if (!root || !declarationEvidenceId || !target)
    throw new Error('HTTP benchmark project lacks representative symbols');
  const base = `/v1/scans/${input.scanId}/projects/${input.projectId}`;
  return [
    {
      name: 'symbols',
      path: `${base}/symbols?query=${encodeURIComponent(root.name)}`,
      method: 'GET',
    },
    {
      name: 'neighbors',
      path: `${base}/neighbors`,
      method: 'POST',
      body: {
        snapshotId: input.snapshotId,
        symbolId: root.id,
        direction: 'outgoing',
        depth: 2,
        nodeLimit: 50,
      },
    },
    {
      name: 'paths',
      path: `${base}/paths`,
      method: 'POST',
      body: {
        snapshotId: input.snapshotId,
        fromSymbolId: root.id,
        toSymbolId: target.id,
        depth: 3,
        nodeLimit: 50,
        pathLimit: 20,
      },
    },
    {
      name: 'evidence',
      path: `${base}/evidence`,
      method: 'POST',
      body: {
        snapshotId: input.snapshotId,
        evidenceIds: [declarationEvidenceId],
      },
    },
  ];
}

async function sampleOperation(
  api: { baseUrl: string; secret: string },
  operation: ApiOperation,
): Promise<ApiSample> {
  const started = performance.now();
  try {
    const response = await fetch(api.baseUrl + operation.path, {
      method: operation.method,
      headers: {
        Authorization: `Bearer ${api.secret}`,
        ...(operation.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(operation.body ? { body: JSON.stringify(operation.body) } : {}),
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    const parsed = JSON.parse(text) as { error?: { code?: unknown } };
    const code = parsed?.error?.code;
    return {
      latencyMs: Number((performance.now() - started).toFixed(2)),
      responseBytes: Buffer.byteLength(text),
      outcome: response.ok
        ? 'ok'
        : `http_${response.status}${typeof code === 'string' && /^[A-Z_]+$/.test(code) ? `:${code}` : ''}`,
    };
  } catch (error) {
    return {
      latencyMs: Number((performance.now() - started).toFixed(2)),
      responseBytes: 0,
      outcome:
        error instanceof Error && error.name === 'TimeoutError'
          ? 'timeout'
          : 'request_error',
    };
  }
}

export async function benchmarkHttpApi(input: HttpBenchmarkInput) {
  const operations = makeOperations(input),
    coldSamples = input.coldSamples ?? 10,
    iterations = input.iterations ?? 30,
    cold: Record<string, unknown> = {},
    warm: Record<string, unknown> = {};
  if (
    !Number.isSafeInteger(coldSamples) ||
    !Number.isSafeInteger(iterations) ||
    coldSamples < 5 ||
    iterations < 10
  )
    throw new Error(
      'HTTP benchmark requires at least 5 cold and 10 warm samples',
    );

  for (const operation of operations) {
    const samples: ApiSample[] = [];
    for (let index = 0; index < coldSamples; index++) {
      const timer = new DatabaseQueryTimer(),
        db = instrumentDatabase(connect(input.databaseUrl), timer),
        scans = new ScanService(db, {
          root: input.root,
          analyzerBuildHash: input.analyzerBuildHash,
        });
      let api: Awaited<ReturnType<typeof listenApi>> | undefined;
      try {
        api = await listenApi(db, scans);
        timer.reset();
        const sample = await sampleOperation(api, operation);
        samples.push({
          ...sample,
          queryCount: timer.count,
          databaseQueryLatencyMs: Number(timer.durationMs.toFixed(2)),
        });
      } finally {
        scans.stop();
        if (api) await closeServer(api.server);
        await db.end({ timeout: 5 });
      }
    }
    cold[operation.name] = summarizeSamples(samples);
  }

  const timer = new DatabaseQueryTimer(),
    telemetry = new DatabaseTelemetry(
      decodeURIComponent(new URL(input.databaseUrl).pathname.slice(1)),
    ),
    db = instrumentDatabase(connect(input.databaseUrl), timer),
    scans = new ScanService(db, {
      root: input.root,
      analyzerBuildHash: input.analyzerBuildHash,
    });
  let api: Awaited<ReturnType<typeof listenApi>> | undefined;
  try {
    api = await listenApi(db, scans);
    for (const operation of operations) {
      const warmup = await sampleOperation(api, operation);
      if (warmup.outcome !== 'ok')
        throw new Error(
          `HTTP benchmark warm-up failed: ${operation.name} ${warmup.outcome}`,
        );
    }
    for (const operation of operations) {
      const concurrencyResults: Record<string, unknown>[] = [];
      for (const concurrency of [1, 4, 8, 16, 32]) {
        const samples: ApiSample[] = [];
        timer.reset();
        telemetry.reset();
        let peakRss = process.memoryUsage.rss();
        const rssTimer = setInterval(() => {
          peakRss = Math.max(peakRss, process.memoryUsage.rss());
        }, 20);
        try {
          for (let batch = 0; batch < iterations; batch++) {
            const result = await Promise.all(
              Array.from({ length: concurrency }, () =>
                sampleOperation(api!, operation),
              ),
            );
            samples.push(...result);
            peakRss = Math.max(peakRss, process.memoryUsage.rss());
          }
        } finally {
          clearInterval(rssTimer);
        }
        const result = {
          clients: concurrency,
          ...summarizeSamples(samples),
          peakProcessRssMiB: Number((peakRss / 1024 / 1024).toFixed(1)),
          postgres: telemetry.result(),
          databaseQueryCount: timer.count,
          databaseQueryLatencyMsTotal: Number(timer.durationMs.toFixed(2)),
          databaseQueryLatencyMsPerRequestMean: Number(
            (timer.durationMs / samples.length).toFixed(2),
          ),
        };
        concurrencyResults.push(result);
        if (process.env.CODETHREAD_HTTP_BENCH_PROGRESS === '1')
          console.error(
            'HTTP_BENCH',
            JSON.stringify({ operation: operation.name, ...result }),
          );
      }
      warm[operation.name] = concurrencyResults;
    }
  } finally {
    telemetry.close();
    scans.stop();
    if (api) await closeServer(api.server);
    await db.end({ timeout: 5 });
  }
  return {
    coldDefinition:
      'First request on a new API server and database client pool; PostgreSQL operating-system and shared-buffer caches are not flushed.',
    warmDefinition:
      'Requests after one excluded warm-up per endpoint on a persistent API server and database client pool; Pxx uses nearest-rank percentiles.',
    databaseTimeDefinition:
      'Sum of instrumented tagged SQL/unsafe call durations, including client-to-database round trip and pool wait; warm values are reported per batch and as a mean per request.',
    postgresTraceDefinition:
      'postgres.js diagnostics: queryQueueMs is queued-to-sent (including pool, connection and pipeline wait); queryRoundTripMs is sent-to-complete (including server execution, transfer and parsing); transactionLeaseWaitMs is pool lease acquisition wait. Percentiles use nearest rank.',
    requestTimeoutMs: 30_000,
    coldSamplesPerEndpoint: coldSamples,
    warmIterationsPerConcurrency: iterations,
    cold,
    warm,
  };
}

export async function scanViaHttp(
  db: Database,
  scans: ScanService,
  input: {
    repositoryPath: string;
    revision: string;
    idempotencyKey: string;
  },
) {
  const api = await listenApi(db, scans),
    lifecycleStarted = performance.now();
  try {
    const registered = await requestJson<{ id: string }>(
        api,
        '/v1/repositories',
        'POST',
        { locator: input.repositoryPath },
      ),
      accepted = await requestJson<{ id: string }>(
        api,
        `/v1/repositories/${registered.value.id}/scans`,
        'POST',
        { revision: input.revision, idempotencyKey: input.idempotencyKey },
      ),
      queuedAt = performance.now();
    const deadline = Date.now() + 180_000;
    let job: { state: string; [key: string]: unknown } | undefined,
      terminalJobBytes = 0,
      jobPollCount = 0;
    while (Date.now() < deadline) {
      const polled = await requestJson<typeof job>(
        api,
        `/v1/scans/${accepted.value.id}`,
      );
      job = polled.value;
      terminalJobBytes = polled.bytes;
      jobPollCount++;
      if (job && ['succeeded', 'failed', 'cancelled'].includes(job.state))
        break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!job || !['succeeded', 'failed', 'cancelled'].includes(job.state))
      throw new Error(`HTTP benchmark scan timed out: ${accepted.value.id}`);
    const projects = await requestJson<
      { project_id: string; status: string; snapshot_id: string | null }[]
    >(api, `/v1/scans/${accepted.value.id}/projects`);
    return {
      api,
      jobId: accepted.value.id,
      job,
      project: projects.value.find(
        (project) => project.status === 'ready' && project.snapshot_id,
      ),
      registrationAndAcceptanceMs: Number(
        (queuedAt - lifecycleStarted).toFixed(2),
      ),
      scanLifecycleMs: Number((performance.now() - queuedAt).toFixed(2)),
      httpResponses: {
        repositoryRegistrationBytes: registered.bytes,
        scanAcceptanceBytes: accepted.bytes,
        terminalJobBytes,
        jobPollCount,
        projectsBytes: projects.bytes,
      },
    };
  } catch (error) {
    await closeServer(api.server);
    throw error;
  }
}

export async function closeBenchmarkApi(api: { server: Server }) {
  await closeServer(api.server);
}
