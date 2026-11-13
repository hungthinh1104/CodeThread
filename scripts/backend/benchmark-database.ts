import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
    manifest: { path: string; sha256: string }[] = [];
  await mkdir(join(folder, 'src'), { recursive: true });
  for (let index = 0; index < fileCount; index++) {
    const stem = String(index).padStart(5, '0'),
      path = `src/module-${stem}.ts`;
    const source = `export function target_${stem}() { return ${index}; }\nexport function caller_${stem}() { return target_${stem}(); }\n`;
    await writeFile(join(folder, path), source, 'utf8');
    manifest.push({ path, sha256: digest(source) });
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

async function waitForJob(service: ScanService, jobId: string) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const job = await service.job(jobId);
    if (['succeeded', 'failed', 'cancelled'].includes(String(job.state)))
      return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Benchmark scan timed out: ${jobId}`);
}

const url = assertDedicatedLoopbackDatabase(databaseUrl),
  databaseName = decodeURIComponent(url.pathname.slice(1)),
  db = connect(url.toString()),
  temporaryRoot = await mkdtemp(join(tmpdir(), 'codethread-db-benchmark-'));
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

  for (const profile of profiles) {
    phaseSamples = {
      source_acquisition_ms: [],
      analysis_ms: [],
      persistence_ms: [],
    };
    service = new ScanService(db, {
      root: temporaryRoot,
      analyzerBuildHash: digest('codethread-db-benchmark-analyzer-v1'),
      onPhase: (phase, durationMs) =>
        phaseSamples[`${phase}_ms`]!.push(Number(durationMs.toFixed(2))),
    });
    const queryService = new BackendQueryService(db, service);
    const beforeRss = process.memoryUsage().rss,
      repository = await makeRepository(temporaryRoot, profile.files),
      registered = await service.register(repository.folder),
      queued = await service.accept(
        registered.id,
        'HEAD',
        `benchmark-${profile.name}`,
      );
    worker = service.run();
    const job = await waitForJob(service, queued.id);
    service.stop();
    await worker;
    service = new ScanService(db, {
      root: temporaryRoot,
      analyzerBuildHash: digest('codethread-db-benchmark-analyzer-v1'),
    });
    if (job.state !== 'succeeded')
      throw new Error(
        `Benchmark scan ${profile.name} ended ${String(job.state)}: ${String(job.error_code)}`,
      );
    const projects = await service.projects(queued.id),
      project = projects.find(
        (item) => item.status === 'ready' && item.snapshot_id,
      );
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
        queryService.symbols(queued.id, String(project.project_id), {
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
    const investigationStarted = performance.now(),
      investigation = createInvestigation(hydrated!.facts, hydrated!.source, {
        resourceProfile: 'repository',
      }),
      constructionMs = Number(
        (performance.now() - investigationStarted).toFixed(2),
      ),
      rootSymbol = hydrated!.facts.symbols.find(
        (symbol) => symbol.name === 'caller_00000',
      );
    if (!rootSymbol) throw new Error('Generated graph root is missing');
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
    const expectedTarget = hydrated!.facts.symbols.find(
      (symbol) => symbol.name === 'target_00000',
    );
    if (
      !expectedTarget ||
      !graphResult?.symbols.some((symbol) => symbol.id === expectedTarget.id)
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
      sourceBytes = facts.files.reduce(
        (total, file) => total + file.byteLength,
        0,
      );
    runs.push({
      profile: profile.name,
      expectedFiles: profile.files,
      actualFiles: files,
      symbols: facts.symbols.length,
      exactRelations: facts.relations.filter(
        (relation) => relation.resolution.status === 'exact',
      ).length,
      sourceBytes,
      commit: repository.commit,
      datasetChecksum: repository.datasetChecksum,
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
      analyzerBuildHash: digest('codethread-db-benchmark-analyzer-v1'),
    });
  }
  console.log(
    JSON.stringify(
      {
        status: 'measured',
        seed,
        methodology:
          'One deterministic generated TypeScript repository per size; pinned Git commit; production scan worker; 3 full hydration samples; 5 optimized symbol-page and graph-query samples; medians reported; no index added.',
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
