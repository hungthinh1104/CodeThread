import type { AiNotesError } from '../hooks/useAiNotes.ts';
import type {
  AiStatusResponse,
  AiSynthesisResponse,
  AiTaskKind,
  CodeSymbol,
  GraphProjection,
} from '../types.ts';

type Props = {
  aiStatus: AiStatusResponse;
  task: AiTaskKind;
  onTaskChange: (task: AiTaskKind) => void;
  canDraft: boolean;
  loading: boolean;
  notes: AiSynthesisResponse | null;
  error: AiNotesError | null;
  onDraft: () => void;
  graph: GraphProjection | null;
  onSelectEvidence: (
    evidenceId: string,
    trigger: HTMLButtonElement,
    relationId?: string | null,
  ) => void;
  onFollowSymbol: (symbol: CodeSymbol) => void;
};

function formatOmittedSummary(notes: AiSynthesisResponse): string | null {
  const parts: string[] = [];
  if (notes.context.truncated) {
    parts.push(
      `projection truncated (${notes.context.truncationReasons.join(', ')})`,
    );
  }
  const { omitted } = notes.context;
  const dropped = [
    omitted.symbols > 0 ? `${omitted.symbols} symbols` : null,
    omitted.relations > 0 ? `${omitted.relations} relations` : null,
    omitted.excerpts > 0 ? `${omitted.excerpts} excerpts` : null,
    omitted.diagnostics > 0 ? `${omitted.diagnostics} diagnostics` : null,
  ].filter((entry): entry is string => entry !== null);
  if (dropped.length > 0) {
    parts.push(`packet omitted ${dropped.join(', ')}`);
  }
  if (notes.context.redactedExcerpts > 0) {
    parts.push(
      `${notes.context.redactedExcerpts} excerpt(s) redacted before synthesis`,
    );
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

function GeneratedNotesBody(props: {
  notes: AiSynthesisResponse;
  graph: GraphProjection | null;
  onSelectEvidence: Props['onSelectEvidence'];
  onFollowSymbol: Props['onFollowSymbol'];
}) {
  const { notes } = props;
  const symbolsById = new Map(
    (props.graph?.graph.symbols ?? []).map((sym) => [sym.id, sym] as const),
  );
  const relationsById = new Map(
    (props.graph?.graph.relations ?? []).map((rel) => [rel.id, rel] as const),
  );
  const evidenceById = new Map(
    (props.graph?.graph.evidenceRefs ?? []).map((ev) => [ev.id, ev] as const),
  );
  const filePathById = new Map<string, string>();
  for (const sym of props.graph?.graph.symbols ?? []) {
    filePathById.set(sym.fileId, sym.filePath);
  }
  function evidenceLabel(evidenceId: string): string {
    const ref = evidenceById.get(evidenceId);
    if (!ref) return `evidence:${evidenceId.slice(0, 8)}`;
    const path = filePathById.get(ref.fileId);
    const base = path ? (path.split('/').at(-1) ?? path) : 'source';
    return `${base}:${ref.range.start.line}`;
  }
  const contextNotice = formatOmittedSummary(notes);

  return (
    <div className="ai-notes-body">
      <p className="caption">{notes.disclaimer}</p>
      <p className="ai-meta">
        <code>Packet {notes.provenance.packetHash.slice(0, 12)}…</code>
        <span>
          Citations verified: {notes.verification.verifiedClaims} of{' '}
          {notes.verification.verifiedClaims +
            notes.verification.rejectedClaims}{' '}
          claims
        </span>
      </p>
      {contextNotice ? (
        <p className="notice warning" role="status">
          Context bounds: {contextNotice}.
        </p>
      ) : null}
      {notes.summary ? (
        <p className="ai-summary">{notes.summary}</p>
      ) : notes.verification.rejectedClaims > 0 ? (
        <p className="notice warning" role="status">
          All generated claims failed deterministic verification and were
          withheld.
        </p>
      ) : null}

      {notes.claims.length > 0 ? (
        <ol className="ai-claim-list">
          {notes.claims.map((claim, index) => {
            const realRelations = claim.relationIds
              .map((id) => relationsById.get(id))
              .filter(
                (rel): rel is NonNullable<typeof rel> => rel !== undefined,
              );
            return (
              <li key={`${index}-${claim.evidenceIds[0] ?? 'claim'}`}>
                <p className="ai-claim-text">{claim.text}</p>
                <p className="ai-fact-tags">
                  <span>{claim.claimType.replaceAll('_', ' ')}</span>
                  {realRelations.map((rel) => (
                    <code key={rel.id}>
                      {rel.kind.toUpperCase()} · {rel.resolution.status}
                    </code>
                  ))}
                </p>
                <div className="row-actions">
                  {claim.evidenceIds.map((evId) => (
                    <button
                      key={evId}
                      type="button"
                      className="ai-anchor"
                      onClick={(event) =>
                        props.onSelectEvidence(
                          evId,
                          event.currentTarget,
                          claim.relationIds[0] ?? null,
                        )
                      }
                    >
                      <code>{evidenceLabel(evId)}</code>
                    </button>
                  ))}
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}

      <GeneratedNotesFollowups
        notes={notes}
        symbolsById={symbolsById}
        evidenceLabel={evidenceLabel}
        onSelectEvidence={props.onSelectEvidence}
        onFollowSymbol={props.onFollowSymbol}
      />
    </div>
  );
}

function GeneratedNotesFollowups(props: {
  notes: AiSynthesisResponse;
  symbolsById: ReadonlyMap<string, CodeSymbol>;
  evidenceLabel: (id: string) => string;
  onSelectEvidence: Props['onSelectEvidence'];
  onFollowSymbol: Props['onFollowSymbol'];
}) {
  const { notes } = props;
  return (
    <>
      {notes.nextSteps.length > 0 ? (
        <div className="ai-subsection">
          <p className="field-label">Suggested symbols in snapshot</p>
          <ul className="ai-step-list">
            {notes.nextSteps.map((step) => {
              const sym = props.symbolsById.get(step.symbolId);
              return (
                <li key={step.symbolId}>
                  <strong>{sym ? sym.name : step.symbolId}</strong>
                  <span>{step.reason}</span>
                  <div className="row-actions">
                    {sym ? (
                      <button
                        type="button"
                        onClick={() => props.onFollowSymbol(sym)}
                      >
                        Open {sym.name}
                      </button>
                    ) : null}
                    {step.supportingEvidenceIds.map((evId) => (
                      <button
                        key={evId}
                        type="button"
                        className="ai-anchor"
                        onClick={(event) =>
                          props.onSelectEvidence(
                            evId,
                            event.currentTarget,
                            null,
                          )
                        }
                      >
                        <code>{props.evidenceLabel(evId)}</code>
                      </button>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {notes.uncertainties.length > 0 ? (
        <div className="ai-subsection">
          <p className="field-label">Static uncertainties</p>
          <ul className="coverage-checks">
            {notes.uncertainties.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {notes.verification.rejectedItems.length > 0 ? (
        <details className="diagnostics ai-rejected">
          <summary>
            Withheld by verifier ({notes.verification.rejectedItems.length})
          </summary>
          <ul>
            {notes.verification.rejectedItems.map((item) => (
              <li key={`${item.kind}-${item.index}`}>
                <code>
                  {item.kind} #{item.index + 1}: {item.reasons.join(', ')}
                </code>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}

export function GeneratedNotes(props: Props) {
  if (!props.aiStatus.enabled) return null;

  const localityNote =
    props.aiStatus.locality === 'remote'
      ? `remote (${props.aiStatus.model} — selected excerpts leave this machine)`
      : `local (${props.aiStatus.model})`;

  return (
    <section
      id="generated-notes"
      className="generated-notes"
      aria-labelledby="generated-notes-heading"
    >
      <p className="step-label">04 / Generated notes</p>
      <h3 id="generated-notes-heading">Static synthesis</h3>
      <p className="muted small">Optional · unverified · {localityNote}</p>

      <label className="field-label" htmlFor="ai-task-select">
        Synthesis focus
      </label>
      <div className="ai-controls">
        <select
          id="ai-task-select"
          value={props.task}
          onChange={(event) =>
            props.onTaskChange(event.target.value as AiTaskKind)
          }
          disabled={props.loading}
        >
          <option value="explain_trace">Trace relationships</option>
          <option value="explain_unknowns">Unresolved &amp; unknowns</option>
          <option value="suggest_next_steps">Next symbols to inspect</option>
        </select>
        <button
          id="draft-ai-notes"
          type="button"
          onClick={props.onDraft}
          disabled={!props.canDraft || props.loading}
        >
          {props.loading ? 'Drafting notes…' : 'Draft notes'}
        </button>
      </div>

      {!props.canDraft && !props.loading ? (
        <p className="muted small">
          Select a declaration to draft bounded static notes.
        </p>
      ) : null}

      {props.loading ? (
        <p role="status">Drafting static notes from verified snapshot…</p>
      ) : null}

      {props.error ? (
        <p className="notice error" role="alert">
          <span>
            {props.error.code}: {props.error.message}
          </span>{' '}
          <button type="button" onClick={props.onDraft}>
            Retry notes
          </button>
        </p>
      ) : null}

      {props.notes ? (
        <GeneratedNotesBody
          notes={props.notes}
          graph={props.graph}
          onSelectEvidence={props.onSelectEvidence}
          onFollowSymbol={props.onFollowSymbol}
        />
      ) : null}
    </section>
  );
}
