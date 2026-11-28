import Link from 'next/link';
import type {
  ScanFilesPage,
  ScanProjectRecord,
  ScanRecord,
} from '../shared/admin-api.ts';

type Props = {
  scan: ScanRecord | null;
  isActiveState: boolean;
  activeTab: 'projects' | 'files';
  onTabChange: (tab: 'projects' | 'files') => void;
  projects: ScanProjectRecord[];
  projectsLoading: boolean;
  projectsError: string | null;
  onRetryProjects: () => void;
  files: ScanFilesPage | null;
  filesOffset: number;
  filesLoading: boolean;
  filesError: string | null;
  onFilesPage: (offset: number) => void;
};

export function ScanArtifactsPanel(props: Props) {
  const { scan, isActiveState } = props;
  return (
    <main
      className="region main-region"
      aria-labelledby="scan-artifacts-heading"
    >
      <div className="main-heading pane-header">
        <div>
          <p className="step-label">02 / Scan Output</p>
          <h2 id="scan-artifacts-heading">
            Compiler contexts & input provenance
          </h2>
        </div>
        <div className="view-tabs" role="tablist" aria-label="Scan details">
          <button
            type="button"
            role="tab"
            aria-selected={props.activeTab === 'projects'}
            onClick={() => props.onTabChange('projects')}
          >
            Projects ({props.projects.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={props.activeTab === 'files'}
            onClick={() => props.onTabChange('files')}
          >
            Files ({props.files?.total ?? 0})
          </button>
        </div>
      </div>

      <div className="pane-body">
        {props.activeTab === 'projects' ? (
          <section aria-label="Compiler project contexts">
            {props.projectsLoading ? (
              <p role="status">Loading project contexts…</p>
            ) : null}
            {props.projectsError ? (
              <div className="notice error" role="alert">
                <span>{props.projectsError}</span>
                <button type="button" onClick={props.onRetryProjects}>
                  Retry projects
                </button>
              </div>
            ) : null}
            {props.projects.length ? (
              <ol className="relationship-list">
                {props.projects.map((project) => (
                  <li
                    key={project.project_id}
                    className={`relation-row ${project.status === 'ready' ? 'relation-calls' : 'relation-observation'}`}
                  >
                    <div className="relation-body">
                      <div className="relation-head">
                        <strong
                          className={`relation-resolution ${project.status === 'ready' ? 'status-exact' : 'status-uncertain'}`}
                        >
                          {project.status}
                        </strong>
                        <code className="relation-location">
                          {project.project_id}
                        </code>
                      </div>
                      <span className="relation-flow">
                        {project.project_label}
                      </span>
                      {project.snapshot_id ? (
                        <code>Snapshot {project.snapshot_id}</code>
                      ) : null}
                      {project.diagnostics.length ? (
                        <details className="diagnostics">
                          <summary>
                            Diagnostics ({project.diagnostics.length})
                          </summary>
                          <ul>
                            {project.diagnostics.map((d, index) => (
                              <li key={`${d.code}-${index}`}>
                                <strong>{d.code}</strong> {d.message}
                                {d.path ? <code>{d.path}</code> : null}
                              </li>
                            ))}
                          </ul>
                        </details>
                      ) : null}
                    </div>
                    {scan?.state === 'succeeded' &&
                    project.status === 'ready' &&
                    project.snapshot_id ? (
                      <div className="row-actions">
                        <Link
                          className="btn-link btn-primary"
                          href={`/?scanId=${scan.id}&projectId=${encodeURIComponent(project.project_id)}`}
                        >
                          Open context
                        </Link>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ol>
            ) : !props.projectsLoading && !props.projectsError ? (
              <p className="empty-state">
                {isActiveState
                  ? 'Project contexts will appear once the scan completes.'
                  : 'No project contexts were recorded for this scan.'}
              </p>
            ) : null}
          </section>
        ) : (
          <section aria-label="Pinned input files">
            {props.filesLoading ? (
              <p role="status">Loading input files…</p>
            ) : null}
            {props.filesError ? (
              <div className="notice error" role="alert">
                <span>{props.filesError}</span>
                <button
                  type="button"
                  onClick={() => props.onFilesPage(props.filesOffset)}
                >
                  Retry files
                </button>
              </div>
            ) : null}
            {props.files?.items.length ? (
              <>
                <ol className="relationship-list">
                  {props.files.items.map((file) => (
                    <li key={file.path} className="relation-row">
                      <div className="relation-body">
                        <span className="relation-flow">{file.path}</span>
                        <code>
                          mode {file.git_mode} · SHA-256{' '}
                          {file.content_hash.slice(0, 16)}… · blob{' '}
                          {file.git_blob_oid.slice(0, 12)}
                        </code>
                      </div>
                    </li>
                  ))}
                </ol>
                <nav className="pager" aria-label="Scan input file pages">
                  <button
                    type="button"
                    disabled={props.filesOffset === 0 || props.filesLoading}
                    onClick={() =>
                      props.onFilesPage(Math.max(0, props.filesOffset - 50))
                    }
                  >
                    Previous
                  </button>
                  <span>
                    {props.filesOffset + 1}–
                    {Math.min(
                      props.filesOffset + props.files.items.length,
                      props.files.total,
                    )}{' '}
                    of {props.files.total}
                  </span>
                  <button
                    type="button"
                    disabled={
                      props.files.nextOffset === null || props.filesLoading
                    }
                    onClick={() =>
                      props.onFilesPage(
                        props.files!.nextOffset ?? props.filesOffset,
                      )
                    }
                  >
                    Next
                  </button>
                </nav>
              </>
            ) : !props.filesLoading && !props.filesError ? (
              <p className="empty-state">
                {isActiveState
                  ? 'Pinned input files will appear once acquisition completes.'
                  : 'No input files were recorded for this scan.'}
              </p>
            ) : null}
          </section>
        )}
      </div>
    </main>
  );
}
