import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, realpath, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, relative, resolve, sep } from 'node:path';
import { idSchema, isSnapshotPath } from '@codethread/code-model';
import { ANALYSIS_LIMITS, COMPILER_PROFILE } from '@codethread/symbol-indexer';
import type { AnalysisInput } from '@codethread/symbol-indexer';

export type GitSourceErrorCode =
  | 'INVALID_REPOSITORY'
  | 'INVALID_REPOSITORY_ID'
  | 'UNSUPPORTED_REPOSITORY_LAYOUT'
  | 'INVALID_REVISION'
  | 'INVALID_SELECTION'
  | 'FILE_NOT_FOUND'
  | 'UNSUPPORTED_FILE_MODE'
  | 'MISSING_OBJECT'
  | 'CORRUPT_OBJECT'
  | 'RESOURCE_LIMIT'
  | 'GIT_TIMEOUT'
  | 'CANCELLED'
  | 'GIT_UNAVAILABLE'
  | 'GIT_FAILED'
  | 'GIT_PROTOCOL';

export interface GitSelectionStatus {
  path: string;
  status: 'selected' | 'admitted' | 'rejected' | 'not-admitted';
}

export class GitSourceError extends Error {
  readonly code: GitSourceErrorCode;
  readonly selection: readonly GitSelectionStatus[];

  constructor(
    code: GitSourceErrorCode,
    message: string,
    selection: readonly GitSelectionStatus[] = [],
  ) {
    super(message);
    this.name = 'GitSourceError';
    this.code = code;
    this.selection = selection;
  }
}

export interface GitSourceRequest {
  repositoryPath: string;
  repositoryId: string;
  revision: string;
  selectedPaths: readonly string[];
  signal?: AbortSignal;
}

export interface GitSourceProvenance {
  commitId: string;
  objectFormat: 'sha1' | 'sha256';
  files: readonly {
    path: string;
    blobId: string;
    mode: '100644' | '100755';
    sha256: string;
  }[];
}

export interface AcquiredGitSources {
  input: AnalysisInput;
  provenance: GitSourceProvenance;
  selection: readonly GitSelectionStatus[];
}

const GIT_DEADLINE_MS = 10_000;
const MAX_OBJECT_BYTES = 1024 * 1024;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_VISITED_TREES = 128;
const MAX_TREE_ENTRIES = 10_000;
const MAX_PATH_COMPONENTS = 64;
const MAX_STDERR_BYTES = 8 * 1024;
const ORDER_BYTES = (left: Buffer, right: Buffer): number =>
  Buffer.compare(left, right);

interface TreeEntry {
  name: Buffer;
  readonly mode: '100644' | '100755' | '120000' | '160000' | '40000' | '040000';
  oid: string;
}

function parseTreeMode(value: string): TreeEntry['mode'] | null {
  switch (value) {
    case '100644':
    case '100755':
    case '120000':
    case '160000':
    case '40000':
    case '040000':
      return value;
    default:
      return null;
  }
}

interface GitProcessResult {
  stdout: Buffer;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === code
  );
}

function failure(
  code: GitSourceErrorCode,
  message: string,
  selection: readonly GitSelectionStatus[],
): GitSourceError {
  return new GitSourceError(
    code,
    message,
    selection.map((item) =>
      item.status === 'selected' ? { ...item, status: 'not-admitted' } : item,
    ),
  );
}

function initialSelection(paths: readonly string[]): GitSelectionStatus[] {
  return paths.map((path) => ({ path, status: 'selected' }));
}

function withRejected(
  statuses: readonly GitSelectionStatus[],
  rejectedIndex: number,
): GitSelectionStatus[] {
  return statuses.map((item, index) => ({
    ...item,
    status: index === rejectedIndex ? 'rejected' : 'not-admitted',
  }));
}

function validateSelection(paths: readonly string[]): GitSelectionStatus[] {
  const statuses = initialSelection(paths),
    seen = new Set<string>();
  if (paths.length < 1)
    throw failure('INVALID_SELECTION', 'Select at least one source file.', []);
  if (paths.length > ANALYSIS_LIMITS.maxFiles)
    throw failure(
      'RESOURCE_LIMIT',
      `Selection exceeds the ${ANALYSIS_LIMITS.maxFiles}-file limit.`,
      statuses.map((item) => ({ ...item, status: 'not-admitted' as const })),
    );
  for (const [index, path] of paths.entries()) {
    if (
      typeof path !== 'string' ||
      Buffer.from(path, 'utf8').toString('utf8') !== path ||
      !isSnapshotPath(path) ||
      !path.endsWith('.ts') ||
      /\p{Cc}/u.test(path) ||
      path.split('/').length > MAX_PATH_COMPONENTS
    )
      throw failure(
        'INVALID_SELECTION',
        'A selected path is not a supported literal TypeScript source path.',
        withRejected(statuses, index),
      );
    const folded = path.toLowerCase();
    if (seen.has(folded))
      throw failure(
        'INVALID_SELECTION',
        'Duplicate or case-equivalent source selections are not allowed.',
        withRejected(statuses, index),
      );
    seen.add(folded);
  }
  return statuses;
}

function isOutside(path: string, directory: string): boolean {
  const remainder = relative(directory, path);
  return (
    remainder === '..' ||
    remainder.startsWith(`..${sep}`) ||
    isAbsolute(remainder)
  );
}

async function resolveGitExecutable(repositoryRoot: string): Promise<string> {
  const searchPath = process.env['PATH'] ?? '',
    extensions = process.platform === 'win32' ? ['.exe'] : [''];
  for (const directory of searchPath.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = resolve(directory, `git${extension}`);
      try {
        await access(
          candidate,
          process.platform === 'win32' ? undefined : constants.X_OK,
        );
        const absolute = await realpath(candidate),
          metadata = await stat(absolute);
        if (metadata.isFile() && isOutside(absolute, repositoryRoot))
          return absolute;
      } catch {
        // Continue through the caller's PATH; candidate paths are not diagnostics.
      }
    }
  }
  throw new GitSourceError(
    'GIT_UNAVAILABLE',
    'A trusted native Git executable outside the repository was not found.',
  );
}

function childEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'] ?? '',
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TRACE: '0',
    GIT_TRACE_SETUP: '0',
    GIT_TRACE_PACKET: '0',
    GIT_TRACE_PERFORMANCE: '0',
    GIT_TRACE2: '0',
    GIT_TRACE2_EVENT: '0',
    GIT_TRACE2_PERF: '0',
  };
  for (const key of ['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function runGit(
  executable: string,
  gitDirectory: string,
  workTree: string,
  args: readonly string[],
  deadlineAt: number,
  signal: AbortSignal | undefined,
  maxStdoutBytes: number,
  input: Buffer = Buffer.alloc(0),
): Promise<GitProcessResult> {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(
        new GitSourceError('CANCELLED', 'Git source acquisition cancelled.'),
      );
      return;
    }
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      reject(
        new GitSourceError('GIT_TIMEOUT', 'Git source acquisition timed out.'),
      );
      return;
    }
    const child = spawn(
      executable,
      [
        '--git-dir',
        gitDirectory,
        '--work-tree',
        workTree,
        '--no-replace-objects',
        '--no-optional-locks',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.pager=cat',
        ...args,
      ],
      {
        cwd: workTree,
        env: childEnvironment(),
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    let stdoutBytes = 0,
      stderrBytes = 0,
      overflow = false,
      timedOut = false,
      cancelled = false,
      settled = false;
    const finishReject = (error: GitSourceError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(error);
    };
    const abort = () => {
      cancelled = true;
      child.kill();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, remaining);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        overflow = true;
        child.kill();
      } else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const retained = chunk.subarray(
        0,
        Math.max(0, MAX_STDERR_BYTES - stderrBytes),
      );
      stderrBytes += retained.length;
      if (retained.length > 0) stderr.push(retained);
    });
    child.stdin.on('error', () => {
      // A bounded Git command can exit before consuming its complete input.
    });
    child.stdin.end(input);
    child.once('error', () => {
      finishReject(
        new GitSourceError(
          'GIT_UNAVAILABLE',
          'Unable to start the Git process.',
        ),
      );
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (cancelled || signal?.aborted) {
        reject(
          new GitSourceError('CANCELLED', 'Git source acquisition cancelled.'),
        );
      } else if (timedOut) {
        reject(
          new GitSourceError(
            'GIT_TIMEOUT',
            'Git source acquisition timed out.',
          ),
        );
      } else if (overflow) {
        reject(
          new GitSourceError(
            'RESOURCE_LIMIT',
            'Git output exceeded its bound.',
          ),
        );
      } else if (code !== 0) {
        const diagnostic = Buffer.concat(stderr, stderrBytes).toString('utf8');
        const code =
          /could not get object info|object .* missing|not a valid object name/i.test(
            diagnostic,
          )
            ? 'MISSING_OBJECT'
            : /corrupt|bad object|unable to unpack|inflate/i.test(diagnostic)
              ? 'CORRUPT_OBJECT'
              : 'GIT_FAILED';
        reject(
          new GitSourceError(code, 'A required Git object operation failed.'),
        );
      } else {
        resolvePromise({
          stdout: Buffer.concat(stdout, stdoutBytes),
        });
      }
    });
  });
}

function outputText(result: GitProcessResult): string {
  return result.stdout.toString('utf8').trim();
}

function gitFailure(
  error: unknown,
  selection: readonly GitSelectionStatus[],
): never {
  if (error instanceof GitSourceError)
    throw new GitSourceError(
      error.code,
      error.message,
      error.selection.length > 0
        ? error.selection
        : selection.map((item) =>
            item.status === 'selected'
              ? { ...item, status: 'not-admitted' as const }
              : item,
          ),
    );
  throw failure('GIT_FAILED', 'A Git source operation failed.', selection);
}

function verifyObject(
  objectFormat: 'sha1' | 'sha256',
  type: string,
  bytes: Buffer,
  expectedOid: string,
): boolean {
  const digest = createHash(objectFormat)
    .update(`${type} ${bytes.length}\0`, 'utf8')
    .update(bytes)
    .digest('hex');
  return digest === expectedOid;
}

function parseTree(
  bytes: Buffer,
  oidWidth: number,
  remainingEntryLimit: number,
): TreeEntry[] {
  const entries: TreeEntry[] = [],
    names = new Set<string>();
  let cursor = 0;
  while (cursor < bytes.length) {
    const space = bytes.indexOf(0x20, cursor),
      nul = bytes.indexOf(0, space + 1);
    if (space <= cursor || nul <= space || nul + 1 + oidWidth > bytes.length)
      throw new GitSourceError(
        'CORRUPT_OBJECT',
        'A Git tree object is malformed.',
      );
    const mode = parseTreeMode(bytes.subarray(cursor, space).toString('ascii')),
      name = bytes.subarray(space + 1, nul),
      rawOid = bytes.subarray(nul + 1, nul + 1 + oidWidth),
      nameKey = name.toString('hex');
    if (
      mode === null ||
      name.length === 0 ||
      name.includes(0x2f) ||
      name.equals(Buffer.from('.')) ||
      name.equals(Buffer.from('..')) ||
      names.has(nameKey)
    )
      throw new GitSourceError(
        'CORRUPT_OBJECT',
        'A Git tree entry is malformed.',
      );
    names.add(nameKey);
    entries.push({
      name: Buffer.from(name),
      mode,
      oid: rawOid.toString('hex'),
    });
    if (entries.length > remainingEntryLimit)
      throw new GitSourceError(
        'RESOURCE_LIMIT',
        'Selected paths expose too many Git tree entries.',
      );
    cursor = nul + 1 + oidWidth;
  }
  return entries;
}

async function assertRepositoryLayout(
  requestedPath: string,
): Promise<{ root: string; gitDirectory: string }> {
  let root: string;
  try {
    root = await realpath(resolve(requestedPath));
    const rootInfo = await stat(root);
    if (!rootInfo.isDirectory()) throw new Error('not-directory');
  } catch {
    throw new GitSourceError(
      'INVALID_REPOSITORY',
      'Repository root is unavailable.',
    );
  }
  const gitDirectory = resolve(root, '.git');
  try {
    const gitInfo = await lstat(gitDirectory);
    if (!gitInfo.isDirectory() || gitInfo.isSymbolicLink())
      throw new Error('unsupported-layout');
    const gitReal = await realpath(gitDirectory);
    if (resolve(gitReal) !== resolve(gitDirectory))
      throw new Error('unsupported-layout');
    const objects = resolve(gitDirectory, 'objects'),
      objectInfo = await lstat(objects);
    if (!objectInfo.isDirectory() || objectInfo.isSymbolicLink())
      throw new Error('unsupported-layout');
    for (const unsupported of [
      resolve(gitDirectory, 'commondir'),
      resolve(objects, 'info', 'alternates'),
    ]) {
      try {
        await lstat(unsupported);
      } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) throw error;
        continue;
      }
      throw new GitSourceError(
        'UNSUPPORTED_REPOSITORY_LAYOUT',
        'Linked worktrees and alternate object stores are not supported.',
      );
    }
    return { root, gitDirectory };
  } catch {
    throw new GitSourceError(
      'UNSUPPORTED_REPOSITORY_LAYOUT',
      'Only standard repositories with a real .git directory and local object store are supported.',
    );
  }
}

function parseDecimal(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value))
    throw new GitSourceError(
      'GIT_PROTOCOL',
      'Git returned malformed object metadata.',
    );
  const number = Number(value);
  if (!Number.isSafeInteger(number))
    throw new GitSourceError(
      'RESOURCE_LIMIT',
      'Git object size exceeds the supported range.',
    );
  return number;
}

export async function acquireGitSources(
  request: GitSourceRequest,
): Promise<AcquiredGitSources> {
  const selection = validateSelection(request.selectedPaths),
    started = Date.now(),
    deadlineAt = started + GIT_DEADLINE_MS;
  if (request.signal?.aborted)
    throw failure('CANCELLED', 'Git source acquisition cancelled.', selection);
  if (!idSchema.safeParse(request.repositoryId).success)
    throw failure(
      'INVALID_REPOSITORY_ID',
      'A caller-supplied repository UUID is required.',
      selection.map((item) => ({ ...item, status: 'not-admitted' })),
    );
  let layout: { root: string; gitDirectory: string }, executable: string;
  try {
    layout = await assertRepositoryLayout(request.repositoryPath);
    executable = await resolveGitExecutable(layout.root);
  } catch (error) {
    gitFailure(error, selection);
  }
  const { root, gitDirectory } = layout,
    run = async (
      args: readonly string[],
      maxOutput = 64 * 1024,
      input?: Buffer,
    ) => {
      try {
        return await runGit(
          executable,
          gitDirectory,
          root,
          args,
          deadlineAt,
          request.signal,
          maxOutput,
          input,
        );
      } catch (error) {
        gitFailure(error, selection);
      }
    };
  try {
    const version = outputText(await run(['--version'], 128));
    if (!/^git version 2\.(?:[3-9][0-9]|[1-9][0-9]{2,})(?:\.|$)/.test(version))
      throw failure(
        'GIT_UNAVAILABLE',
        'Git 2.30 or newer is required.',
        selection,
      );
    const bare = outputText(
      await run(['rev-parse', '--is-bare-repository'], 32),
    );
    if (bare !== 'false')
      throw failure(
        'UNSUPPORTED_REPOSITORY_LAYOUT',
        'Bare repositories are not supported.',
        selection,
      );
    const format = outputText(
      await run(['rev-parse', '--show-object-format=storage'], 32),
    );
    if (format !== 'sha1' && format !== 'sha256')
      throw failure(
        'GIT_UNAVAILABLE',
        'Git object format is unsupported.',
        selection,
      );
    const width = format === 'sha1' ? 40 : 64,
      inputRevision = request.revision;
    if (
      typeof inputRevision !== 'string' ||
      !(
        inputRevision === 'HEAD' ||
        new RegExp(`^[0-9a-f]{${width}}$`).test(inputRevision) ||
        /^(?:refs\/heads|refs\/tags)\//.test(inputRevision)
      )
    )
      throw failure(
        'INVALID_REVISION',
        'Use a full commit ID, HEAD, or fully qualified local branch or tag ref.',
        selection,
      );
    if (inputRevision.startsWith('refs/')) {
      let checked: GitProcessResult;
      try {
        checked = await run(['check-ref-format', inputRevision], 32);
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
          [
            'rev-parse',
            '--verify',
            '--end-of-options',
            `${inputRevision}^{commit}`,
          ],
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
      (/^[0-9a-f]+$/.test(inputRevision) && inputRevision !== resolved)
    )
      throw failure(
        'INVALID_REVISION',
        'The selected revision is not a complete commit ID.',
        selection,
      );
    let metadataBytes = 0;
    const missingObject = async (
      oid: string,
      sourceIndexes?: readonly number[],
      requestedOids?: readonly string[],
    ): Promise<GitSourceError> => {
      let corruptLooseObject = false;
      try {
        await lstat(
          resolve(gitDirectory, 'objects', oid.slice(0, 2), oid.slice(2)),
        );
        corruptLooseObject = true;
      } catch {
        // A missing loose object may still exist in a pack; Git reported it unavailable.
      }
      const objectIndex =
          requestedOids?.findIndex((requestedOid) => requestedOid === oid) ??
          -1,
        sourceIndex =
          objectIndex >= 0 ? sourceIndexes?.[objectIndex] : undefined;
      return failure(
        corruptLooseObject ? 'CORRUPT_OBJECT' : 'MISSING_OBJECT',
        corruptLooseObject
          ? 'A loose Git object is corrupt or unreadable.'
          : 'A required Git object is missing.',
        sourceIndex === undefined
          ? selection
          : withRejected(selection, sourceIndex),
      );
    };
    const readObjects = async (
      requestedOids: readonly string[],
      expectedType: 'commit' | 'tree' | 'blob',
      maxBytes: number,
      sourceIndexes?: readonly number[],
    ): Promise<Map<string, { type: string; size: number; bytes: Buffer }>> => {
      const uniqueOids = [...new Set(requestedOids)];
      if (uniqueOids.length === 0) return new Map();
      for (const oid of uniqueOids)
        if (!new RegExp(`^[0-9a-f]{${width}}$`).test(oid))
          throw failure(
            'CORRUPT_OBJECT',
            'A Git object reference is malformed.',
            selection,
          );
      const input = Buffer.from(
          uniqueOids.map((oid) => `${oid}\n`).join(''),
          'ascii',
        ),
        checked = await run(
          [
            'cat-file',
            '--batch-check=%(objectname) %(objecttype) %(objectsize)',
          ],
          uniqueOids.length * (width + 64),
          input,
        ),
        lines = checked.stdout.toString('ascii').split('\n');
      if (lines.at(-1) !== '' || lines.length !== uniqueOids.length + 1)
        throw failure(
          'GIT_PROTOCOL',
          'Git returned malformed batch metadata.',
          selection,
        );
      const metadata = new Map<string, { type: string; size: number }>();
      for (const [index, oid] of uniqueOids.entries()) {
        const line = lines[index]!;
        if (line === `${oid} missing`)
          throw await missingObject(oid, sourceIndexes, requestedOids);
        const match = /^([0-9a-f]+) (commit|tree|blob) (0|[1-9][0-9]*)$/.exec(
          line,
        );
        if (!match || match[1] !== oid)
          throw failure(
            'GIT_PROTOCOL',
            'Git returned malformed batch metadata.',
            selection,
          );
        const type = match[2]!,
          size = parseDecimal(match[3]!);
        if (type !== expectedType)
          throw failure(
            'CORRUPT_OBJECT',
            'A Git object has an unexpected type.',
            selection,
          );
        if (size > maxBytes) {
          const objectIndex = requestedOids.findIndex(
              (requestedOid) => requestedOid === oid,
            ),
            rejectedIndex = sourceIndexes?.[objectIndex];
          throw failure(
            'RESOURCE_LIMIT',
            'A Git object exceeds its byte limit.',
            rejectedIndex !== undefined
              ? withRejected(selection, rejectedIndex)
              : selection,
          );
        }
        if (expectedType !== 'blob') {
          metadataBytes += size;
          if (metadataBytes > MAX_METADATA_BYTES)
            throw failure(
              'RESOURCE_LIMIT',
              'Git metadata exceeds its cumulative byte limit.',
              selection,
            );
        }
        metadata.set(oid, { type, size });
      }
      if (sourceIndexes) {
        let totalSourceBytes = 0;
        for (const [index, oid] of requestedOids.entries()) {
          totalSourceBytes += metadata.get(oid)!.size;
          if (totalSourceBytes > ANALYSIS_LIMITS.maxTotalBytes)
            throw failure(
              'RESOURCE_LIMIT',
              'Selected source exceeds the analyzer total-byte limit.',
              withRejected(selection, sourceIndexes[index]!),
            );
        }
      }
      const expectedBodyBytes = [...metadata.values()].reduce(
        (total, object) => total + object.size,
        0,
      );
      const content = await run(
          ['cat-file', '--batch'],
          expectedBodyBytes + uniqueOids.length * (width + 64),
          input,
        ),
        objects = new Map<
          string,
          { type: string; size: number; bytes: Buffer }
        >();
      let cursor = 0;
      for (const oid of uniqueOids) {
        const lineEnd = content.stdout.indexOf(0x0a, cursor);
        if (lineEnd < 0)
          throw failure(
            'GIT_PROTOCOL',
            'Git returned a truncated object header.',
            selection,
          );
        const header = content.stdout
          .subarray(cursor, lineEnd)
          .toString('ascii');
        if (header === `${oid} missing`)
          throw await missingObject(oid, sourceIndexes, requestedOids);
        const match = /^([0-9a-f]+) (commit|tree|blob) (0|[1-9][0-9]*)$/.exec(
            header,
          ),
          expected = metadata.get(oid);
        if (
          !match ||
          !expected ||
          match[1] !== oid ||
          match[2] !== expected.type ||
          parseDecimal(match[3]!) !== expected.size
        )
          throw failure(
            'GIT_PROTOCOL',
            'Git returned inconsistent object metadata.',
            selection,
          );
        const bodyStart = lineEnd + 1,
          bodyEnd = bodyStart + expected.size,
          separator = content.stdout[bodyEnd];
        if (bodyEnd >= content.stdout.length || separator !== 0x0a)
          throw failure(
            'GIT_PROTOCOL',
            'Git returned a truncated object body.',
            selection,
          );
        const bytes = Buffer.from(content.stdout.subarray(bodyStart, bodyEnd));
        if (!verifyObject(format, expected.type, bytes, oid))
          throw failure(
            'CORRUPT_OBJECT',
            'A Git object failed content identity verification.',
            sourceIndexes && requestedOids
              ? withRejected(
                  selection,
                  sourceIndexes[
                    requestedOids.findIndex(
                      (requestedOid) => requestedOid === oid,
                    )
                  ]!,
                )
              : selection,
          );
        objects.set(oid, { ...expected, bytes });
        cursor = bodyEnd + 1;
      }
      if (cursor !== content.stdout.length)
        throw failure(
          'GIT_PROTOCOL',
          'Git returned trailing object data.',
          selection,
        );
      return objects;
    };
    const commit = (
        await readObjects([resolved], 'commit', MAX_OBJECT_BYTES)
      ).get(resolved)!.bytes,
      headerEnd = commit.indexOf(Buffer.from('\n\n')),
      headers = commit
        .subarray(0, headerEnd < 0 ? commit.length : headerEnd)
        .toString('ascii'),
      treeLines = headers
        .split('\n')
        .filter((line) => line.startsWith('tree '));
    if (treeLines.length !== 1)
      throw failure(
        'CORRUPT_OBJECT',
        'The selected commit has no unique root tree.',
        selection,
      );
    const rootTree = treeLines[0]!.slice(5);
    if (!new RegExp(`^[0-9a-f]{${width}}$`).test(rootTree))
      throw failure(
        'CORRUPT_OBJECT',
        'The selected commit tree ID is malformed.',
        selection,
      );
    const orderedPaths = [...request.selectedPaths].sort((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)),
    );
    interface PendingPath {
      path: string;
      index: number;
      components: string[];
      componentIndex: number;
      treeOid: string;
    }
    const pathsByIndex = request.selectedPaths,
      treeCache = new Map<string, readonly TreeEntry[]>(),
      finalEntries = new Map<
        number,
        TreeEntry & { mode: '100644' | '100755' }
      >(),
      visitedTrees = new Set<string>();
    let pending: PendingPath[] = orderedPaths.map((path) => ({
      path,
      index: pathsByIndex.indexOf(path),
      components: path.split('/'),
      componentIndex: 0,
      treeOid: rootTree,
    }));
    let entryCount = 0;
    while (pending.length > 0) {
      if (Date.now() > deadlineAt)
        throw failure(
          'GIT_TIMEOUT',
          'Git source acquisition timed out.',
          selection,
        );
      if (request.signal?.aborted)
        throw failure(
          'CANCELLED',
          'Git source acquisition cancelled.',
          selection,
        );
      for (const path of pending) {
        visitedTrees.add(path.treeOid);
        if (visitedTrees.size > MAX_VISITED_TREES)
          throw failure(
            'RESOURCE_LIMIT',
            'Selected paths visit too many Git trees.',
            selection,
          );
      }
      const treeIds = [...new Set(pending.map((path) => path.treeOid))].filter(
        (oid) => !treeCache.has(oid),
      );
      const newTrees = await readObjects(treeIds, 'tree', MAX_OBJECT_BYTES);
      for (const [oid, object] of newTrees) {
        const entries = parseTree(
          object.bytes,
          width / 2,
          MAX_TREE_ENTRIES - entryCount,
        );
        entryCount += entries.length;
        treeCache.set(oid, entries);
      }
      const next: PendingPath[] = [];
      for (const path of pending) {
        const entries = treeCache.get(path.treeOid),
          component = path.components[path.componentIndex]!;
        if (!entries)
          throw failure(
            'GIT_PROTOCOL',
            'Git tree traversal is incomplete.',
            selection,
          );
        const matching = entries.find(
          (entry) =>
            ORDER_BYTES(entry.name, Buffer.from(component, 'utf8')) === 0,
        );
        if (!matching)
          throw failure(
            'FILE_NOT_FOUND',
            'A selected source path is absent from the pinned commit.',
            withRejected(selection, path.index),
          );
        if (path.componentIndex < path.components.length - 1) {
          if (matching.mode !== '40000' && matching.mode !== '040000')
            throw failure(
              'INVALID_SELECTION',
              'A selected path component is not a directory.',
              withRejected(selection, path.index),
            );
          next.push({
            ...path,
            componentIndex: path.componentIndex + 1,
            treeOid: matching.oid,
          });
        } else {
          const mode = matching.mode;
          if (mode !== '100644' && mode !== '100755')
            throw failure(
              'UNSUPPORTED_FILE_MODE',
              'Selected source is not a regular Git blob.',
              withRejected(selection, path.index),
            );
          finalEntries.set(path.index, { ...matching, mode });
        }
      }
      pending = next;
    }
    const orderedIndexes = orderedPaths.map((path) =>
        pathsByIndex.indexOf(path),
      ),
      blobIds = orderedIndexes.map((index) => finalEntries.get(index)!.oid),
      blobObjects = await readObjects(
        blobIds,
        'blob',
        ANALYSIS_LIMITS.maxFileBytes,
        orderedIndexes,
      ),
      admittedFiles: AnalysisInput['files'][number][] = [],
      provenanceFiles: GitSourceProvenance['files'][number][] = [];
    for (const [index, path] of orderedPaths.entries()) {
      const selectedIndex = orderedIndexes[index]!,
        entry = finalEntries.get(selectedIndex)!,
        blob = blobObjects.get(entry.oid);
      if (!blob)
        throw failure(
          'GIT_PROTOCOL',
          'A selected source blob was not returned.',
          selection,
        );
      const bytes = Uint8Array.from(blob.bytes),
        sha256 = createHash('sha256').update(bytes).digest('hex');
      admittedFiles.push({ path, bytes, sha256 });
      provenanceFiles.push({
        path,
        blobId: entry.oid,
        mode: entry.mode,
        sha256,
      });
    }
    if (Date.now() > deadlineAt)
      throw failure(
        'GIT_TIMEOUT',
        'Git source acquisition timed out.',
        selection,
      );
    const completed = orderedPaths.map((path) => ({
      path,
      status: 'admitted' as const,
    }));
    return {
      input: {
        repositoryId: idSchema.parse(request.repositoryId),
        compilerOptions: COMPILER_PROFILE,
        files: admittedFiles,
      },
      provenance: {
        commitId: resolved,
        objectFormat: format,
        files: provenanceFiles,
      },
      selection: completed,
    };
  } catch (error) {
    gitFailure(error, selection);
  }
}

export function summarizeSelection(
  selection: readonly GitSelectionStatus[],
): string {
  const count = (status: GitSelectionStatus['status']) =>
    selection.filter((item) => item.status === status).length;
  return `${selection.length} selected, ${count('admitted')} admitted, ${count('rejected')} rejected, ${count('not-admitted')} not admitted`;
}
