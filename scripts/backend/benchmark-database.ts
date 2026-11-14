import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { cpus, totalmem } from 'node:os';
import { arch, platform, release } from 'node:os';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInvestigation } from '@codethread/trace-engine';
import { parseGraphNeighborsResult } from '@codethread/contracts';
import { connect } from './database.ts';
import { applyMigrations } from './migrations.ts';
import { BackendQueryService } from './query-service.ts';
import { loadSnapshot } from './snapshot-persistence.ts';
import { ScanService } from './service.ts';
import {
  DatabaseQueryTimer,
  benchmarkHttpApi,
  closeBenchmarkApi,
  instrumentDatabase,
  scanViaHttp,
} from './http-benchmark.ts';
import {
  explainLegacySnapshotReads,
  explainSymbolSearch,
} from './symbol-search.ts';

const seed = 'codethread-db-workload-v1';
const profiles = [
  { name: 'small', files: 25 },
  { name: 'medium', files: 250 },
  { name: 'large', files: 900 },
] as const;
const digest = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
const databaseUrl = process.env.CODETHREAD_BENCH_DATABASE_URL;

function assertDedicatedLoopbackDatabase(raw: string | undefined): URL {
  if (!raw) throw new Error('CODETHREAD_BENCH_DATABASE_URL is required');
  const url = new URL(raw),
    database = decodeURIComponent(url.pathname.slice(1));
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '::1'].includes(url.hostname.toLowerCase()) ||
    !/^codethread_bench_[a-z0-9_]+$/.test(database)
  )
    throw new Error(
      'Benchmark requires a dedicated loopback database named codethread_bench_<name>',
    );
  return url;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b),
    middle = Math.floor(sorted.length / 2);
  return Number(
    (sorted.length % 2
      ? sorted[middle]!
      : (sorted[middle - 1]! + sorted[middle]!) / 2
    ).toFixed(2),
  );
}

async function timed<T>(
  run: () => Promise<T>,
): Promise<{ value: T; ms: number }> {
  const started = performance.now(),
    value = await run();
  return { value, ms: Number((performance.now() - started).toFixed(2)) };
}

function summarizePlan(value: unknown) {
  const result = Array.isArray(value) ? value[0] : value;
  if (!result || typeof result !== 'object') return { unavailable: true };
  const record = result as Record<string, unknown>,
    nodes: Record<string, unknown>[] = [];
  function visit(node: unknown): void {
    if (!node || typeof node !== 'object') return;
    const plan = node as Record<string, unknown>;
    nodes.push({
      nodeType: plan['Node Type'],
      relation: plan['Relation Name'],
      index: plan['Index Name'],
      actualRows: plan['Actual Rows'],
      actualTotalTimeMs: plan['Actual Total Time'],
      sharedHitBlocks: plan['Shared Hit Blocks'],
      sharedReadBlocks: plan['Shared Read Blocks'],
      tempReadBlocks: plan['Temp Read Blocks'],
      tempWrittenBlocks: plan['Temp Written Blocks'],
    });
    if (Array.isArray(plan['Plans'])) plan['Plans'].forEach(visit);
  }
  visit(record['Plan']);
  return {
    planningMs: record['Planning Time'],
    executionMs: record['Execution Time'],
    nodes,
  };
}

async function makeRepository(root: string, fileCount: number) {
  const folder = join(root, `repo-${fileCount}`),
    manifest: { path: string; sha256: string; bytes: number }[] = [];
  await mkdir(join(folder, 'src'), { recursive: true });
  for (let index = 0; index < fileCount; index++) {
    const stem = String(index).padStart(5, '0'),
      path = `src/module-${stem}.ts`;
    const source = `export function target_${stem}() { return ${index}; }\nexport function caller_${stem}() { return target_${stem}(); }\n`;
    await writeFile(join(folder, path), source, 'utf8');
    manifest.push({
      path,
      sha256: digest(source),
      bytes: Buffer.byteLength(source),
    });
  }
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
  };
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'core.autocrlf=false', '-C', folder, ...args], {
      encoding: 'utf8',
      env,
    });
  git('-c', 'init.defaultBranch=main', 'init', '-q');
  git(
    '-c',
    'user.name=CodeThread Benchmark',
    '-c',
    'user.email=benchmark@example.invalid',
    'add',
    '--all',
  );
  git(
    '-c',
    'user.name=CodeThread Benchmark',
    '-c',
    'user.email=benchmark@example.invalid',
    'commit',
    '-qm',
    `Synthetic workload ${fileCount}`,
  );
  return {
    folder,
    commit: git('rev-parse', 'HEAD').trim(),
    datasetChecksum: digest(JSON.stringify(manifest)),
    manifest,
  };
}

async function makePinnedHonoRepository(root: string) {
  const setPath = join(
      process.cwd(),
      'docs',
      'evaluation',
      'ct-realworld-001',
      'repositories.json',
    ),
    setBytes = await readFile(setPath),
    set = JSON.parse(setBytes.toString('utf8')) as {
      externalRepositories: {
        key: string;
        commit: string;
        tree: string;
        inventory: { regularTsFiles: number; regularTsBytes: number };
        sourceFiles: {
          path: string;
          gitBlobSha1: string;
          bytes: number;
          sha256: string;
        }[];
      }[];
    },
    pin = set.externalRepositories.find(
      (repository) => repository.key === 'hono',
    );
  if (!pin || !/^[0-9a-f]{40}$/.test(pin.commit) || pin.sourceFiles.length < 1)
    throw new Error('Pinned Hono benchmark manifest is invalid');
  const sourceRoots = [
      process.env.CODETHREAD_BENCH_REALWORLD_REPOSITORY,
      process.env.CT_REALWORLD_SOURCE_ROOT
        ? join(process.env.CT_REALWORLD_SOURCE_ROOT, 'hono')
        : undefined,
      join(process.cwd(), '.tooling', 'ct-realworld-sources', 'hono'),
      join(process.cwd(), '..', 'ct-realworld-sources', 'hono'),
    ].filter((path): path is string => Boolean(path)),
    sourceRoot = sourceRoots.find(existsSync);
  if (!sourceRoot)
    throw new Error(
      'Pinned Hono Git source is missing; set CODETHREAD_BENCH_REALWORLD_REPOSITORY',
    );
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'core.autocrlf=false', '-C', sourceRoot, ...args],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        },
      },
    ).trim();
  if (
    git('rev-parse', '--verify', `${pin.commit}^{commit}`) !== pin.commit ||
    git('rev-parse', `${pin.commit}^{tree}`) !== pin.tree
  )
    throw new Error('Local Hono Git source does not contain the pinned tree');
  const blobs = execFileSync(
    'git',
    ['-c', 'core.autocrlf=false', '-C', sourceRoot, 'cat-file', '--batch'],
    {
      input: pin.sourceFiles.map((file) => file.gitBlobSha1).join('\n') + '\n',
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      },
    },
  );
  let offset = 0;
  for (const file of pin.sourceFiles) {
    const newline = blobs.indexOf(10, offset),
      [oid, type, rawSize] = blobs
        .toString('ascii', offset, newline)
        .split(' '),
      size = Number(rawSize),
      contentStart = newline + 1,
      content = blobs.subarray(contentStart, contentStart + size);
    if (
      oid !== file.gitBlobSha1 ||
      type !== 'blob' ||
      size !== file.bytes ||
      digest(content) !== file.sha256
    )
      throw new Error(`Pinned Hono source hash mismatch: ${file.path}`);
    offset = contentStart + size + 1;
  }
  if (
    pin.sourceFiles.length !== pin.inventory.regularTsFiles ||
    pin.sourceFiles.reduce((total, file) => total + file.bytes, 0) !==
      pin.inventory.regularTsBytes
  )
    throw new Error('Pinned Hono source inventory differs from its manifest');
  const folder = join(root, 'repo-pinned-hono');
  execFileSync(
    'git',
    ['clone', '--shared', '--no-checkout', '--no-tags', sourceRoot, folder],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      },
    },
  );
  const clonedCommit = execFileSync(
    'git',
    ['-C', folder, 'rev-parse', '--verify', `${pin.commit}^{commit}`],
    { encoding: 'utf8' },
  ).trim();
  if (clonedCommit !== pin.commit)
    throw new Error('Pinned Hono commit was not preserved in benchmark clone');
  const sourceManifest = [...pin.sourceFiles]
      .sort((left, right) =>
        Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
      )
      .map(({ path, sha256 }) => ({ path, sha256 })),
    datasetChecksum = digest(JSON.stringify(sourceManifest));
  return {
    folder,
    commit: pin.commit,
    expectedFiles: pin.inventory.regularTsFiles,
    expectedBytes: pin.inventory.regularTsBytes,
    datasetChecksum,
    repositorySetChecksum: digest(setBytes),
  };
}

const url = assertDedicatedLoopbackDatabase(databaseUrl),
  databaseName = decodeURIComponent(url.pathname.slice(1)),
  databaseTimer = new DatabaseQueryTimer(),
  db = instrumentDatabase(connect(url.toString()), databaseTimer),
  temporaryRoot = await mkdtemp(join(tmpdir(), 'codethread-db-benchmark-'));
type BenchmarkRepository = {
  folder: string;
  commit: string;
  datasetChecksum: string;
  manifest?: { path: string; sha256: string; bytes: number }[];
  expectedBytes?: number;
  repositorySetChecksum?: string;
};
let service: ScanService | undefined,
  worker: Promise<void> | undefined,
  peakRss = process.memoryUsage().rss;
const rssTimer = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 100);

try {
  const existing = await db`SELECT to_regnamespace('codethread') AS schema`;
  if (existing[0]?.schema)
    throw new Error(
      'Benchmark database must be empty; refusing to reuse or mutate it',
    );
  await applyMigrations(db);
  const server = await db`SELECT version() AS version`;
  const packageMetadata = JSON.parse(
    await readFile(join(process.cwd(), 'package.json'), 'utf8'),
  ) as {
    packageManager?: string;
    devDependencies?: Record<string, string>;
  };
  let phaseSamples: Record<string, number[]>;
  const runs: Record<string, unknown>[] = [];
  const workloads: {
    name: string;
    expectedFiles: number;
    build: () => Promise<BenchmarkRepository>;
  }[] = profiles.map((profile) => ({
    name: profile.name,
    expectedFiles: profile.files,
    build: () => makeRepository(temporaryRoot, profile.files),
  }));
  const pinnedHono = await makePinnedHonoRepository(temporaryRoot);
  workloads.push({
    name: 'pinned-hono',
    expectedFiles: pinnedHono.expectedFiles,
    build: async () => pinnedHono,
  });
  const analyzerBuildHash = digest('codethread-db-benchmark-analyzer-v1');

  for (const profile of workloads) {
    phaseSamples = {
      source_acquisition_ms: [],
      analysis_ms: [],
      persistence_ms: [],
    };
    service = new ScanService(db, {
      root: temporaryRoot,
      analyzerBuildHash,
      onPhase: (phase, durationMs) =>
        phaseSamples[`${phase}_ms`]!.push(Number(durationMs.toFixed(2))),
    });
    const beforeRss = process.memoryUsage().rss,
      repository = await profile.build();
    worker = service.run();
    databaseTimer.reset();
    const scanned = await scanViaHttp(db, service, {
      repositoryPath: repository.folder,
      revision: profile.name === 'pinned-hono' ? repository.commit : 'HEAD',
      idempotencyKey: `benchmark-${profile.name}`,
    });
    const job = scanned.job;
    service.stop();
    await worker;
    const scanDatabaseQueries = databaseTimer.count,
      scanDatabaseQueryLatencyMs = Number(databaseTimer.durationMs.toFixed(2));
    await closeBenchmarkApi(scanned.api);
    service = new ScanService(db, {
      root: temporaryRoot,
      analyzerBuildHash,
    });
    if (job.state !== 'succeeded')
      throw new Error(
        `Benchmark scan ${profile.name} ended ${String(job.state)}: ${String(job.error_code)}`,
      );
    const queryService = new BackendQueryService(db, service),
      projects = await service.projects(scanned.jobId),
      project =
        scanned.project ??
        projects.find((item) => item.status === 'ready' && item.snapshot_id);
    if (!project?.snapshot_id)
      throw new Error(
        `Benchmark scan ${profile.name} produced no ready project`,
      );
    const snapshotId = String(project.snapshot_id),
      hydrationSamples: number[] = [],
      legacySearchSamples: number[] = [];
    let hydrated: Awaited<ReturnType<typeof loadSnapshot>> | undefined,
      legacyItems: unknown[] = [];
    for (let repetition = 0; repetition < 3; repetition++) {
      const hydration = await timed(() => loadSnapshot(db, snapshotId));
      hydrationSamples.push(hydration.ms);
      hydrated = hydration.value;
      const legacyStarted = performance.now();
      legacyItems = hydrated.facts.symbols
        .filter(
          (symbol) =>
            symbol.name.toLowerCase().includes('') ||
            symbol.filePath.toLowerCase().includes(''),
        )
        .slice(0, 50);
      legacySearchSamples.push(
        Number((performance.now() - legacyStarted + hydration.ms).toFixed(2)),
      );
    }
    const optimizedSamples: number[] = [];
    let optimizedItems: unknown[] = [];
    for (let repetition = 0; repetition < 5; repetition++) {
      const query = await timed(() =>
        queryService.symbols(scanned.jobId, String(project.project_id), {
          query: '',
          offset: 0,
          limit: 50,
        }),
      );
      optimizedSamples.push(query.ms);
      optimizedItems = query.value.items;
    }
    if (!isDeepStrictEqual(legacyItems, optimizedItems))
      throw new Error(
        `Optimized symbol page differs from the legacy projection at ${profile.name}`,
      );
    const symbolById = new Map(
        hydrated!.facts.symbols.map((symbol) => [symbol.id, symbol]),
      ),
      exactCall = hydrated!.facts.relations.find(
        (relation) =>
          relation.kind === 'calls' && relation.resolution.status === 'exact',
      ),
      rootSymbol = exactCall
        ? symbolById.get(exactCall.sourceSymbolId)
        : hydrated!.facts.symbols[0],
      expectedTarget =
        exactCall?.resolution.status === 'exact'
          ? symbolById.get(exactCall.resolution.targetId)
          : undefined,
      investigationStarted = performance.now(),
      investigation = createInvestigation(hydrated!.facts, hydrated!.source, {
        resourceProfile: 'repository',
      }),
      constructionMs = Number(
        (performance.now() - investigationStarted).toFixed(2),
      );
    if (!rootSymbol) throw new Error('Benchmark project has no symbols');
    const graphRequest = {
      snapshotId,
      symbolId: rootSymbol.id,
      depth: 1,
      nodeLimit: 50,
    };
    let graphResult;
    const graphSamples: number[] = [];
    for (let repetition = 0; repetition < 5; repetition++) {
      const query = await timed(async () =>
        investigation.neighbors(graphRequest),
      );
      graphSamples.push(query.ms);
      graphResult = parseGraphNeighborsResult(graphRequest, query.value);
    }
    if (
      profile.name !== 'pinned-hono' &&
      (!expectedTarget ||
        !graphResult?.symbols.some((symbol) => symbol.id === expectedTarget.id))
    )
      throw new Error(
        'Generated exact call target is missing from the graph query',
      );
    const [legacyPlans, optimizedPlan] = await Promise.all([
      explainLegacySnapshotReads(db, snapshotId),
      explainSymbolSearch(db, snapshotId, '', 0, 50),
    ]);
    const facts = hydrated!.facts,
      files = facts.files.length,
      snapshotSourceBytes = facts.files.reduce(
        (total, file) => total + file.byteLength,
        0,
      ),
      inputSummary =
        await db`SELECT count(*) FILTER (WHERE i.input_kind='source')::integer AS source_files,
        COALESCE(sum(o.byte_length) FILTER (WHERE i.input_kind='source'),0)::integer AS source_bytes
        FROM codethread.scan_input_file i JOIN codethread.source_object o
          ON o.sha256=i.content_hash WHERE i.scan_job_id=${scanned.jobId}`,
      actualSourceFiles = Number(inputSummary[0]?.source_files ?? 0),
      actualSourceBytes = Number(inputSummary[0]?.source_bytes ?? 0);
    if (actualSourceFiles !== profile.expectedFiles)
      throw new Error(
        `Source inventory mismatch for ${profile.name}: expected ${profile.expectedFiles}, got ${actualSourceFiles}`,
      );
    const httpApi = await benchmarkHttpApi({
      databaseUrl: url.toString(),
      root: temporaryRoot,
      analyzerBuildHash,
      scanId: scanned.jobId,
      projectId: String(project.project_id),
      snapshotId,
      facts,
      coldSamples: Number(process.env.CODETHREAD_HTTP_BENCH_COLD_SAMPLES ?? 10),
      iterations: Number(process.env.CODETHREAD_HTTP_BENCH_ITERATIONS ?? 20),
    });
    runs.push({
      profile: profile.name,
      workloadKind:
        profile.name === 'pinned-hono' ? 'pinned-realworld' : 'synthetic',
      expectedSourceFiles: profile.expectedFiles,
      actualSourceFiles,
      expectedSourceBytes:
        repository.expectedBytes ??
        repository.manifest?.reduce((total, file) => total + file.bytes, 0),
      actualSourceBytes,
      snapshotContextFiles: files,
      symbols: facts.symbols.length,
      exactRelations: facts.relations.filter(
        (relation) => relation.resolution.status === 'exact',
      ).length,
      snapshotSourceBytes,
      commit: repository.commit,
      datasetChecksum: repository.datasetChecksum,
      repositorySetChecksum: repository.repositorySetChecksum,
      registrationAndAcceptanceMs: scanned.registrationAndAcceptanceMs,
      scanLifecycleMs: scanned.scanLifecycleMs,
      scanHttpResponseBytes: scanned.httpResponses,
      scanDatabaseQueries,
      scanDatabaseQueryLatencyMs,
      phaseMedianMs: Object.fromEntries(
        Object.entries(phaseSamples).map(([phase, samples]) => [
          phase,
          median(samples),
        ]),
      ),
      hydrationMedianMs: median(hydrationSamples),
      legacySymbolSearchMedianMs: median(legacySearchSamples),
      optimizedSymbolSearchMedianMs: median(optimizedSamples),
      optimizedSymbolSearchSamplesMs: optimizedSamples,
      investigationConstructionMs: constructionMs,
      graphQueryMedianMs: median(graphSamples),
      httpApi: httpApi,
      rssBeforeMiB: Number((beforeRss / 1024 / 1024).toFixed(1)),
      rssAfterMiB: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1)),
      queryPlans: {
        before: {
          facts: summarizePlan(legacyPlans.facts),
          sources: summarizePlan(legacyPlans.sources),
        },
        after: summarizePlan(optimizedPlan),
      },
    });
    service.stop();
    service = new ScanService(db, {
      root: temporaryRoot,
      analyzerBuildHash,
    });
  }
  console.log(
    JSON.stringify(
      {
        status: 'measured',
        seed,
        methodology:
          'Deterministic 25/250/900-file TypeScript repositories plus Hono at the frozen CT-REALWORLD-001 commit; scan lifecycle through the actual loopback HTTP API and production worker; 3 verified full-hydration samples; actual HTTP symbols/neighbors/paths/evidence at concurrency 1/2/4; 10 fresh-server cold samples and 20 warm iterations per concurrency by default; database query time is summed client SQL round-trip latency; no analyzed-repository scripts or dependencies executed; no index added.',
        command: 'pnpm backend:bench',
        database: { name: databaseName, version: server[0]?.version },
        host: {
          platform: `${platform()} ${release()}`,
          architecture: arch(),
          cpu: cpus()[0]?.model,
          logicalCpus: cpus().length,
          totalMemoryMiB: Number((totalmem() / 1024 / 1024).toFixed(1)),
          node: process.version,
          pnpm:
            packageMetadata.packageManager?.replace(/^pnpm@/, '') ?? 'unknown',
          typescript: packageMetadata.devDependencies?.typescript,
        },
        peakRssMiB: Number((peakRss / 1024 / 1024).toFixed(1)),
        runs,
      },
      null,
      2,
    ),
  );
} finally {
  clearInterval(rssTimer);
  service?.stop();
  if (worker) await worker;
  await db.end({ timeout: 5 });
  await rm(temporaryRoot, { recursive: true, force: true });
}
