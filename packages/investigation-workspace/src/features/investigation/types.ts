import type { infer as Infer } from 'zod';
import type {
  AiStatusResponse,
  AiSynthesisResponse,
  AiSynthesizeApiRequest,
  AiTaskKind,
  FindSymbolPathsRequest,
  FindSymbolPathsResponse,
  viewerApiResponseSchemas,
} from '@codethread/contracts';

export type {
  AiStatusResponse,
  AiSynthesisResponse,
  AiSynthesizeApiRequest,
  AiTaskKind,
  FindSymbolPathsRequest,
  FindSymbolPathsResponse,
};

type ProjectResult<T> = T extends { projectId: string; result: infer Result }
  ? Result
  : T;

export type Scope = {
  scanId: string;
  projectId: string;
  snapshotId: string;
};

export type RelationKindFilter = 'calls' | 'references';
export type TraceDirection = 'outgoing' | 'incoming' | 'both';
export type InvestigationView = 'source' | 'trace';

export type WorkspaceMetadata = {
  repositoryId: string;
  scanId: string;
  commitId: string;
  revision: string;
  expiresAt: string;
};

export type RepositoryItem = {
  id: string;
  label: string;
  activeScanId: string | null;
  generation: string;
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
  selectedRelationId: string | null;
  selectedEvidenceId: string | null;
  view: InvestigationView;
};

export type ApiResponse<T> = T | { projectId: string; result: T };

export type ApiErrorBody = { error: { code: string; message: string } };
