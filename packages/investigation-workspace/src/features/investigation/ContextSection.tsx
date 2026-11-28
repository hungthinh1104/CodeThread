import Link from 'next/link';
import type {
  ProjectContexts,
  RepositoryItem,
  WorkspaceMetadata,
} from './types.ts';

type Props = {
  repositories: RepositoryItem[];
  selectedRepositoryId: string;
  onRepositoryChange: (id: string) => void;
  workspace: WorkspaceMetadata | null;
  projects: ProjectContexts | null;
  selectedProjectId: string;
  onProjectChange: (id: string) => void;
};

export function ContextSection(props: Props) {
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
          <div className="context-row">
            <span className="context-key">Scan</span>
            <code className="context-val">{props.workspace.scanId}</code>
          </div>
          <div className="context-row">
            <span className="context-key">Revision</span>
            <span className="context-val">{props.workspace.revision}</span>
          </div>
          <code className="context-commit">{props.workspace.commitId}</code>
        </div>
      ) : (
        <p className="muted small context-hint">
          Select a scanned repository, or register and scan one in{' '}
          <Link className="inline-link" href="/repositories">
            Repositories
          </Link>
          .
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
          {(
            [
              ['Git inventory:', props.projects.source.inventoryComplete],
              [
                'Source coverage:',
                props.projects.source.sourceCoverageComplete,
              ],
              ['Project analysis:', props.projects.source.analysisComplete],
              ['Compiler contexts:', props.projects.source.contextComplete],
            ] as const
          ).map(([label, complete]) => (
            <li
              key={label}
              className={complete ? 'check-complete' : 'check-incomplete'}
            >
              <span className="check-label">{label}</span>{' '}
              <span className="check-state">
                {complete ? 'complete' : 'incomplete'}
              </span>
            </li>
          ))}
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
