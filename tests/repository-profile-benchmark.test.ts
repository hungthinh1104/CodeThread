import { describe, expect, it } from 'vitest';
import {
  assertRepositoryProfileCall,
  assertRepositoryProfileInputs,
  assertRepositoryProfileQueries,
} from '../scripts/repository-profile-benchmark/verification.ts';

const validInputs = {
  expectedCommitId: 'pinned-commit',
  actualCommitId: 'pinned-commit',
  inventoryComplete: true,
  expectedSourceFiles: 1_000,
  actualSourceFiles: 1_000,
  expectedSourceBytes: 32 * 1024 * 1024,
  actualSourceBytes: 32 * 1024 * 1024,
  sourceCoverageComplete: true,
  analysisComplete: true,
  contextComplete: true,
};

const validQueries = {
  projectMode: 'repository',
  fileTotal: 1_000,
  expectedFileTotal: 1_000,
  catalogTotal: 1,
  expectedSnapshotId: 'context-snapshot',
  sessionSnapshotId: 'context-snapshot',
  symbolTotal: 1,
  graphRelationCount: 1,
  evidenceStatus: 'available',
  followRequiresChoice: false,
};

describe('repository profile benchmark integrity gate', () => {
  it('accepts complete, pinned workload evidence and query results', () => {
    expect(() => assertRepositoryProfileInputs(validInputs)).not.toThrow();
    expect(() => assertRepositoryProfileQueries(validQueries)).not.toThrow();
  });

  it('rejects a mutated source count instead of reporting a passing workload', () => {
    expect(() =>
      assertRepositoryProfileInputs({ ...validInputs, actualSourceFiles: 999 }),
    ).toThrow(/did not complete its inputs/);
  });

  it('rejects a missing exact direct call in the benchmark fixture', () => {
    expect(() => assertRepositoryProfileCall(undefined)).toThrow(
      /direct call did not resolve exactly/,
    );
  });

  it('rejects a mutated graph result instead of reporting a passing query smoke', () => {
    expect(() =>
      assertRepositoryProfileQueries({
        ...validQueries,
        graphRelationCount: 0,
      }),
    ).toThrow(/query smoke returned incomplete results/);
  });
});
