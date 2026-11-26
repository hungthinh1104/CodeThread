import type {
  FilePage,
  ProjectContexts,
  RepositoryItem,
  SearchItem,
  WorkspaceMetadata,
} from '../types.ts';

type Props = {
  inert: boolean;
  repositories: RepositoryItem[];
  selectedRepositoryId: string;
  onRepositoryChange: (id: string) => void;
  workspace: WorkspaceMetadata | null;
  projects: ProjectContexts | null;
  selectedProjectId: string;
  onProjectChange: (id: string) => void;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  searchMode: 'project' | 'repository';
  searchEnabled: boolean;
  onSearchModeChange: (value: 'project' | 'repository') => void;
  searchItems: SearchItem[];
  searchOffset: number;
  searchTotal: number;
  searchNextOffset: number | null;
  searchLoading: boolean;
  searchError: string | null;
  onRetrySearch: () => void;
  onSearchPage: (offset: number) => void;
  onChooseSymbol: (item: SearchItem) => void;
  files: FilePage | null;
  filesLoading: boolean;
  filesError: string | null;
  onRetryFiles: () => void;
  onFilesPage: (offset: number) => void;
  onChooseFile: (file: FilePage['items'][number]) => void;
  notice?: string | null;
  error: string | null;
  errorRetryable: boolean;
  onRetryWorkspace: () => void;
};

function ExplorerContextSection(props: Props) {
  const project = props.projects?.items.find(
    (item) => item.id === props.selectedProjectId,
  );
  const unavailableProjects =
    props.projects?.items.filter(
      (item) => item.status !== 'ready' || item.snapshotId === null,
    ) ?? [];
  return (
    <>
      <label className="field-label" htmlFor="repository-select">
        Repository and scan
      </label>
      <select
        id="repository-select"
        value={props.selectedRepositoryId}
        onChange={(event) =>
          props.onRepositoryChange(event.currentTarget.value)
        }
      >
        <option value="">Choose a repository</option>
        {props.repositories.map((repository) => (
          <option key={repository.id} value={repository.id}>
            {repository.label}
            {repository.activeScanId ? '' : ' — no scan'}
          </option>
        ))}
      </select>
      {props.workspace ? (
        <div className="context-summary">
          <span>Scan {props.workspace.scanId}</span>
          <span>Revision {props.workspace.revision}</span>
          <code>{props.workspace.commitId}</code>
        </div>
      ) : (
        <p className="muted small">
          Choose a repository with a completed local scan. Scan creation stays
          in the existing backend workflow.
        </p>
      )}

      <label className="field-label" htmlFor="project-select">
        Project context
      </label>
      <select
        id="project-select"
        value={props.selectedProjectId}
        onChange={(event) => props.onProjectChange(event.currentTarget.value)}
        disabled={!props.projects}
      >
        <option value="">Choose a project context</option>
        {props.projects?.items.map((item) => (
          <option
            key={item.id}
            value={item.id}
            disabled={item.status !== 'ready' || item.snapshotId === null}
          >
            {item.label} — {item.status}
            {item.diagnosticCount > 0
              ? ` (${item.diagnosticCount} diagnostics)`
              : ''}
          </option>
        ))}
      </select>
      {project && project.status !== 'ready' ? (
        <p className="notice warning" role="status">
          This context is {project.status} and cannot provide a graph snapshot.
          {project.diagnostics[0]
            ? ` ${project.diagnostics[0].code}: ${project.diagnostics[0].message}`
            : ''}
        </p>
      ) : null}
      {unavailableProjects.length ? (
        <details className="diagnostics">
          <summary>
            Unavailable project contexts ({unavailableProjects.length})
          </summary>
          <ul>
            {unavailableProjects.map((item) => (
              <li key={item.id}>
                <strong>{item.label}</strong> — {item.status}
                {item.snapshotId ? (
                  <code>Snapshot {item.snapshotId}</code>
                ) : null}
                {item.diagnostics.map((diagnostic, index) => (
                  <span key={`${diagnostic.code}-${index}`}>
                    <code>{diagnostic.code}</code> {diagnostic.message}
                    {diagnostic.path ? <code>{diagnostic.path}</code> : null}
                  </span>
                ))}
                {!item.diagnostics.length ? (
                  <span>
                    No detailed diagnostic was returned for this context.
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {props.projects?.source ? (
        <ul className="coverage-checks" aria-label="Repository completeness">
          <li>
            Git inventory:{' '}
            {props.projects.source.inventoryComplete
              ? 'complete'
              : 'incomplete'}
          </li>
          <li>
            Source coverage:{' '}
            {props.projects.source.sourceCoverageComplete
              ? 'complete'
              : 'incomplete'}
          </li>
          <li>
            Project analysis:{' '}
            {props.projects.source.analysisComplete ? 'complete' : 'incomplete'}
          </li>
          <li>
            Compiler contexts:{' '}
            {props.projects.source.contextComplete ? 'complete' : 'incomplete'}
          </li>
        </ul>
      ) : null}
      {props.projects?.source?.diagnostics.length ? (
        <details className="diagnostics">
          <summary>
            Repository diagnostics ({props.projects.source.diagnostics.length})
          </summary>
          <ul>
            {props.projects.source.diagnostics.map((item, index) => (
              <li key={`${item.code}-${index}`}>
                <strong>{item.code}</strong> {item.message}
                {item.path ? <code>{item.path}</code> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}

function SymbolSearchSection(props: Props) {
  return (
    <section className="explorer-section" aria-labelledby="search-heading">
      <h3 id="search-heading">Find a symbol</h3>
      <label className="field-label" htmlFor="search-mode">
        Search scope
      </label>
      <select
        id="search-mode"
        value={props.searchMode}
        onChange={(event) =>
          props.onSearchModeChange(
            event.currentTarget.value as 'project' | 'repository',
          )
        }
        disabled={!props.searchEnabled}
      >
        <option value="project">Selected project</option>
        <option value="repository">Repository catalog</option>
      </select>
      <label className="field-label" htmlFor="symbol-query">
        Name or source path
      </label>
      <input
        id="symbol-query"
        value={props.searchQuery}
        onChange={(event) =>
          props.onSearchQueryChange(event.currentTarget.value)
        }
        maxLength={256}
        autoComplete="off"
        disabled={!props.searchEnabled}
      />
      <div className="result-heading" aria-live="polite">
        {props.searchLoading
          ? 'Searching the pinned snapshot…'
          : props.searchError
            ? 'Symbol search failed'
            : !props.searchEnabled
              ? 'Select a project context to search'
              : `${props.searchTotal} matching symbols`}
      </div>
      {props.searchError ? (
        <p className="notice error" role="alert">
          {props.searchError}{' '}
          <button type="button" onClick={props.onRetrySearch}>
            Retry symbol search
          </button>
        </p>
      ) : null}
      {props.searchItems.length ? (
        <ul className="result-list">
          {props.searchItems.map((item) => (
            <li key={`${item.projectId}:${item.symbol.id}`}>
              <button
                className="symbol-result"
                type="button"
                onClick={() => props.onChooseSymbol(item)}
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
          ))}
        </ul>
      ) : props.searchEnabled && !props.searchLoading && !props.searchError ? (
        <p className="muted small">No symbols on this page match.</p>
      ) : null}
      <nav className="pager" aria-label="Symbol search pages">
        <button
          type="button"
          onClick={() =>
            props.onSearchPage(Math.max(0, props.searchOffset - 50))
          }
          disabled={props.searchOffset === 0 || props.searchLoading}
        >
          Previous
        </button>
        <span>
          {props.searchTotal === 0
            ? '0 results'
            : `${props.searchOffset + 1}–${Math.min(props.searchOffset + props.searchItems.length, props.searchTotal)} of ${props.searchTotal}`}
        </span>
        <button
          type="button"
          onClick={() =>
            props.onSearchPage(props.searchNextOffset ?? props.searchOffset)
          }
          disabled={props.searchNextOffset === null || props.searchLoading}
        >
          Next
        </button>
      </nav>
    </section>
  );
}

function FileInventorySection(props: Props) {
  return (
    <section className="explorer-section" aria-labelledby="files-heading">
      <div className="section-heading-row">
        <h3 id="files-heading">Source inventory</h3>
        {props.files ? <span>{props.files.total} files</span> : null}
      </div>
      {props.filesLoading ? <p role="status">Loading file inventory…</p> : null}
      {props.filesError ? (
        <p className="notice error" role="alert">
          {props.filesError}{' '}
          {props.files ? 'Showing the previously loaded page. ' : null}
          <button type="button" onClick={props.onRetryFiles}>
            Retry file inventory
          </button>
        </p>
      ) : null}
      {props.files?.items.length ? (
        <ul className="file-list">
          {props.files.items.map((file) => (
            <li key={file.path}>
              <button type="button" onClick={() => props.onChooseFile(file)}>
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
      ) : props.files && !props.files.items.length ? (
        <p className="muted small">No files are present in this inventory.</p>
      ) : null}
      {props.files ? (
        <nav className="pager" aria-label="Source inventory pages">
          <button
            type="button"
            onClick={() =>
              props.onFilesPage(Math.max(0, props.files!.offset - 50))
            }
            disabled={props.files.offset === 0 || props.filesLoading}
          >
            Previous
          </button>
          <span>
            {props.files.total === 0
              ? '0 inventory entries'
              : `${props.files.offset + 1}–${Math.min(props.files.offset + props.files.items.length, props.files.total)} of ${props.files.total}`}
          </span>
          <button
            type="button"
            onClick={() =>
              props.onFilesPage(props.files!.nextOffset ?? props.files!.offset)
            }
            disabled={props.files.nextOffset === null || props.filesLoading}
          >
            Next
          </button>
        </nav>
      ) : null}
      <p className="muted small">
        The inventory lists source status and hashes. Full-file content is not
        available in this API; select a symbol for verified excerpts.
      </p>
    </section>
  );
}

export function ExplorerRegion(props: Props) {
  return (
    <aside
      className="region explorer"
      aria-labelledby="explorer-heading"
      inert={props.inert}
    >
      <div className="region-title">
        <p className="step-label">01 / Explorer</p>
        <h2 id="explorer-heading">Pinned context</h2>
      </div>
      <ExplorerContextSection {...props} />
      <SymbolSearchSection {...props} />
      <FileInventorySection {...props} />
      {props.notice ? (
        <p className="notice" role="status">
          {props.notice}
        </p>
      ) : null}
      {props.error ? (
        <p className="notice error" role="alert">
          {props.error}{' '}
          {props.errorRetryable ? (
            <button type="button" onClick={props.onRetryWorkspace}>
              Retry workspace request
            </button>
          ) : null}
        </p>
      ) : null}
    </aside>
  );
}
