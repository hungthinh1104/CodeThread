import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import ts from 'typescript';
import { analyzeGitRepository } from './investigation/repository-session.ts';
import { createRepositoryViewer } from './viewer.ts';
import { resolveGitExecutable } from './git-source/process.ts';

const FILES = 1000;
const SOURCE_BYTES = 32 * 1024 * 1024;
const repositoryId = '00000000-0000-4000-8000-000000000080';
const parent = resolve(tmpdir());
const repositoryPath = await mkdtemp(resolve(parent, 'codethread-profile-'));
let gitExecutable = '';
const environment = { ...process.env };
for (const key of Object.keys(environment))
  if (key.startsWith('GIT_')) delete environment[key];
environment['GIT_CONFIG_NOSYSTEM'] = '1';
environment['GIT_CONFIG_GLOBAL'] =
  process.platform === 'win32' ? 'NUL' : '/dev/null';
environment['GIT_TERMINAL_PROMPT'] = '0';

function git(args: readonly string[]): string {
  return execFileSync(gitExecutable, [...args], {
    cwd: repositoryPath,
    env: environment,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60000,
    maxBuffer: 1024 * 1024,
  });
}

function source(index: number, byteLength: number): string {
  const number = String(index).padStart(4, '0');
  const header =
    index === 0
      ? "import { target } from './entry-0001.js';\nexport function entry0000() { return target(); }\n"
      : index === 1
        ? 'export function target() { return 1; }\n'
        : `export function entry${number}() { return ${index}; }\n`;
  const paddingLength = byteLength - Buffer.byteLength(header) - 3;
  if (paddingLength < 0) throw new Error('Benchmark source padding underflow');
  return header + '//' + 'x'.repeat(paddingLength) + '\n';
}

interface QueryValue {
  mode?: string;
  total?: number;
  items?: { status?: string }[];
  result?: {
    total?: number;
    snapshotId?: string;
    graph?: { relations?: unknown[] };
    items?: { status?: string }[];
  };
  requiresChoice?: boolean;
}

async function cleanupRepository(): Promise<void> {
  const absolute = resolve(repositoryPath);
  if (
    !absolute.startsWith(parent + sep) ||
    !basename(absolute).startsWith('codethread-profile-')
  )
    throw new Error('Invalid benchmark cleanup boundary');
  await rm(absolute, { recursive: true, force: true });
}

async function post(
  viewer: Awaited<ReturnType<typeof createRepositoryViewer>>,
  path: string,
  body: unknown,
) {
  const started = performance.now();
  const response = await fetch(viewer.origin + path, {
    method: 'POST',
    headers: {
      origin: viewer.origin,
      'x-codethread-token': new URL(viewer.url).hash.slice(1),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(`${path} failed with HTTP ${response.status}: ${text}`);
  return {
    durationMs: performance.now() - started,
    responseBytes: Buffer.byteLength(text),
    value: JSON.parse(text) as QueryValue,
  };
}

let viewer: Awaited<ReturnType<typeof createRepositoryViewer>> | undefined;
try {
  gitExecutable = await resolveGitExecutable(repositoryPath);
  const setupStarted = performance.now();
  git(['init', '--quiet', '--object-format=sha1']);
  const total = SOURCE_BYTES;
  const base = Math.floor(total / FILES),
    remainder = total % FILES;
  for (let index = 0; index < FILES; index++) {
    const relative = `src/entry-${String(index).padStart(4, '0')}.ts`;
    const path = resolve(repositoryPath, ...relative.split('/'));
    const length = base + (index < remainder ? 1 : 0);
    const text = source(index, length);
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length !== length)
      throw new Error(
        'Benchmark source did not meet its exact byte allocation',
      );
    await mkdir(resolve(path, '..'), { recursive: true });
    await writeFile(path, bytes);
  }
  await writeFile(
    resolve(repositoryPath, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2023',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        types: [],
        strict: true,
      },
      include: ['src/**/*.ts'],
    }),
  );
  await writeFile(resolve(repositoryPath, 'package.json'), '{"type":"module"}');
  git(['add', '--', '.']);
  git([
    '-c',
    'user.name=CodeThread Benchmark',
    '-c',
    'user.email=benchmark@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'bounded repository profile benchmark',
  ]);
  const revision = git(['rev-parse', '--verify', 'HEAD^{commit}']).trim();
  const setupMs = performance.now() - setupStarted;
  const session = await analyzeGitRepository({
    repositoryPath,
    repositoryId,
    revision,
  });
  if (
    session.commitId !== revision ||
    !session.inventory.complete ||
    session.files.length !== FILES ||
    session.inventory.sourceBytes !== SOURCE_BYTES ||
    !session.sourceCoverageComplete ||
    !session.analysisComplete ||
    !session.contextComplete
  )
    throw new Error('Repository profile benchmark did not complete its inputs');
  const project = session.projects.find(
    (item) => item.project.configPath === 'tsconfig.json',
  );
  if (!project?.snapshot)
    throw new Error('Benchmark project snapshot is missing');
  const snapshot = project.snapshot,
    root = snapshot.facts.symbols.find((symbol) => symbol.name === 'entry0000'),
    target = snapshot.facts.symbols.find((symbol) => symbol.name === 'target');
  if (!root || !target) throw new Error('Benchmark graph symbols are missing');
  const relation = snapshot.facts.relations.find(
    (item) =>
      item.sourceSymbolId === root.id &&
      item.kind === 'calls' &&
      item.resolution.status === 'exact' &&
      item.resolution.targetId === target.id,
  );
  if (!relation)
    throw new Error('Benchmark direct call did not resolve exactly');

  viewer = await createRepositoryViewer(session);
  const projectQuery = await post(viewer, '/api/projects', {}),
    fileQuery = await post(viewer, '/api/files', { offset: 0 }),
    catalogQuery = await post(viewer, '/api/catalog', {
      query: 'entry0000',
      offset: 0,
    }),
    sessionQuery = await post(viewer, '/api/session', {
      projectId: project.project.id,
      request: {},
    }),
    symbolQuery = await post(viewer, '/api/symbols', {
      projectId: project.project.id,
      request: { query: 'entry0000', offset: 0 },
    }),
    graphQuery = await post(viewer, '/api/neighbors', {
      projectId: project.project.id,
      request: {
        snapshotId: snapshot.facts.snapshotId,
        symbolId: root.id,
        depth: 1,
        nodeLimit: 20,
        direction: 'outgoing',
        relationKinds: ['calls'],
      },
    }),
    evidenceQuery = await post(viewer, '/api/evidence', {
      projectId: project.project.id,
      request: {
        snapshotId: snapshot.facts.snapshotId,
        evidenceIds: [relation.siteEvidenceId],
      },
    }),
    followQuery = await post(viewer, '/api/follow-context', {
      projectId: project.project.id,
      request: { snapshotId: snapshot.facts.snapshotId, symbolId: target.id },
    });
  if (
    projectQuery.value.mode !== 'repository' ||
    fileQuery.value.total !== FILES ||
    (catalogQuery.value.total ?? 0) < 1 ||
    sessionQuery.value.result?.snapshotId !== snapshot.facts.snapshotId ||
    symbolQuery.value.result?.total !== 1 ||
    graphQuery.value.result?.graph?.relations?.length !== 1 ||
    evidenceQuery.value.result?.items?.[0]?.status !== 'available' ||
    followQuery.value.requiresChoice !== false
  )
    throw new Error(
      'Repository profile query smoke returned incomplete results: ' +
        JSON.stringify({
          mode: projectQuery.value.mode,
          fileTotal: fileQuery.value.total,
          catalogTotal: catalogQuery.value.total,
          sessionSnapshot: sessionQuery.value.result?.snapshotId,
          symbolTotal: symbolQuery.value.result?.total,
          graphRelations: graphQuery.value.result?.graph?.relations?.length,
          evidenceStatus: evidenceQuery.value.result?.items?.[0]?.status,
          followRequiresChoice: followQuery.value.requiresChoice,
        }),
    );
  process.stdout.write(
    JSON.stringify({
      kind: 'repository_profile_benchmark',
      testedRevision: revision,
      node: process.version,
      typescript: ts.version,
      workload: {
        sourceFiles: session.files.length,
        sourceBytes: session.inventory.sourceBytes,
        contexts: session.projects.length,
        contextsFinished: session.analysisComplete,
        sourceCoverageComplete: session.sourceCoverageComplete,
        compilerContextComplete: session.contextComplete,
        maximumFileBytes: Math.max(
          ...session.files.map((file) => file.byteLength),
        ),
      },
      timingMs: {
        fixtureSetup: setupMs,
        acquisition: session.metrics.acquisitionMs,
        analysisAndValidation:
          session.metrics.totalMs - session.metrics.acquisitionMs,
        totalSession: session.metrics.totalMs,
        inputPreparation: snapshot.execution?.inputPreparationMs,
        worker: snapshot.execution?.workerElapsedMs,
        compiler: snapshot.execution?.compilerMs,
        extraction: snapshot.execution?.extractionMs,
        factValidation: snapshot.execution?.factValidationMs,
        queries: {
          projects: projectQuery.durationMs,
          files: fileQuery.durationMs,
          globalSymbols: catalogQuery.durationMs,
          contextSession: sessionQuery.durationMs,
          projectSymbols: symbolQuery.durationMs,
          graph: graphQuery.durationMs,
          evidence: evidenceQuery.durationMs,
          follow: followQuery.durationMs,
        },
      },
      git: session.metrics.git,
      parentPeakRssBytes: session.metrics.parentPeakRssBytes,
      workerPeakRssBytes: snapshot.execution?.workerPeakRssBytes,
      facts: snapshot.facts.counts,
      queryResponseBytes: {
        projects: projectQuery.responseBytes,
        files: fileQuery.responseBytes,
        globalSymbols: catalogQuery.responseBytes,
        contextSession: sessionQuery.responseBytes,
        projectSymbols: symbolQuery.responseBytes,
        graph: graphQuery.responseBytes,
        evidence: evidenceQuery.responseBytes,
        follow: followQuery.responseBytes,
      },
      status: 'PASS',
    }) + '\n',
  );
} finally {
  await viewer?.close();
  await cleanupRepository();
}
