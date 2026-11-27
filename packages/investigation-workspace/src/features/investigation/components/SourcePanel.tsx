import { useState } from 'react';
import type {
  CodeSymbol,
  EvidenceItem,
  FollowContextProjection,
} from '../types.ts';

type Props = {
  active: boolean;
  root: CodeSymbol | null;
  evidence: EvidenceItem | null;
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
  const [copiedAnchor, setCopiedAnchor] = useState<string | null>(null);
  const root = props.root;
  const item = props.evidence;
  const declaration =
    root &&
    item &&
    (item.status === 'available'
      ? item.evidence.id === root.declarationEvidenceId &&
        item.evidence.snapshotId === root.snapshotId
      : item.evidenceId === root.declarationEvidenceId)
      ? item
      : null;

  const anchor =
    declaration?.status === 'available'
      ? `${declaration.filePath}:${declaration.evidence.range.start.line}:${declaration.evidence.range.start.column}`
      : null;

  function copyAnchor() {
    if (!anchor) return;
    void navigator.clipboard?.writeText(anchor).then(
      () => setCopiedAnchor(anchor),
      () => {},
    );
  }

  return (
    <section
      id="source-panel"
      role="tabpanel"
      aria-labelledby="source-tab"
      hidden={!props.active}
      tabIndex={0}
    >
      {!root ? (
        <p className="empty-state">Select a symbol from the pinned catalog.</p>
      ) : null}
      {root && props.evidenceLoading ? (
        <p role="status">Loading verified source evidence…</p>
      ) : null}
      {root && props.evidenceError ? (
        <p className="notice error" role="alert">
          {props.evidenceError}{' '}
          <button type="button" onClick={props.onRetryEvidence}>
            Retry evidence
          </button>
        </p>
      ) : null}
      {root && declaration?.status === 'available' ? (
        <div className="source-excerpt">
          <div className="section-heading-row">
            <h3>Verified declaration excerpt</h3>
            <div className="row-actions source-actions">
              <button type="button" onClick={copyAnchor}>
                {copiedAnchor === anchor ? 'Copied location' : 'Copy location'}
              </button>
              <button
                id="inspect-declaration-evidence"
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
          </div>
          <p className="muted small">
            {declaration.filePath} · lines{' '}
            {declaration.evidence.range.start.line}–
            {declaration.evidence.range.end.line} (col{' '}
            {declaration.evidence.range.start.column}–
            {declaration.evidence.range.end.column}) · SHA-256{' '}
            {declaration.evidence.contentHash}
          </p>
          <pre className="evidence-text">{declaration.text}</pre>
          <p className="caption">
            Exact verified excerpt from snapshot {root.snapshotId}; not the
            complete file.
          </p>
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
