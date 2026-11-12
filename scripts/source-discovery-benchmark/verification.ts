import { entryCounts, repeats, shapes } from './config.ts';

export interface PartialInventoryControlEvidence {
  lowerTreeLimitReason: string;
  cancelledBeforeStartCode: string;
}

export function assertInventoryIdentityStable(
  identities: readonly string[],
): true {
  if (
    identities.length !== repeats ||
    !identities[0] ||
    identities.some((identity) => identity !== identities[0])
  )
    throw new Error('Repeated inventory discovery changed its identity.');
  return true;
}

export function assertPartialInventoryControlEvidence(
  evidence: PartialInventoryControlEvidence,
): PartialInventoryControlEvidence {
  if (
    evidence.lowerTreeLimitReason !== 'tree_limit' ||
    evidence.cancelledBeforeStartCode !== 'CANCELLED'
  )
    throw new Error('Partial inventory controls returned unexpected results.');
  return evidence;
}

export function summarizePartialInventoryControls(
  samples: readonly PartialInventoryControlEvidence[],
): PartialInventoryControlEvidence {
  if (samples.length !== entryCounts.length * shapes.length)
    throw new Error('Partial inventory control samples are incomplete.');
  const [first, ...rest] = samples;
  if (!first) throw new Error('Partial inventory controls were not observed.');
  assertPartialInventoryControlEvidence(first);
  for (const sample of rest) {
    assertPartialInventoryControlEvidence(sample);
    if (
      sample.lowerTreeLimitReason !== first.lowerTreeLimitReason ||
      sample.cancelledBeforeStartCode !== first.cancelledBeforeStartCode
    )
      throw new Error('Partial inventory controls changed across workloads.');
  }
  return first;
}
