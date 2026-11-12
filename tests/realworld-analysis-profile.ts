import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { analyzeGitRepository } from '../scripts/investigation/repository-session.ts';

type Repository = {
  key: string;
  commit: string;
  inventory: { regularTsFiles: number; regularTsBytes: number };
};

function gitCommit(repositoryPath: string, revision: string): string {
  return execFileSync(
    'git',
    ['-C', repositoryPath, 'rev-parse', '--verify', `${revision}^{commit}`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function main(): Promise<void> {
  const repositoriesBytes = await readFile(
    'docs/evaluation/ct-realworld-001/repositories.json',
  );
  const manifest = JSON.parse(repositoriesBytes.toString('utf8')) as {
    externalRepositories: Repository[];
  };
  const requested = process.env.CT_REALWORLD_REPOSITORIES?.split(',')
    .map((key) => key.trim())
    .filter(Boolean);
  const repositories = requested
    ? manifest.externalRepositories.filter((item) =>
        requested.includes(item.key),
      )
    : manifest.externalRepositories;
  assert.ok(repositories.length > 0, 'select at least one known repository');
  assert.deepEqual(
    repositories.map((item) => item.key).sort(),
    [...(requested ?? repositories.map((item) => item.key))].sort(),
    'every requested repository key must be known',
  );
  const sourceRoot = resolve(
    process.env.CT_REALWORLD_SOURCE_ROOT ??
      resolve(process.cwd(), '..', 'ct-realworld-sources'),
  );
  const runs = [] as unknown[];
  for (const repository of repositories) {
    const repositoryPath = resolve(sourceRoot, repository.key);
    assert.equal(
      gitCommit(repositoryPath, repository.commit),
      repository.commit,
    );
    const startedAt = new Date().toISOString();
    const session = await analyzeGitRepository({
      repositoryPath,
      repositoryId: randomUUID(),
      revision: repository.commit,
    });
    const projects = session.projects.map((item) => {
      const facts = item.snapshot?.facts;
      const statuses = facts?.observations.reduce<Record<string, number>>(
        (counts, observation) => {
          counts[observation.status] = (counts[observation.status] ?? 0) + 1;
          return counts;
        },
        {},
      );
      return {
        configPath: item.project.configPath,
        status: item.status,
        errorMessage: item.error?.message ?? null,
        rootFiles: item.project.rootPaths.length,
        contextDiagnostics: item.project.diagnostics.map(
          (diagnostic) => diagnostic.code,
        ),
        error: item.error?.code,
        files: facts?.files.length ?? 0,
        sourceBytes:
          facts?.files.reduce((total, file) => total + file.byteLength, 0) ?? 0,
        declarations: facts?.symbols.length ?? 0,
        relationRecords: facts?.relations.length ?? 0,
        evidenceRecords: facts?.evidenceRefs.length ?? 0,
        observations: facts?.observations.length ?? 0,
        observationStatuses: statuses ?? {},
        ownerUnavailable:
          facts?.observations.filter(
            (observation) => observation.ownerId === null,
          ).length ?? 0,
        eligibleObservations:
          facts?.observations.filter((observation) => observation.eligible)
            .length ?? 0,
        counts: facts?.counts,
        contextDiagnosticCodes:
          item.snapshot?.contextDiagnostics?.map(
            (diagnostic) => diagnostic.code,
          ) ?? [],
        execution: item.snapshot?.execution ?? null,
      };
    });
    const contextObservationMemberships = projects.reduce(
      (total, project) =>
        total + (project as { observations: number }).observations,
      0,
    );
    const statuses = projects.flatMap((project) =>
      Object.entries(
        (project as { observationStatuses: Record<string, number> })
          .observationStatuses,
      ),
    );
    const aggregateStatuses = statuses.reduce<Record<string, number>>(
      (counts, [status, count]) => {
        counts[status] = (counts[status] ?? 0) + count;
        return counts;
      },
      {},
    );
    runs.push({
      key: repository.key,
      commit: session.commitId,
      manifestFiles: repository.inventory.regularTsFiles,
      manifestSourceBytes: repository.inventory.regularTsBytes,
      inventoryFiles: session.files.length,
      inventorySourceBytes: session.inventory.sourceBytes,
      inventoryComplete: session.inventory.complete,
      sourceCoverageComplete: session.sourceCoverageComplete,
      analysisComplete: session.analysisComplete,
      contextComplete: session.contextComplete,
      projectCount: session.projects.length,
      readyProjects: session.projects.filter((item) => item.status === 'ready')
        .length,
      failedProjects: session.projects.filter(
        (item) => item.status === 'failed',
      ).length,
      notAnalyzedFiles: session.files.filter(
        (file) => file.status !== 'analyzed',
      ).length,
      notAnalyzedFileDetails: session.files
        .filter((file) => file.status !== 'analyzed')
        .map((file) => ({
          path: file.path,
          status: file.status,
          analysisReason: file.analysisReason ?? null,
          projectIds: [...file.projectIds],
        })),
      contextObservationMemberships,
      observationStatusesByContext: aggregateStatuses,
      startedAt,
      finishedAt: new Date().toISOString(),
      metrics: session.metrics,
      maxWorkerPeakRssBytes: Math.max(
        0,
        ...projects.map(
          (project) =>
            (project as { execution: { workerPeakRssBytes?: number } | null })
              .execution?.workerPeakRssBytes ?? 0,
        ),
      ),
      projects,
    });
  }
  const testedHeadSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const workingTreeStatus = execFileSync('git', ['status', '--short'], {
    encoding: 'utf8',
  })
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  const output = {
    format: 'codethread-ct-realworld-001-analysis-profile-v1',
    testedHeadSha,
    workingTreeClean: workingTreeStatus.length === 0,
    workingTreeStatus,
    repositoryManifestSha256: hash(repositoriesBytes),
    scopeRepositories: repositories.map((item) => item.key),
    sourceAccess: 'pinned Git commit objects only',
    noExternalScriptsOrDependenciesExecuted: true,
    observationCountDefinition:
      'Sum of AnalysisFacts.observations per analyzed project context; a file present in multiple project contexts is counted once per context.',
    runs,
  };
  const serialized = JSON.stringify(output, null, 2) + '\n';
  if (process.env.CT_REALWORLD_OUTPUT_PATH) {
    await writeFile(
      resolve(process.env.CT_REALWORLD_OUTPUT_PATH),
      serialized,
      'utf8',
    );
  }
  if (process.env.CT_REALWORLD_QUIET !== '1') process.stdout.write(serialized);
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
