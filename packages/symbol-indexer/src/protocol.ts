import type {
  AnalysisFacts,
  AnalysisResourceProfile,
} from '@codethread/code-model';

import type { PreparedFile, ProjectDiagnostic } from './analysis-types.js';
import type { ProjectWorkerContext } from './project-types.js';
export interface WorkerInput {
  resourceProfile: AnalysisResourceProfile;
  heapLimitBytes: number;
  repositoryId: string;
  sourceFingerprint: string;
  configurationHash: string;
  files: PreparedFile[];
  project?: ProjectWorkerContext;
}
export type WorkerOutput =
  | {
      ok: true;
      facts: AnalysisFacts;
      contextDiagnostics?: readonly ProjectDiagnostic[];
      workerPeakRssBytes?: number;
      phaseTimings?: { compilerMs: number; extractionMs: number };
    }
  | { ok: false; code: string; message: string; sourcePath?: string };
