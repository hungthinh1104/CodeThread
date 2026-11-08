import type {
  AnalysisFacts,
  VerifiedSourceReader,
} from '@codethread/code-model';
import { createContext } from './context.js';
import { neighbors, paths } from './traversal.js';
import { sourceEvidence } from './evidence.js';
export { TraceError } from './fact-integrity.js';

export function createInvestigation(
  input: AnalysisFacts,
  source: VerifiedSourceReader,
) {
  const context = createContext(input, source);
  return Object.freeze({
    neighbors: (requestInput: unknown) => neighbors(context, requestInput),
    paths: (requestInput: unknown) => paths(context, requestInput),
    sourceEvidence: (requestInput: unknown) =>
      sourceEvidence(context, requestInput),
  });
}
