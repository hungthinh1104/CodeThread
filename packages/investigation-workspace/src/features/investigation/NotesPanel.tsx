import { useEffect, useRef, useState } from 'react';
import { readViewer } from './api.ts';
import { unwrapScoped, type ApiResponse } from './scoped-api.ts';
import type { AiNotesError } from './useAiNotes.ts';
import type {
  AiStatusResponse,
  AiSynthesisResponse,
  AiTaskKind,
  CodeSymbol,
  GraphProjection,
  Scope,
  SymbolPage,
} from './types.ts';

type Props = {
  hidden: boolean;
  aiStatus: AiStatusResponse;
  root: CodeSymbol | null;
  scope: Scope | null;
  graph: GraphProjection | null;
  task: AiTaskKind;
  onTaskChange: (task: AiTaskKind) => void;
  pathTarget: CodeSymbol | null;
  onPathTargetChange: (symbol: CodeSymbol | null) => void;
  pathDepth: number;
  onPathDepthChange: (depth: number) => void;
  loading: boolean;
  notes: AiSynthesisResponse | null;
  error: AiNotesError | null;
  onDraft: () => void;
  onSelectEvidence: (
    evidenceId: string,
    trigger: HTMLButtonElement,
    relationId?: string,
    verifiedFromProjection?: boolean,
  ) => void;
  onFollowSymbol: (symbol: CodeSymbol) => void;
};

const TASK_LABELS: Record<AiTaskKind, string> = {
  explain_trace: 'Trace summary',
  explain_path: 'Path walkthrough',
  explain_unknowns: 'Unknowns and gaps',
  suggest_next_steps: 'Next symbols',
};

function formatContextBounds(notes: AiSynthesisResponse): string | null {
  const parts: string[] = [];
  if (notes.context.truncated) {
    parts.push(`truncated (${notes.context.truncationReasons.join(', ')})`);
  }
  const { omitted } = notes.context;
  const dropped = [
    omitted.symbols > 0 ? `${omitted.symbols} symbols` : null,
    omitted.relations > 0 ? `${omitted.relations} relations` : null,
    omitted.excerpts > 0 ? `${omitted.excerpts} excerpts` : null,
    omitted.diagnostics > 0 ? `${omitted.diagnostics} diagnostics` : null,
  ].filter((entry): entry is string => entry !== null);
  if (dropped.length > 0) parts.push(`omitted ${dropped.join(', ')}`);
  if (notes.context.redactedExcerpts > 0) {
    parts.push(`${notes.context.redactedExcerpts} excerpt(s) redacted`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function NotesPanel(props: Props) {
  const { aiStatus, root, scope, notes, graph } = props;
  const [targetQuery, setTargetQuery] = useState('');
  const [candidates, setCandidates] = useState<CodeSymbol[]>([]);
  const [searching, setSearching] = useState(false);
  const searchGen = useRef(0);

  useEffect(() => {
    if (
      props.hidden ||
      props.task !== 'explain_path' ||
      !scope ||
      !root ||
      !aiStatus.enabled
    )
      return;
    const gen = ++searchGen.current;
    const timer = setTimeout(() => {
      if (gen !== searchGen.current) return;
      setSearching(true);
      void readViewer<ApiResponse<SymbolPage>>(scope.scanId, 'symbols', {
        projectId: scope.projectId,
        request: { query: targetQuery, offset: 0 },
      })
        .then((response) => {
          if (gen !== searchGen.current) return;
          const page = unwrapScoped(response, scope);
          setCandidates(page.items.filter((item) => item.id !== root.id));
        })
        .catch(() => {
          if (gen === searchGen.current) setCandidates([]);
        })
        .finally(() => {
          if (gen === searchGen.current) setSearching(false);
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [
    props.hidden,
    props.task,
    scope?.scanId,
    scope?.projectId,
    scope?.snapshotId,
    root?.id,
    aiStatus.enabled,
    targetQuery,
  ]);

  if (!aiStatus.enabled) return null;

  const symbolsById = new Map(
    (graph?.graph.symbols ?? []).map((sym) => [sym.id, sym] as const),
  );
  const relationsById = new Map(
    (graph?.graph.relations ?? []).map((rel) => [rel.id, rel] as const),
  );
  const evidenceById = new Map(
    (graph?.graph.evidenceRefs ?? []).map((ev) => [ev.id, ev] as const),
  );
  const filePathById = new Map<string, string>();
  for (const sym of graph?.graph.symbols ?? []) {
    filePathById.set(sym.fileId, sym.filePath);
  }

  function citationLabel(evidenceId: string): string {
    const ref = evidenceById.get(evidenceId);
    if (!ref) return `ev:${evidenceId.slice(0, 8)}`;
    const path = filePathById.get(ref.fileId);
    const base = path ? (path.split('/').at(-1) ?? path) : 'source';
    return `${base}:${ref.range.start.line}`;
  }

  const canDraft =
    Boolean(root && scope) &&
    !props.loading &&
    (props.task !== 'explain_path' || Boolean(props.pathTarget));
  const boundsNotice = notes ? formatContextBounds(notes) : null;

  return (
    <section
      id="notes-panel"
      role="tabpanel"
      aria-labelledby="notes-tab"
      hidden={props.hidden}
      tabIndex={0}
    >
      {props.hidden ? null : !root || !scope ? (
        <p className="empty-state">
          Select a symbol in Explorer to draft evidence-bound static notes.
        </p>
      ) : (
        <>
          <div className="notes-toolbar">
            <div className="notes-controls">
              <div className="filter-direction">
                <label htmlFor="ai-task-select">Focus</label>
                <select
                  id="ai-task-select"
                  value={props.task}
                  onChange={(event) =>
                    props.onTaskChange(event.currentTarget.value as AiTaskKind)
                  }
                  disabled={props.loading}
                >
                  {(Object.keys(TASK_LABELS) as AiTaskKind[]).map((kind) => (
                    <option key={kind} value={kind}>
                      {TASK_LABELS[kind]}
                    </option>
                  ))}
                </select>
              </div>
              {props.task === 'explain_path' ? (
                <div className="filter-direction">
                  <label htmlFor="ai-path-depth">Depth</label>
                  <select
                    id="ai-path-depth"
                    value={props.pathDepth}
                    onChange={(event) =>
                      props.onPathDepthChange(Number(event.currentTarget.value))
                    }
                    disabled={props.loading}
                  >
                    {[1, 2, 3, 4, 5].map((value) => (
                      <option key={value} value={value}>
                        {value} {value === 1 ? 'hop' : 'hops'}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              <button
                className="btn-primary"
                type="button"
                disabled={!canDraft}
                onClick={props.onDraft}
              >
                {props.loading ? 'Drafting…' : 'Draft notes'}
              </button>
            </div>
            <span className="notes-provider-tag">
              {aiStatus.locality === 'remote' ? 'Remote' : 'Local'} ·{' '}
              <code>{aiStatus.model}</code>
            </span>
          </div>

          {props.task === 'explain_path' ? (
            <div className="notes-path-picker">
              <label className="field-label" htmlFor="ai-path-target">
                Target symbol from {root.name}
              </label>
              <input
                id="ai-path-target"
                value={targetQuery}
                onChange={(event) => setTargetQuery(event.currentTarget.value)}
                placeholder="Filter target symbol in active project…"
                maxLength={256}
                autoComplete="off"
                disabled={props.loading}
              />
              {props.pathTarget ? (
                <p className="muted small paths-selection-note">
                  Target: <strong>{props.pathTarget.name}</strong>{' '}
                  <code>
                    {props.pathTarget.filePath}:
                    {props.pathTarget.range.start.line}
                  </code>
                </p>
              ) : null}
              {!searching && candidates.length > 0 ? (
                <ul
                  className="paths-candidate-list"
                  aria-label="Path explanation target candidates"
                >
                  {candidates.slice(0, 6).map((candidate) => {
                    const isPicked = props.pathTarget?.id === candidate.id;
                    return (
                      <li key={candidate.id}>
                        <button
                          className={`symbol-result${isPicked ? ' is-selected' : ''}`}
                          type="button"
                          aria-pressed={isPicked}
                          onClick={() => props.onPathTargetChange(candidate)}
                        >
                          <strong>{candidate.name}</strong>
                          <span>
                            {candidate.kind} · {candidate.filePath}:
                            {candidate.range.start.line}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </div>
          ) : null}

          {props.loading ? (
            <p className="status-line" role="status">
              Synthesizing and verifying citations against snapshot{' '}
              <code>{scope.snapshotId.slice(0, 8)}</code>…
            </p>
          ) : null}

          {props.error ? (
            <div className="notice error" role="alert">
              <span>
                <strong>{props.error.code}:</strong> {props.error.message}
              </span>
              {props.error.retryable ? (
                <button type="button" onClick={props.onDraft}>
                  Retry notes
                </button>
              ) : null}
            </div>
          ) : null}

          {!notes && !props.loading && !props.error ? (
            <div className="empty-workbench">
              <p className="empty-state-lead">No generated notes yet</p>
              <p className="empty-state-body">
                {aiStatus.locality === 'remote'
                  ? `Drafting sends redacted snapshot excerpts to ${aiStatus.model}. `
                  : ''}
                Every claim is checked against verified snapshot IDs before
                display. Select any citation to inspect its SHA-256 excerpt in
                Evidence.
              </p>
            </div>
          ) : null}

          {notes ? (
            <div className="notes-result">
              <div className="coverage-summary">
                <div className="coverage-status" role="status">
                  <span>Generated static notes (not proof)</span>
                  <span>
                    Verified {notes.verification.verifiedClaims} of{' '}
                    {notes.verification.verifiedClaims +
                      notes.verification.rejectedClaims}{' '}
                    claims
                  </span>
                  <code>Packet {notes.provenance.packetHash.slice(0, 12)}</code>
                </div>
              </div>

              {boundsNotice ? (
                <p className="notice warning" role="status">
                  Context bounds: {boundsNotice}.
                </p>
              ) : null}

              {notes.summary ? (
                <p className="notes-summary">{notes.summary}</p>
              ) : (
                <p className="notice warning" role="status">
                  Summary suppressed because no generated claims passed
                  deterministic citation verification.
                </p>
              )}

              {notes.claims.length > 0 ? (
                <ol className="relationship-list notes-claim-list">
                  {notes.claims.map((claim, index) => (
                    <li key={index} className="relation-row notes-claim-row">
                      <div className="relation-body">
                        <p className="notes-claim-text">{claim.text}</p>
                        <div className="notes-claim-meta">
                          {claim.relationIds.map((relId) => {
                            const rel = relationsById.get(relId);
                            if (!rel) return null;
                            return (
                              <span
                                key={relId}
                                className={`relation-kind kind-${rel.kind}`}
                              >
                                {rel.kind.toUpperCase()} ·{' '}
                                {rel.resolution.status}
                              </span>
                            );
                          })}
                          <div className="notes-citations">
                            {claim.evidenceIds.map((evId) => (
                              <button
                                key={evId}
                                className="btn-subtle notes-cite-btn"
                                type="button"
                                onClick={(event) =>
                                  props.onSelectEvidence(
                                    evId,
                                    event.currentTarget,
                                    claim.relationIds[0],
                                    true,
                                  )
                                }
                              >
                                {citationLabel(evId)}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : null}

              {notes.nextSteps.length > 0 ? (
                <section
                  className="notes-subsection"
                  aria-labelledby="notes-next-heading"
                >
                  <h3 id="notes-next-heading">Suggested next symbols</h3>
                  <ol className="relationship-list">
                    {notes.nextSteps.map((step) => {
                      const sym = symbolsById.get(step.symbolId);
                      return (
                        <li key={step.symbolId} className="relation-row">
                          <div className="relation-body">
                            <span className="relation-flow">
                              {sym ? sym.name : step.symbolId}
                            </span>
                            <span className="muted small">{step.reason}</span>
                          </div>
                          <div className="row-actions">
                            {step.supportingEvidenceIds[0] ? (
                              <button
                                className="btn-ghost"
                                type="button"
                                onClick={(event) =>
                                  props.onSelectEvidence(
                                    step.supportingEvidenceIds[0]!,
                                    event.currentTarget,
                                    undefined,
                                    true,
                                  )
                                }
                              >
                                {citationLabel(step.supportingEvidenceIds[0]!)}
                              </button>
                            ) : null}
                            {sym ? (
                              <button
                                className="btn-primary"
                                type="button"
                                onClick={() => props.onFollowSymbol(sym)}
                              >
                                Follow {sym.name}
                              </button>
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                </section>
              ) : null}

              {notes.uncertainties.length > 0 ? (
                <section
                  className="notes-subsection"
                  aria-labelledby="notes-uncertainties-heading"
                >
                  <h3 id="notes-uncertainties-heading">Noted uncertainties</h3>
                  <ul className="notes-bullet-list">
                    {notes.uncertainties.map((item, idx) => (
                      <li key={idx}>{item}</li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {notes.verification.rejectedItems.length > 0 ? (
                <details className="diagnostics">
                  <summary>
                    Rejected by verifier (
                    {notes.verification.rejectedItems.length})
                  </summary>
                  <ul>
                    {notes.verification.rejectedItems.map((item, idx) => (
                      <li key={idx}>
                        <strong>
                          {item.kind} #{item.index + 1}:
                        </strong>{' '}
                        <code>{item.reasons.join(', ')}</code>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}

              <p className="caption">{notes.disclaimer}</p>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
