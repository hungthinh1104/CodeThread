import { describe, expect, it } from 'vitest';
import { ANALYSIS_LIMITS } from '@codethread/symbol-indexer';
import { GIT_INVENTORY_LIMITS } from '../scripts/git-source/inventory-types.ts';
import { benchmarkLimits } from '../scripts/source-discovery-benchmark/limits.ts';
import {
  assertInventoryIdentityStable,
  assertPartialInventoryControlEvidence,
  summarizePartialInventoryControls,
} from '../scripts/source-discovery-benchmark/verification.ts';

describe('source discovery benchmark limits', () => {
  it('reports the limits enforced by inventory and source acquisition', () => {
    expect(benchmarkLimits).toEqual({
      inventoryFiles: GIT_INVENTORY_LIMITS.files,
      uniqueTrees: GIT_INVENTORY_LIMITS.trees,
      treeVisits: GIT_INVENTORY_LIMITS.treeVisits,
      treeEntries: GIT_INVENTORY_LIMITS.treeEntries,
      metadataObjectBytes: GIT_INVENTORY_LIMITS.objectBytes,
      metadataBytes: GIT_INVENTORY_LIMITS.metadataBytes,
      sourceFiles: ANALYSIS_LIMITS.maxFiles,
      sourceBytesPerFile: ANALYSIS_LIMITS.maxFileBytes,
      sourceBytesTotal: ANALYSIS_LIMITS.maxTotalBytes,
    });
  });

  it('rejects an inventory identity mutation across benchmark samples', () => {
    expect(() =>
      assertInventoryIdentityStable(['same', 'mutated', 'same']),
    ).toThrow(/Repeated inventory discovery changed its identity/);
  });

  it('rejects an incomplete identity sample set', () => {
    expect(() => assertInventoryIdentityStable(['same'])).toThrow(
      /Repeated inventory discovery changed its identity/,
    );
  });

  it('rejects mutated partial inventory control outcomes', () => {
    expect(() =>
      assertPartialInventoryControlEvidence({
        lowerTreeLimitReason: 'file_limit',
        cancelledBeforeStartCode: 'CANCELLED',
      }),
    ).toThrow(/Partial inventory controls returned unexpected results/);
    expect(() =>
      assertPartialInventoryControlEvidence({
        lowerTreeLimitReason: 'tree_limit',
        cancelledBeforeStartCode: 'ANALYSIS_TIMEOUT',
      }),
    ).toThrow(/Partial inventory controls returned unexpected results/);
  });

  it('rejects inconsistent or missing partial inventory samples', () => {
    const expected = {
      lowerTreeLimitReason: 'tree_limit',
      cancelledBeforeStartCode: 'CANCELLED',
    };
    expect(() => summarizePartialInventoryControls([expected])).toThrow(
      /samples are incomplete/,
    );
    expect(() =>
      summarizePartialInventoryControls(
        Array.from({ length: 9 }, (_, index) =>
          index === 4
            ? { ...expected, lowerTreeLimitReason: 'file_limit' }
            : expected,
        ),
      ),
    ).toThrow(/unexpected results/);
  });
});
