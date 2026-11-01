import type { AnalysisFacts } from '@codethread/code-model';

export interface PreparedFile {
  path: string;
  sha256: string;
  byteLength: number;
  base64: string;
}
export interface WorkerInput {
  repositoryId: string;
  sourceFingerprint: string;
  configurationHash: string;
  files: PreparedFile[];
}
export type WorkerOutput =
  | { ok: true; facts: AnalysisFacts }
  | { ok: false; code: string; message: string };
