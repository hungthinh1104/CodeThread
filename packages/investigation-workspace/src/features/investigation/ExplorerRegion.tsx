import type { KeyboardEvent, PointerEvent } from 'react';
import { ContextSection } from './ContextSection.tsx';
import type {
  FilePage,
  ProjectContexts,
  RepositoryItem,
  SearchItem,
  SearchState,
  WorkspaceMetadata,
} from './types.ts';

export type ExplorerModel = {
  repositories: RepositoryItem[];
  selectedRepositoryId: string;
  selectedSymbolId: string | null;
  workspace: WorkspaceMetadata | null;
  projects: ProjectContexts | null;
  selectedProjectId: string;
  searchMode: 'project' | 'repository';
  searchQuery: string;
  searchEnabled: boolean;
  search: SearchState;
  searchLoading: boolean;
  searchError: string | null;
  files: FilePage | null;
  filesLoading: boolean;
  filesError: string | null;
  notice: string | null;
  error: string | null;
  errorRetryable: boolean;
  onRepositoryChange: (id: string) => void;
  onProjectChange: (id: string) => void;
  onSearchQueryChange: (value: string) => void;
  onSearchModeChange: (value: 'project' | 'repository') => void;
  onRetrySearch: () => void;
  onSearchPage: (offset: number) => void;
  onChooseSymbol: (item: SearchItem) => void;
  onRetryFiles: () => void;
  onFilesPage: (offset: number) => void;
  onChooseFile: (file: FilePage['items'][number]) => void;
  onRetryWorkspace: () => void;
};

type Props = {
  inert: boolean;
  collapsed: boolean;
  width: number;
  onToggleCollapse: () => void;
  onResizePointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  onResizeKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onResetWidth: () => void;
  model: ExplorerModel;
};

export function ExplorerRegion({
  inert,
  collapsed,
  width,
  onToggleCollapse,
  onResizePointerDown,
  onResizeKeyDown,
  onResetWidth,
  model,
}: Props) {
  const { search } = model;
  return (
    <aside
      className={`region explorer${collapsed ? ' is-collapsed' : ''}`}
      aria-labelledby="explorer-heading"
      inert={inert}
    >
      <div className="region-title pane-header">
        <div className="pane-header-text">
          <p className="step-label">01 / Explorer</p>
          <h2 id="explorer-heading">Pinned context</h2>
        </div>
        {collapsed ? (
          <button
            className="btn-ghost pane-rail-btn"
            type="button"
            aria-label="Expand explorer pane"
            title="Expand explorer pane"
            onClick={onToggleCollapse}
          >
            Explorer
          </button>
        ) : null}
      </div>
      <div className="pane-body" hidden={collapsed}>
        <ContextSection
          repositories={model.repositories}
          selectedRepositoryId={model.selectedRepositoryId}
          onRepositoryChange={model.onRepositoryChange}
          workspace={model.workspace}
          projects={model.projects}
          selectedProjectId={model.selectedProjectId}
          onProjectChange={model.onProjectChange}
        />

        <section className="explorer-section" aria-labelledby="search-heading">
          <div className="search-header-row">
            <h3 id="search-heading">Find a symbol</h3>
            <label className="sr-only" htmlFor="search-mode">
              Search scope
            </label>
            <select
              id="search-mode"
              className="scope-inline-select"
              value={model.searchMode}
              onChange={(event) =>
                model.onSearchModeChange(
                  event.currentTarget.value as 'project' | 'repository',
                )
              }
              disabled={!model.searchEnabled}
            >
              <option value="project">Selected project</option>
              <option value="repository">Repository catalog</option>
            </select>
          </div>
          <label className="field-label" htmlFor="symbol-query">
            Name or source path
          </label>
          <div className="search-input-wrap">
            <input
              id="symbol-query"
              value={model.searchQuery}
              onChange={(event) =>
                model.onSearchQueryChange(event.currentTarget.value)
              }
              maxLength={256}
              autoComplete="off"
              disabled={!model.searchEnabled}
            />
            {model.searchEnabled && model.searchQuery.length > 0 ? (
              <button
                className="search-clear"
                type="button"
                aria-label="Clear symbol search"
                onClick={() => {
                  model.onSearchQueryChange('');
                  document.getElementById('symbol-query')?.focus();
                }}
              >
                Clear
              </button>
            ) : null}
          </div>
          <div className="result-heading" aria-live="polite">
            {model.searchLoading
              ? 'Searching the pinned snapshot…'
              : model.searchError
                ? 'Symbol search failed'
                : !model.searchEnabled
                  ? 'Select a project context to search'
                  : `${search.total} matching symbols`}
          </div>
          {model.searchError ? (
            <div className="notice error" role="alert">
              <span>{model.searchError}</span>
              <button type="button" onClick={model.onRetrySearch}>
                Retry symbol search
              </button>
            </div>
          ) : null}
          {search.items.length ? (
            <ul className="result-list">
              {search.items.map((item) => {
                const isSelected = model.selectedSymbolId === item.symbol.id;
                return (
                  <li key={`${item.projectId}:${item.symbol.id}`}>
                    <button
                      className={`symbol-result${isSelected ? ' is-selected' : ''}`}
                      type="button"
                      aria-current={isSelected ? 'true' : undefined}
                      onClick={() => model.onChooseSymbol(item)}
                    >
                      <strong>{item.symbol.name}</strong>
                      <span>
                        {item.symbol.kind} · {item.projectLabel}
                      </span>
                      <code>
                        {item.symbol.filePath}:{item.symbol.range.start.line}:
                        {item.symbol.range.start.column}
                      </code>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : model.searchEnabled &&
            !model.searchLoading &&
            !model.searchError ? (
            <p className="muted small">No symbols on this page match.</p>
          ) : null}
          {model.searchEnabled || search.total > 0 || search.offset > 0 ? (
            <nav className="pager" aria-label="Symbol search pages">
              <button
                type="button"
                onClick={() =>
                  model.onSearchPage(Math.max(0, search.offset - 50))
                }
                disabled={search.offset === 0 || model.searchLoading}
              >
                Previous
              </button>
              <span>
                {search.total === 0
                  ? '0 results'
                  : `${search.offset + 1}–${Math.min(search.offset + search.items.length, search.total)} of ${search.total}`}
              </span>
              <button
                type="button"
                onClick={() =>
                  model.onSearchPage(search.nextOffset ?? search.offset)
                }
                disabled={search.nextOffset === null || model.searchLoading}
              >
                Next
              </button>
            </nav>
          ) : null}
        </section>

        <section className="explorer-section" aria-labelledby="files-heading">
          <div className="section-heading-row">
            <h3 id="files-heading">Source inventory</h3>
            {model.files ? <span>{model.files.total} files</span> : null}
          </div>
          {model.filesLoading ? (
            <p role="status">Loading file inventory…</p>
          ) : null}
          {model.filesError ? (
            <div className="notice error" role="alert">
              <span>
                {model.filesError}
                {model.files ? ' Showing the previously loaded page.' : ''}
              </span>
              <button type="button" onClick={model.onRetryFiles}>
                Retry file inventory
              </button>
            </div>
          ) : null}
          {model.files?.items.length ? (
            <ul className="file-list">
              {model.files.items.map((file) => (
                <li key={file.path}>
                  <button
                    type="button"
                    onClick={() => model.onChooseFile(file)}
                  >
                    <code>{file.path}</code>
                    <span className={`status-text status-${file.status}`}>
                      {file.status.replace('_', ' ')}
                    </span>
                    {file.analysisReason ? (
                      <span>{file.analysisReason}</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : model.files && !model.files.items.length ? (
            <p className="muted small">
              No files are present in this inventory.
            </p>
          ) : null}
          {model.files ? (
            <nav className="pager" aria-label="Source inventory pages">
              <button
                type="button"
                onClick={() =>
                  model.onFilesPage(Math.max(0, model.files!.offset - 50))
                }
                disabled={model.files.offset === 0 || model.filesLoading}
              >
                Previous
              </button>
              <span>
                {model.files.total === 0
                  ? '0 inventory entries'
                  : `${model.files.offset + 1}–${Math.min(model.files.offset + model.files.items.length, model.files.total)} of ${model.files.total}`}
              </span>
              <button
                type="button"
                onClick={() =>
                  model.onFilesPage(
                    model.files!.nextOffset ?? model.files!.offset,
                  )
                }
                disabled={model.files.nextOffset === null || model.filesLoading}
              >
                Next
              </button>
            </nav>
          ) : null}
          <p className="muted small">
            The inventory lists source status and hashes. Full-file content is
            not available in this API; select a symbol for verified excerpts.
          </p>
        </section>
        {model.notice ? (
          <p className="notice" role="status">
            {model.notice}
          </p>
        ) : null}
        {model.error ? (
          <div className="notice error" role="alert">
            <span>{model.error}</span>
            {model.errorRetryable ? (
              <button type="button" onClick={model.onRetryWorkspace}>
                Retry workspace request
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {!collapsed ? (
        <div
          className="pane-resizer resizer-right"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize explorer pane"
          aria-valuenow={width}
          aria-valuemin={210}
          aria-valuemax={440}
          tabIndex={0}
          title="Drag to resize explorer (double-click to reset)"
          onPointerDown={onResizePointerDown}
          onKeyDown={onResizeKeyDown}
          onDoubleClick={onResetWidth}
        />
      ) : null}
    </aside>
  );
}
