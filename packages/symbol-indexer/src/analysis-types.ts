import { analysisResourceLimits } from '@codethread/code-model';
import type {
  AnalysisFacts,
  AnalysisResourceProfile,
  VerifiedSourceReader,
} from '@codethread/code-model';

export const COMPILER_PROFILE = Object.freeze({
  profile: 'ct-index-001a-esm-v1',
  target: 'ES2023',
  module: 'ESNext',
  moduleResolution: 'Bundler',
  moduleDetection: 'force',
  strict: true,
  noEmit: true,
  allowJs: false,
  types: Object.freeze([] as string[]),
  lib: Object.freeze(['es2023']),
});
const selected = analysisResourceLimits();
export const ANALYSIS_LIMITS = Object.freeze({
  maxFiles: selected.maxFiles,
  maxFileBytes: selected.maxFileBytes,
  maxTotalBytes: selected.maxTotalBytes,
});
export interface AnalysisInput {
  repositoryId: string;
  compilerOptions: typeof COMPILER_PROFILE;
  files: readonly { path: string; bytes: Uint8Array; sha256: string }[];
  resourceProfile?: AnalysisResourceProfile;
  /** May lower the selected execution profile's deadline and heap ceilings. */
  deadlineMs?: number;
  heapLimitMiB?: number;
  signal?: AbortSignal;
}
export interface AnalysisSnapshot {
  facts: AnalysisFacts;
  source: VerifiedSourceReader;
  resourceProfile?: AnalysisResourceProfile;
  contextDiagnostics?: readonly ProjectDiagnostic[];
  execution?: Readonly<{
    ipcBytes: number;
    elapsedMs: number;
    inputPreparationMs: number;
    workerElapsedMs: number;
    compilerMs: number;
    extractionMs: number;
    factValidationMs: number;
    workerPeakRssBytes: number | null;
  }>;
}
export interface PreparedFile {
  path: string;
  sha256: string;
  byteLength: number;
  base64: string;
}
export interface ProjectDiagnostic {
  code: string;
  message: string;
  path?: string;
}
export type AnalysisErrorCode =
  | 'INVALID_MANIFEST'
  | 'HASH_MISMATCH'
  | 'INVALID_ENCODING'
  | 'INVALID_COMPILER_OPTIONS'
  | 'RESOURCE_LIMIT'
  | 'ANALYSIS_TIMEOUT'
  | 'ANALYSIS_FAILED'
  | 'MALFORMED_SOURCE'
  | 'COMPILER_INTEGRITY'
  | 'CANCELLED';
export class AnalysisError extends Error {
  constructor(
    public readonly code: AnalysisErrorCode,
    message: string,
    public readonly sourcePath?: string,
  ) {
    super(message);
    this.name = 'AnalysisError';
  }
}
