/** Compatibility facade; implementation modules import their owning query family directly. */
export {
  parseListTestsResult,
  parseRelatedProductionSymbolsResult,
  parseFindTestsForSymbolResult,
  parseGetTestTraceResult,
} from './test-results.js';
export type { LinkValidationContext } from './test-results.js';
export {
  parseGetSourceEvidenceResult,
  parseGetDiagnosticsResult,
} from './source-results.js';
export {
  parseGraphNeighborsResult,
  parseFindSymbolPathsResult,
} from './graph-results.js';
