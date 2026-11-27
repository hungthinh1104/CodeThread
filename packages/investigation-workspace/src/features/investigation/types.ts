import type { infer as Infer } from 'zod';
import type { viewerApiResponseSchemas } from '@codethread/contracts';

type ProjectResult<T> = T extends { projectId: string; result: infer Result }
  ? Result
  : T;

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
export type FollowContextProjection = ProjectResult<
  Infer<(typeof viewerApiResponseSchemas)['/api/follow-context']>
>;
export type CatalogItem = CatalogPage['items'][number];

export type ApiErrorBody = { error: { code: string; message: string } };

export type Scope = {
  scanId: string;
  projectId: string;
  snapshotId: string;
};

export type SearchItem = {
  projectId: string;
  projectLabel: string;
  snapshotId: string;
  symbol: CatalogPage['items'][number]['symbol'];
};

export type SearchState = {
  items: SearchItem[];
  offset: number;
  total: number;
  nextOffset: number | null;
};

export type EvidenceRole = 'declaration' | 'occurrence' | 'observation';
