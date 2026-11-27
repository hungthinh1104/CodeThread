import { useEffect, useRef, useState, type RefObject } from 'react';
import { ApiFailure, readViewer } from './api.ts';
import {
  emptySearchState,
  errorMessage,
  unwrapScoped,
  type ApiResponse,
} from './scoped-api.ts';
import type {
  CatalogPage,
  FilePage,
  ProjectContexts,
  Scope,
  SearchState,
  SessionProjection,
  SymbolPage,
  WorkspaceMetadata,
} from './types.ts';

type ExplorerDataInput = {
  workspace: WorkspaceMetadata | null;
  projects: ProjectContexts | null;
  session: SessionProjection | null;
  selectedProjectId: string;
  scopeRef: RefObject<Scope | null>;
  contextGenerationRef: RefObject<number>;
};

export function useExplorerData({
  workspace,
  projects,
  session,
  selectedProjectId,
  scopeRef,
  contextGenerationRef,
}: ExplorerDataInput) {
  const [searchMode, setSearchMode] = useState<'project' | 'repository'>(
    'project',
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOffset, setSearchOffset] = useState(0);
  const [search, setSearch] = useState<SearchState>(emptySearchState);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchRetryVersion, setSearchRetryVersion] = useState(0);
  const [files, setFiles] = useState<FilePage | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<{
    offset: number;
    message: string;
  } | null>(null);
  const searchGeneration = useRef(0);
  const fileGeneration = useRef(0);

  function clearSearchResults() {
    ++searchGeneration.current;
    setSearch(emptySearchState());
    setSearchError(null);
    setSearchLoading(false);
  }

  function resetForProject(clearCatalog: boolean) {
    if (clearCatalog || searchMode === 'project') {
      clearSearchResults();
      setSearchOffset(0);
    }
  }

  function resetForWorkspace() {
    ++fileGeneration.current;
    clearSearchResults();
    setSearchQuery('');
    setSearchOffset(0);
    setFiles(null);
    setFilesLoading(false);
    setFilesError(null);
  }

  function invalidateAll() {
    ++searchGeneration.current;
    ++fileGeneration.current;
  }

  function updateSearchQuery(value: string) {
    setSearchQuery(value);
    setSearchOffset(0);
    clearSearchResults();
  }

  function updateSearchMode(value: 'project' | 'repository') {
    setSearchMode(value);
    setSearchOffset(0);
    clearSearchResults();
  }

  function filterByFilePath(path: string) {
    setSearchMode('project');
    setSearchOffset(0);
    setSearchQuery(path.length > 256 ? path.slice(-256) : path);
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

  async function chooseFilesPage(offset: number) {
    if (!workspace) return;
    const generation = ++fileGeneration.current;
    setFilesLoading(true);
    setFilesError(null);
    try {
      const page = await readViewer<FilePage>(workspace.scanId, 'files', {
        offset,
      });
      if (generation === fileGeneration.current) {
        setFiles(page);
        setFilesError(null);
      }
    } catch (error) {
      if (generation === fileGeneration.current)
        setFilesError({ offset, message: errorMessage(error) });
    } finally {
      if (generation === fileGeneration.current) setFilesLoading(false);
    }
  }

  function retryFiles() {
    if (filesError) void chooseFilesPage(filesError.offset);
  }

  useEffect(() => {
    if (!workspace) return;
    const generation = ++fileGeneration.current;
    const workspaceId = workspace.scanId;
    setFilesLoading(true);
    setFilesError(null);
    void readViewer<FilePage>(workspaceId, 'files', { offset: 0 })
      .then((page) => {
        if (
          generation === fileGeneration.current &&
          workspaceId === workspace.scanId
        )
          setFiles(page);
      })
      .catch((error: unknown) => {
        if (generation === fileGeneration.current)
          setFilesError({ offset: 0, message: errorMessage(error) });
      })
      .finally(() => {
        if (generation === fileGeneration.current) setFilesLoading(false);
      });
  }, [workspace?.scanId]);

  useEffect(() => {
    if (!workspace || !projects) return;
    const scope = scopeRef.current;
    if (searchMode === 'project' && (!scope || !session)) return;
    const generation = ++searchGeneration.current;
    const contextGenerationAtStart = contextGenerationRef.current;
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
            contextGenerationAtStart !== contextGenerationRef.current
          )
            return;
          if (searchMode === 'repository') {
            const page = response as CatalogPage;
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
                    message:
                      'A catalog result does not match a loaded project snapshot.',
                  },
                });
              return {
                projectId: context.id,
                projectLabel: context.label,
                snapshotId: item.snapshotId,
                symbol: item.symbol,
              };
            });
            setSearch({
              items,
              offset: page.offset,
              total: page.total,
              nextOffset: page.nextOffset,
            });
          } else {
            const page = unwrapScoped(
              response as ApiResponse<SymbolPage>,
              scope!,
            );
            const context = projects.items.find(
              (item) => item.id === scope!.projectId,
            );
            setSearch({
              items: page.items.map((symbol) => ({
                projectId: scope!.projectId,
                projectLabel: context?.label ?? scope!.projectId,
                snapshotId: page.snapshotId,
                symbol,
              })),
              offset: page.offset,
              total: page.total,
              nextOffset: page.nextOffset,
            });
          }
        })
        .catch((error: unknown) => {
          if (
            generation === searchGeneration.current &&
            contextGenerationAtStart === contextGenerationRef.current
          )
            setSearchError(errorMessage(error));
        })
        .finally(() => {
          if (generation === searchGeneration.current) setSearchLoading(false);
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [
    workspace?.scanId,
    projects,
    session?.snapshotId,
    selectedProjectId,
    searchMode,
    searchQuery,
    searchOffset,
    searchRetryVersion,
  ]);

  return {
    searchMode,
    searchQuery,
    search,
    searchLoading,
    searchError,
    files,
    filesLoading,
    filesError,
    updateSearchQuery,
    updateSearchMode,
    filterByFilePath,
    chooseSearchPage,
    retrySearch,
    chooseFilesPage,
    retryFiles,
    resetForProject,
    resetForWorkspace,
    invalidateAll,
  };
}
