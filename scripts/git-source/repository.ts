import { idSchema } from '@codethread/code-model';
import { performance } from 'node:perf_hooks';
import {
  assertRepositoryLayout,
  resolveGitExecutable,
  runGit,
  outputText,
} from './process.ts';
import type { GitProcessResult } from './process.ts';
import { createObjectReader } from './objects.ts';
import type { GitOperationCounts, GitRun } from './objects.ts';
import { failure, gitFailure } from './selection.ts';
import {
  GitSourceError,
  GIT_DEADLINE_MS,
  MAX_METADATA_BYTES,
  MAX_OBJECT_BYTES,
} from './types.ts';
import type { GitSelectionStatus, GitSourceRequest } from './types.ts';

type RepositoryRequest = Pick<
  GitSourceRequest,
  'repositoryPath' | 'repositoryId' | 'revision' | 'signal'
>;
interface StageLimits {
  deadlineMs: number;
  metadataBytes: number;
  objectBytes: number;
}
const defaultStageLimits: StageLimits = {
  deadlineMs: GIT_DEADLINE_MS,
  metadataBytes: MAX_METADATA_BYTES,
  objectBytes: MAX_OBJECT_BYTES,
};

function runner(
  layout: { root: string; gitDirectory: string },
  executable: string,
  deadlineAt: number,
  signal: AbortSignal | undefined,
  selection: readonly GitSelectionStatus[],
  counts: GitOperationCounts,
) {
  const checkpoint = () => {
    if (signal?.aborted)
      throw failure(
        'CANCELLED',
        'Git source acquisition cancelled.',
        selection,
      );
    if (performance.now() >= deadlineAt)
      throw failure(
        'GIT_TIMEOUT',
        'Git source acquisition timed out.',
        selection,
      );
  };
  const run: GitRun = async (args, maxOutput = 64 * 1024, input) => {
    checkpoint();
    counts.subprocesses++;
    try {
      return await runGit(
        executable,
        layout.gitDirectory,
        layout.root,
        args,
        deadlineAt,
        signal,
        maxOutput,
        input,
      );
    } catch (error) {
      gitFailure(error, selection);
    }
  };
  return { run, checkpoint };
}

async function resolveCommit(
  run: GitRun,
  revision: string,
  width: number,
  selection: readonly GitSelectionStatus[],
): Promise<string> {
  if (
    typeof revision !== 'string' ||
    !(
      revision === 'HEAD' ||
      new RegExp(`^[0-9a-f]{${width}}$`).test(revision) ||
      /^(?:refs\/heads|refs\/tags)\//.test(revision)
    )
  )
    throw failure(
      'INVALID_REVISION',
      'Use a full commit ID, HEAD, or fully qualified local branch or tag ref.',
      selection,
    );
  if (revision.startsWith('refs/')) {
    let checked: GitProcessResult;
    try {
      checked = await run(['check-ref-format', revision], 32);
    } catch (error) {
      if (
        error instanceof GitSourceError &&
        [
          'CANCELLED',
          'GIT_TIMEOUT',
          'GIT_UNAVAILABLE',
          'RESOURCE_LIMIT',
        ].includes(error.code)
      )
        throw error;
      throw failure(
        'INVALID_REVISION',
        'The selected ref name is invalid.',
        selection,
      );
    }
    if (checked.stdout.length !== 0)
      throw failure(
        'INVALID_REVISION',
        'The selected ref name is invalid.',
        selection,
      );
  }
  let resolved: string;
  try {
    resolved = outputText(
      await run(
        ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`],
        128,
      ),
    );
  } catch (error) {
    if (
      error instanceof GitSourceError &&
      error.code !== 'GIT_FAILED' &&
      error.code !== 'MISSING_OBJECT'
    )
      throw error;
    throw failure(
      'INVALID_REVISION',
      'The selected revision does not resolve to a local commit.',
      selection,
    );
  }
  if (
    !new RegExp(`^[0-9a-f]{${width}}$`).test(resolved) ||
    (/^[0-9a-f]+$/.test(revision) && revision !== resolved)
  )
    throw failure(
      'INVALID_REVISION',
      'The selected revision is not a complete commit ID.',
      selection,
    );
  return resolved;
}

function rootTree(
  commit: Buffer,
  width: number,
  selection: readonly GitSelectionStatus[],
): string {
  const headerEnd = commit.indexOf(Buffer.from('\n\n'));
  const headers = commit
    .subarray(0, headerEnd < 0 ? commit.length : headerEnd)
    .toString('latin1');
  const treeLines = headers
    .split('\n')
    .filter((line) => line.startsWith('tree '));
  if (headerEnd < 0 || treeLines.length !== 1)
    throw failure(
      'CORRUPT_OBJECT',
      'The selected commit has no unique root tree.',
      selection,
    );
  const oid = treeLines[0]!.slice(5);
  if (!new RegExp(`^[0-9a-f]{${width}}$`).test(oid))
    throw failure(
      'CORRUPT_OBJECT',
      'The selected commit tree ID is malformed.',
      selection,
    );
  return oid;
}

export async function openRepository(
  request: RepositoryRequest,
  selection: readonly GitSelectionStatus[] = [],
  limits: StageLimits = defaultStageLimits,
) {
  request = {
    repositoryPath: request.repositoryPath,
    repositoryId: request.repositoryId,
    revision: request.revision,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  };
  const started = performance.now();
  if (request.signal?.aborted)
    throw failure('CANCELLED', 'Git source acquisition cancelled.', selection);
  const repositoryId = idSchema.safeParse(request.repositoryId);
  if (!repositoryId.success)
    throw failure(
      'INVALID_REPOSITORY_ID',
      'A caller-supplied repository UUID is required.',
      selection,
    );
  const counts: GitOperationCounts = {
    subprocesses: 0,
    metadataChecks: 0,
    commitReads: 0,
    treeReads: 0,
    blobReads: 0,
    metadataBytes: 0,
    blobBytes: 0,
  };
  try {
    const layout = await assertRepositoryLayout(request.repositoryPath);
    const executable = await resolveGitExecutable(layout.root);
    const initial = runner(
      layout,
      executable,
      started + limits.deadlineMs,
      request.signal,
      selection,
      counts,
    );
    const version = outputText(await initial.run(['--version'], 128));
    if (!/^git version 2\.(?:[3-9][0-9]|[1-9][0-9]{2,})(?:\.|$)/.test(version))
      throw failure(
        'GIT_UNAVAILABLE',
        'Git 2.30 or newer is required.',
        selection,
      );
    if (
      outputText(
        await initial.run(['rev-parse', '--is-bare-repository'], 32),
      ) !== 'false'
    )
      throw failure(
        'UNSUPPORTED_REPOSITORY_LAYOUT',
        'Bare repositories are not supported.',
        selection,
      );
    const format = outputText(
      await initial.run(['rev-parse', '--show-object-format=storage'], 32),
    );
    if (format !== 'sha1' && format !== 'sha256')
      throw failure(
        'GIT_UNAVAILABLE',
        'Git object format is unsupported.',
        selection,
      );
    const objectFormat: 'sha1' | 'sha256' = format;
    const commitId = await resolveCommit(
      initial.run,
      request.revision,
      objectFormat === 'sha1' ? 40 : 64,
      selection,
    );
    const reader = createObjectReader({
      objectFormat,
      gitDirectory: layout.gitDirectory,
      ...initial,
      selection,
      counts,
      metadataLimit: limits.metadataBytes,
    });
    const commit = (
      await reader.readObjects([commitId], 'commit', limits.objectBytes)
    ).get(commitId)!;
    const rootTreeId = rootTree(
      commit.bytes,
      objectFormat === 'sha1' ? 40 : 64,
      selection,
    );
    return {
      repositoryId: repositoryId.data,
      commitId,
      rootTreeId,
      objectFormat,
      reader,
      statistics: () => Object.freeze({ ...counts }),
      acquisitionStage(
        selected: readonly GitSelectionStatus[],
        signal = request.signal,
      ) {
        return createObjectReader({
          objectFormat,
          gitDirectory: layout.gitDirectory,
          ...runner(
            layout,
            executable,
            performance.now() + GIT_DEADLINE_MS,
            signal,
            selected,
            counts,
          ),
          selection: selected,
          counts,
          metadataLimit: MAX_METADATA_BYTES,
        });
      },
    };
  } catch (error) {
    gitFailure(error, selection);
  }
}

export type GitRepository = Awaited<ReturnType<typeof openRepository>>;
