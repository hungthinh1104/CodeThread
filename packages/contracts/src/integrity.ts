import type { z } from 'zod';
import { sourceRangeSchema } from '@codethread/code-model';
import type {
  SourceEvidence,
  SourceRange,
  TestStep,
} from '@codethread/code-model';

/** Call once per snapshot/entity namespace; never merge occurrences by endpoints. */
export function checkUnique(
  values: readonly { id: string; key?: string }[],
  context: z.RefinementCtx,
  path: (string | number)[],
): void {
  const ids = new Set<string>();
  const keys = new Set<string>();
  values.forEach((value, index) => {
    if (ids.has(value.id))
      context.addIssue({
        code: 'custom',
        path: [...path, index, 'id'],
        message: 'Duplicate entity identity',
      });
    ids.add(value.id);
    if (value.key !== undefined) {
      if (keys.has(value.key))
        context.addIssue({
          code: 'custom',
          path: [...path, index, 'key'],
          message: 'Duplicate canonical key',
        });
      keys.add(value.key);
    }
  });
}

export function indexEvidence(
  values: readonly SourceEvidence[],
  snapshotId: string,
  context: z.RefinementCtx,
): Map<string, SourceEvidence> {
  checkUnique(values, context, ['evidenceRefs']);
  const hashes = new Map<string, string>();
  values.forEach((value, index) => {
    if (value.snapshotId !== snapshotId)
      context.addIssue({
        code: 'custom',
        path: ['evidenceRefs', index, 'snapshotId'],
        message: 'Cross-snapshot evidence',
      });
    const hash = hashes.get(value.fileId);
    if (hash !== undefined && hash !== value.contentHash)
      context.addIssue({
        code: 'custom',
        path: ['evidenceRefs', index, 'contentHash'],
        message: 'Conflicting content hashes for one file',
      });
    hashes.set(value.fileId, value.contentHash);
  });
  return new Map(values.map((value) => [value.id, value]));
}

export function checkLocations(
  values: readonly { fileId: string; filePath: string }[],
  context: z.RefinementCtx,
): void {
  const paths = new Map<string, string>();
  const files = new Map<string, string>();
  for (const value of values) {
    if (
      (paths.has(value.fileId) && paths.get(value.fileId) !== value.filePath) ||
      (files.has(value.filePath) && files.get(value.filePath) !== value.fileId)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Conflicting snapshot file/path identity',
      });
    }
    paths.set(value.fileId, value.filePath);
    files.set(value.filePath, value.fileId);
  }
}

export function checkDeclaration(
  entity: { fileId: string; range: SourceRange; declarationEvidenceId: string },
  evidence: ReadonlyMap<string, SourceEvidence>,
  context: z.RefinementCtx,
  path: (string | number)[],
): void {
  const primary = evidence.get(entity.declarationEvidenceId);
  const matches =
    primary &&
    primary.fileId === entity.fileId &&
    (['start', 'end'] as const).every((end) =>
      (['offset', 'line', 'column'] as const).every(
        (coordinate) =>
          entity.range[end][coordinate] === primary.range[end][coordinate],
      ),
    );
  if (!matches)
    context.addIssue({
      code: 'custom',
      path: [...path, 'declarationEvidenceId'],
      message: 'Declaration evidence must match the owning file and range',
    });
}

export function checkSite(
  siteId: string,
  ownerId: string,
  evidence: ReadonlyMap<string, SourceEvidence>,
  context: z.RefinementCtx,
  path: (string | number)[],
): void {
  const site = evidence.get(siteId),
    owner = evidence.get(ownerId);
  if (
    !site ||
    !owner ||
    site.fileId !== owner.fileId ||
    site.range.start.offset < owner.range.start.offset ||
    site.range.end.offset > owner.range.end.offset ||
    !sourceRangeSchema.safeParse({
      start: owner.range.start,
      end: site.range.start,
    }).success ||
    !sourceRangeSchema.safeParse({
      start: site.range.end,
      end: owner.range.end,
    }).success
  ) {
    context.addIssue({
      code: 'custom',
      path,
      message:
        'Call-site evidence must be contained in its source declaration or step',
    });
  }
}

export function checkStepHierarchy(
  steps: readonly TestStep[],
  context: z.RefinementCtx,
): void {
  const parents = new Map(steps.map((step) => [step.id, step.parentStepId]));
  const done = new Set<string>();
  for (const step of steps) {
    const chain = new Set<string>();
    let current: string | null | undefined = step.id;
    while (current !== null && current !== undefined && !done.has(current)) {
      if (chain.has(current)) {
        context.addIssue({
          code: 'custom',
          path: ['steps'],
          message: 'Cyclic step containment',
        });
        break;
      }
      chain.add(current);
      current = parents.get(current);
    }
    for (const id of chain) done.add(id);
  }
}
