import { repeats } from './config.ts';

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
