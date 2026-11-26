import { useEffect, useRef, useState, type RefObject } from 'react';
import { ApiFailure, readViewer } from '../api.ts';
import { emptySearchState, errorMessage, unwrapScoped } from '../queries.ts';
import type {
  ApiResponse,
  CatalogPage,
  ProjectContexts,
  Scope,
  SearchState,
  SessionProjection,
  SymbolPage,
  WorkspaceMetadata,
} from '../types.ts';

function mapCatalogPage(
  page: CatalogPage,
  projects: ProjectContexts,
): SearchState {
  const items = page.items.map((item) => {
    const context = projects.items.find(
      (candidate) => candidate.id === item.projectId,
    );
    if (
      !context ||
      context.status !== 'ready' ||
      context.snapshotId !== item.snapshotId ||
      item.symbol.snapshotId !== item.snapshotId
    )
      throw new ApiFailure(502, {
        error: {
          code: 'WORKSPACE_CONTEXT_MISMATCH',
          message: 'A catalog result does not match a loaded project snapshot.',
        },
      });
    return {
      projectId: context.id,
      projectLabel: context.label,
      snapshotId: item.snapshotId,
      symbol: item.symbol,
    };
  });
  return {
    items,
    offset: page.offset,
    total: page.total,
    nextOffset: page.nextOffset,
  };
}

function mapProjectSymbolPage(
  response: ApiResponse<SymbolPage>,
  scope: Scope,
  projects: ProjectContexts,
): SearchState {
  const page = unwrapScoped(response, scope);
  const context = projects.items.find((item) => item.id === scope.projectId);
  return {
    items: page.items.map((symbol) => ({
      projectId: scope.projectId,
      projectLabel: context?.label ?? scope.projectId,
      snapshotId: page.snapshotId,
      symbol,
    })),
    offset: page.offset,
    total: page.total,
    nextOffset: page.nextOffset,
  };
}

export interface UseSymbolSearchInput {
  readonly workspace: WorkspaceMetadata | null;
  readonly projects: ProjectContexts | null;
  readonly session: SessionProjection | null;
  readonly selectedProjectId: string;
  readonly scopeRef: RefObject<Scope | null>;
  readonly contextGenerationRef: RefObject<number>;
}

export function useSymbolSearch(input: UseSymbolSearchInput) {
  const [searchMode, setSearchMode] = useState<'project' | 'repository'>(
    'project',
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOffset, setSearchOffset] = useState(0);
  const [search, setSearch] = useState<SearchState>(emptySearchState);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchRetryVersion, setSearchRetryVersion] = useState(0);
  const searchGeneration = useRef(0);

  function clearSearchResults() {
    ++searchGeneration.current;
    setSearch(emptySearchState());
    setSearchError(null);
    setSearchLoading(false);
  }

  function resetSearchForProject(clearCatalog: boolean) {
    if (clearCatalog || searchMode === 'project') {
      clearSearchResults();
      setSearchOffset(0);
    }
  }

  function resetSearchForWorkspace() {
    clearSearchResults();
    setSearchQuery('');
    setSearchOffset(0);
  }

  function chooseSearchPage(offset: number) {
    if (offset === searchOffset) {
      setSearchRetryVersion((version) => version + 1);
      return;
    }
    setSearchOffset(offset);
  }

  function retrySearch() {
    setSearchRetryVersion((version) => version + 1);
  }

  useEffect(() => {
    const { workspace, projects, session, scopeRef, contextGenerationRef } =
      input;
    if (!workspace || !projects) return;
    const scope = scopeRef.current;
    if (searchMode === 'project' && (!scope || !session)) return;
    const generation = ++searchGeneration.current;
    const contextAtStart = contextGenerationRef.current;
    const timer = setTimeout(() => {
      if (generation !== searchGeneration.current) return;
      setSearchLoading(true);
      setSearchError(null);
      const read =
        searchMode === 'repository'
          ? readViewer<CatalogPage>(workspace.scanId, 'catalog', {
              query: searchQuery,
              offset: searchOffset,
            })
          : readViewer<ApiResponse<SymbolPage>>(workspace.scanId, 'symbols', {
              projectId: scope!.projectId,
              request: { query: searchQuery, offset: searchOffset },
            });
      void read
        .then((response) => {
          if (
            generation !== searchGeneration.current ||
            contextAtStart !== contextGenerationRef.current
          )
            return;
          setSearch(
            searchMode === 'repository'
              ? mapCatalogPage(response as CatalogPage, projects)
              : mapProjectSymbolPage(
                  response as ApiResponse<SymbolPage>,
                  scope!,
                  projects,
                ),
          );
        })
        .catch((error: unknown) => {
          if (
            generation === searchGeneration.current &&
            contextAtStart === contextGenerationRef.current
          )
            setSearchError(errorMessage(error));
        })
        .finally(() => {
          if (generation === searchGeneration.current) setSearchLoading(false);
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [
    input.workspace?.scanId,
    input.projects,
    input.session?.snapshotId,
    input.selectedProjectId,
    searchMode,
    searchQuery,
    searchOffset,
    searchRetryVersion,
  ]);

  useEffect(() => {
    return () => {
      ++searchGeneration.current;
    };
  }, []);

  return {
    searchMode,
    setSearchMode,
    searchQuery,
    setSearchQuery,
    searchOffset,
    setSearchOffset,
    search,
    searchLoading,
    searchError,
    clearSearchResults,
    resetSearchForProject,
    resetSearchForWorkspace,
    chooseSearchPage,
    retrySearch,
  };
}
