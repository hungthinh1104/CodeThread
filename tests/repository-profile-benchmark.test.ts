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
  contextDiagnosticCodes: [],
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

  it('accepts explicitly scoped diagnostics without claiming a complete context', () => {
    const scopedInputs = {
      ...validInputs,
      contextComplete: false,
      contextDiagnosticCodes: ['SEMANTIC_DIAGNOSTICS_SCOPED'],
    };
    expect(() => assertRepositoryProfileInputs(scopedInputs)).not.toThrow();
  });

  it('rejects incomplete context evidence without an explicit reason', () => {
    expect(() =>
      assertRepositoryProfileInputs({ ...validInputs, contextComplete: false }),
    ).toThrow(/did not complete its inputs/);
  });

  it('rejects incomplete context evidence with unrelated diagnostics', () => {
    expect(() =>
      assertRepositoryProfileInputs({
        ...validInputs,
        contextComplete: false,
        contextDiagnosticCodes: ['TS_2307', 'SEMANTIC_DIAGNOSTICS_SCOPED'],
      }),
    ).toThrow(/did not complete its inputs/);
  });

  it('rejects labeling scoped diagnostics as a complete context', () => {
    expect(() =>
      assertRepositoryProfileInputs({
        ...validInputs,
        contextDiagnosticCodes: ['SEMANTIC_DIAGNOSTICS_SCOPED'],
      }),
    ).toThrow(/did not complete its inputs/);
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
