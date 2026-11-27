import { CodeExcerpt } from './CodeExcerpt.tsx';
import type {
  CodeSymbol,
  EvidenceProjection,
  FollowContextProjection,
} from './types.ts';

type Props = {
  hidden: boolean;
  root: CodeSymbol | null;
  evidence: EvidenceProjection['items'][number] | null;
  evidenceLoading: boolean;
  evidenceError: string | null;
  onRetryEvidence: () => void;
  onSelectEvidence: (
    id: string,
    trigger: HTMLButtonElement,
    relationId?: string,
  ) => void;
  contextCandidates: FollowContextProjection['candidates'];
  contextSearchLoading: boolean;
  contextSearchMessage: string | null;
  onFindContexts: () => void;
  onChooseContext: (
    candidate: FollowContextProjection['candidates'][number],
  ) => void;
};

export function SourcePanel(props: Props) {
  const { root, evidence } = props;
  const declaration =
    root &&
    evidence &&
    (evidence.status === 'available'
      ? evidence.evidence.id === root.declarationEvidenceId &&
        evidence.evidence.snapshotId === root.snapshotId
      : evidence.evidenceId === root.declarationEvidenceId)
      ? evidence
      : null;

  return (
    <section
      id="source-panel"
      role="tabpanel"
      aria-labelledby="source-tab"
      hidden={props.hidden}
      tabIndex={0}
    >
      {!root ? (
        <div className="empty-workbench">
          <p className="empty-state-lead">
            Select a symbol from the pinned catalog.
          </p>
          <ol className="empty-steps">
            <li>
              <strong>Establish context</strong> — pick a repository scan and
              compiler project in Explorer.
            </li>
            <li>
              <strong>Inspect declaration</strong> — review the pinned source
              excerpt and SHA-256 provenance.
            </li>
            <li>
              <strong>Trace relationships</strong> — switch to Trace for exact{' '}
              <code>CALLS</code> and <code>REFERENCES</code>.
            </li>
          </ol>
        </div>
      ) : null}
      {root && props.evidenceLoading ? (
        <p className="status-line" role="status">
          Loading verified source evidence…
        </p>
      ) : null}
      {root && props.evidenceError ? (
        <div className="notice error" role="alert">
          <span>{props.evidenceError}</span>
          <button type="button" onClick={props.onRetryEvidence}>
            Retry evidence
          </button>
        </div>
      ) : null}
      {root && declaration?.status === 'available' ? (
        <div className="source-excerpt code-frame">
          <div className="code-frame-header">
            <div className="code-frame-title">
              <h3>Verified declaration excerpt</h3>
              <code className="code-frame-path">
                {declaration.filePath}:{declaration.evidence.range.start.line}
              </code>
            </div>
            <button
              id="inspect-declaration-evidence"
              className="btn-subtle"
              type="button"
              onClick={(event) =>
                props.onSelectEvidence(
                  root.declarationEvidenceId,
                  event.currentTarget,
                )
              }
            >
              Inspect evidence
            </button>
          </div>
          <CodeExcerpt
            text={declaration.text}
            startLine={declaration.evidence.range.start.line}
          />
          <div className="code-frame-footer">
            <code className="hash">
              SHA-256 {declaration.evidence.contentHash}
            </code>
            <span className="caption">
              Exact verified excerpt from snapshot {root.snapshotId}; not the
              complete file.
            </span>
          </div>
        </div>
      ) : null}
      {root && declaration?.status === 'unavailable' ? (
        <p className="notice warning" role="status">
          Declaration evidence unavailable: {declaration.code}. Mutable worktree
          source was not used.
        </p>
      ) : null}
      {root ? (
        <section
          className="context-matches"
          aria-labelledby="context-matches-heading"
        >
          <h3 id="context-matches-heading">
            Compiler contexts for this declaration
          </h3>
          <p className="muted small">
            Compare the same verified path, range, and source identity across
            project snapshots.
          </p>
          <button
            type="button"
            onClick={props.onFindContexts}
            disabled={props.contextSearchLoading}
          >
            {props.contextSearchLoading
              ? 'Checking contexts…'
              : 'Find matching project contexts'}
          </button>
          {props.contextSearchMessage ? (
            <p role="status">{props.contextSearchMessage}</p>
          ) : null}
          {props.contextCandidates.length ? (
            <ul className="context-candidate-list">
              {props.contextCandidates.map((candidate) => (
                <li key={`${candidate.projectId}:${candidate.snapshotId}`}>
                  <button
                    type="button"
                    onClick={() => props.onChooseContext(candidate)}
                  >
                    Open {candidate.projectLabel} · snapshot{' '}
                    {candidate.snapshotId}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}
