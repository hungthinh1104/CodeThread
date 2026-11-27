import type { infer as Infer } from 'zod';
import type {
  AiStatusResponse,
  AiSynthesisResponse,
  AiSynthesizeApiRequest,
  AiTaskKind,
  FindSymbolPathsRequest,
  FindSymbolPathsResponse,
  GetSourceEvidenceRequest,
  GraphNeighborsRequest,
  ListSymbolsResponse,
  viewerApiResponseSchemas,
} from '@codethread/contracts';

export type {
  AiStatusResponse,
  AiSynthesisResponse,
  AiSynthesizeApiRequest,
  AiTaskKind,
  FindSymbolPathsRequest,
  FindSymbolPathsResponse,
  GetSourceEvidenceRequest,
  GraphNeighborsRequest,
  ListSymbolsResponse,
};

type ProjectResult<T> = T extends { projectId: string; result: infer Result }
  ? Result
  : T;

export type Scope = {
  scanId: string;
  projectId: string;
  snapshotId: string;
};

export type RelationKindFilter = 'calls' | 'references' | 'constructs';
export type TraceDirection = 'outgoing' | 'incoming' | 'both';
export type TraceDepthOption = 1 | 2 | 3 | 4 | 5;
export type TraceNodeLimitOption = 50 | 100 | 200;
export type InvestigationView = 'source' | 'trace';

export type BackendHealth = {
  api: 'ready';
  database: 'ready' | 'unavailable';
  worker: 'ready' | 'unavailable';
  ready: boolean;
};

export type WorkspaceMetadata = {
  repositoryId: string;
  scanId: string;
  commitId: string;
  treeId?: string | null;
  revision: string;
  generation?: string;
  attempt?: number;
  activationResult?: 'activated' | 'stale' | 'not_eligible' | null;
  createdAt?: string;
  updatedAt?: string;
  expiresAt: string;
};

export type RepositoryItem = {
  id: string;
  label: string;
  activeScanId: string | null;
  generation: string;
};

export type AcceptedScan = {
  id: string;
  repositoryId: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  reused: boolean;
};

export type ScanStatusRecord = {
  id: string;
  repositoryId: string;
  generation: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  attempt: number;
  revision: string;
  commitId: string | null;
  treeId: string | null;
  activationResult: 'activated' | 'stale' | 'not_eligible' | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ScanProjectSummary = {
  project_id: string;
  project_label: string;
  status:
    | 'ready'
    | 'solution'
    | 'invalid'
    | 'unsupported'
    | 'failed'
    | 'not_analyzed';
  snapshot_id: string | null;
  diagnostics: { code: string; message: string; path?: string }[];
};

export type ScanManifestFile = {
  path: string;
  content_hash: string;
  git_blob_oid: string;
  git_mode: '100644' | '100755';
};

export type ScanManifestPage = {
  scanId: string;
  items: ScanManifestFile[];
  total: number;
  nextOffset: number | null;
};

export type ProjectContexts = Infer<
  (typeof viewerApiResponseSchemas)['/api/projects']
>;
export type ProjectContext = ProjectContexts['items'][number];
export type CatalogPage = Infer<
  (typeof viewerApiResponseSchemas)['/api/catalog']
>;
export type FilePage = Infer<(typeof viewerApiResponseSchemas)['/api/files']>;
export type SymbolPage = ProjectResult<
  Infer<(typeof viewerApiResponseSchemas)['/api/symbols']>
>;
export type CodeSymbol = SymbolPage['items'][number];
export type SessionProjection = ProjectResult<
  Infer<(typeof viewerApiResponseSchemas)['/api/session']>
>;
export type GraphProjection = ProjectResult<
  Infer<(typeof viewerApiResponseSchemas)['/api/neighbors']>
>;
export type EvidenceProjection = ProjectResult<
  Infer<(typeof viewerApiResponseSchemas)['/api/evidence']>
>;
export type EvidenceItem = EvidenceProjection['items'][number];
export type FollowContextProjection = ProjectResult<
  Infer<(typeof viewerApiResponseSchemas)['/api/follow-context']>
>;
export type CatalogItem = CatalogPage['items'][number];

export type SearchItem = {
  projectId: string;
  projectLabel: string;
  snapshotId: string;
  symbol: CatalogItem['symbol'];
};

export type SearchState = {
  items: SearchItem[];
  offset: number;
  total: number;
  nextOffset: number | null;
};

export type NavigationEntry = {
  scanId: string;
  projectId: string;
  snapshotId: string;
  root: CodeSymbol | null;
  relationKinds: RelationKindFilter[];
  direction: TraceDirection;
  traceDepth?: TraceDepthOption;
  traceNodeLimit?: TraceNodeLimitOption;
  selectedRelationId: string | null;
  selectedEvidenceId: string | null;
  view: InvestigationView;
};

export type ApiResponse<T> = T | { projectId: string; result: T };

export type ApiErrorBody = { error: { code: string; message: string } };
