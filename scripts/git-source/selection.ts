import type { GitSourceErrorCode, GitSelectionStatus } from './types.ts';
import { GitSourceError, MAX_PATH_COMPONENTS } from './types.ts';
import { ANALYSIS_LIMITS } from '@codethread/symbol-indexer';
import { isSnapshotPath } from '@codethread/code-model';

export function failure(
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

export function withRejected(
  statuses: readonly GitSelectionStatus[],
  rejectedIndex: number,
): GitSelectionStatus[] {
  return statuses.map((item, index) => ({
    ...item,
    status: index === rejectedIndex ? 'rejected' : 'not-admitted',
  }));
}

export function validateSelection(
  paths: readonly string[],
): GitSelectionStatus[] {
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

export function gitFailure(
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

export function summarizeSelection(
  selection: readonly GitSelectionStatus[],
): string {
  const count = (status: GitSelectionStatus['status']) =>
    selection.filter((item) => item.status === status).length;
  return `${selection.length} selected, ${count('admitted')} admitted, ${count('rejected')} rejected, ${count('not-admitted')} not admitted`;
}
