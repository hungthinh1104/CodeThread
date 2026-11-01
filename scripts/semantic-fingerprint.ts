import { createHash } from 'node:crypto';
import type { AnalysisFacts } from '@codethread/code-model';

/** Cross-platform determinism check, not semantic ground truth. */
export function semanticFingerprint(facts: AnalysisFacts): string {
  return createHash('sha256').update(JSON.stringify(facts)).digest('hex');
}
