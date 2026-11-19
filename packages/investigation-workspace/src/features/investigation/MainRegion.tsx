import type {
  CodeSymbol,
  EvidenceProjection,
  FollowContextProjection,
  GraphProjection,
  SessionProjection,
} from './types.ts';
import { TraceGraph } from './TraceGraph.tsx';
import type { RefObject } from 'react';

type Props = {
  inert: boolean;
  headingRef: RefObject<HTMLHeadingElement | null>;
  selected: CodeSymbol | null;
  evidence: EvidenceProjection['items'][number] | null;
  evidenceLoading: boolean;
  graph: GraphProjection | null;
  graphLoading: boolean;
  graphError: string | null;
  evidenceError: string | null;
  onRetryGraph: () => void;
  onRetryEvidence: () => void;
  session: SessionProjection | null;
  activeView: 'source' | 'trace';
  onViewChange: (view: 'source' | 'trace') => void;
  relationKinds: ('calls' | 'references')[];
  onRelationKindsChange: (value: ('calls' | 'references')[]) => void;
  direction: 'outgoing' | 'incoming' | 'both';
  onDirectionChange: (value: 'outgoing' | 'incoming' | 'both') => void;
  selectedRelationId: string | null;
  onSelectEvidence: (
    id: string,
    trigger: HTMLButtonElement,
    relationId?: string,
  ) => void;
  onFollowSymbol: (symbol: CodeSymbol) => void;
  contextCandidates: FollowContextProjection['candidates'];
  contextSearchLoading: boolean;
  contextSearchMessage: string | null;
  onFindContexts: () => void;
  onChooseContext: (
    candidate: FollowContextProjection['candidates'][number],
  ) => void;
};

function unwrapEvidence(
  item: EvidenceProjection['items'][number] | null,
): string | null {
  return item?.status === 'available' ? item.text : null;
}

export function MainRegion(props: Props) {
  const root = props.selected;
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
  const evidenceText = unwrapEvidence(declaration);
  const graph = props.graph?.graph;
  const symbolById = new Map(
    (graph?.symbols ?? []).map((symbol) => [symbol.id, symbol]),
  );
  return (
    <main
      className="region main-region"
      aria-labelledby="workspace-heading"
      inert={props.inert}
    >
      <div className="main-heading">
        <div>
          <p className="step-label">02 / Investigation</p>
          <h2 id="workspace-heading" ref={props.headingRef} tabIndex={-1}>
            Source and trace
          </h2>
          {root ? (
            <p className="selected-symbol">
              <strong>
                {root.kind} {root.name}
              </strong>
              <code>
                {root.filePath}:{root.range.start.line}:
                {root.range.start.column}
              </code>
            </p>
          ) : (
            <p className="muted">Choose a source-backed symbol to begin.</p>
          )}
        </div>
        <div
          className="view-tabs"
          role="tablist"
          aria-label="Investigation view"
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            const next = props.activeView === 'source' ? 'trace' : 'source';
            props.onViewChange(next);
            document.getElementById(`${next}-tab`)?.focus();
          }}
        >
          <button
            id="source-tab"
            type="button"
            role="tab"
            aria-selected={props.activeView === 'source'}
            aria-controls="source-panel"
            tabIndex={props.activeView === 'source' ? 0 : -1}
            onClick={() => props.onViewChange('source')}
          >
            Source
          </button>
          <button
            id="trace-tab"
            type="button"
            role="tab"
            aria-selected={props.activeView === 'trace'}
            aria-controls="trace-panel"
            tabIndex={props.activeView === 'trace' ? 0 : -1}
            onClick={() => props.onViewChange('trace')}
          >
            Trace
          </button>
        </div>
      </div>

      <section
        id="source-panel"
        role="tabpanel"
        aria-labelledby="source-tab"
        hidden={props.activeView !== 'source'}
        tabIndex={0}
      >
        {!root ? (
          <p className="empty-state">
            Select a symbol from the pinned catalog.
          </p>
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
            <p className="muted small">
              {declaration.filePath} · line{' '}
              {declaration.evidence.range.start.line} · SHA-256{' '}
              {declaration.evidence.contentHash}
            </p>
            <pre className="evidence-text">{evidenceText}</pre>
            <p className="caption">
              Exact verified excerpt from snapshot {root.snapshotId}; not the
              complete file.
            </p>
          </div>
        ) : null}
        {root && declaration?.status === 'unavailable' ? (
          <p className="notice warning" role="status">
            Declaration evidence unavailable: {declaration.code}. Mutable
            worktree source was not used.
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

      <section
        id="trace-panel"
        role="tabpanel"
        aria-labelledby="trace-tab"
        hidden={props.activeView !== 'trace'}
        tabIndex={0}
      >
        <fieldset className="filters">
          <legend>Relationship kinds</legend>
          {(['calls', 'references'] as const).map((kind) => (
            <label key={kind}>
              <input
                type="checkbox"
                checked={props.relationKinds.includes(kind)}
                onChange={(event) => {
                  const next = event.currentTarget.checked
                    ? [...props.relationKinds, kind]
                    : props.relationKinds.filter((value) => value !== kind);
                  if (next.length) props.onRelationKindsChange(next);
                }}
                disabled={!root}
              />
              {kind.toUpperCase()}
            </label>
          ))}
          <label htmlFor="direction-select">Direction</label>
          <select
            id="direction-select"
            value={props.direction}
            onChange={(event) =>
              props.onDirectionChange(
                event.currentTarget.value as Props['direction'],
              )
            }
            disabled={!root}
          >
            <option value="outgoing">Outgoing</option>
            <option value="incoming">Incoming</option>
            <option value="both">Incoming and outgoing</option>
          </select>
        </fieldset>
        {!root ? (
          <p className="empty-state">
            Select a symbol to query static relationships.
          </p>
        ) : null}
        {props.graphLoading ? (
          <p role="status">Querying the pinned snapshot…</p>
        ) : null}
        {props.graphError ? (
          <p className="notice error" role="alert">
            {props.graphError}{' '}
            <button type="button" onClick={props.onRetryGraph}>
              Retry trace
            </button>
          </p>
        ) : null}
        {props.graph?.graph.meta ? (
          <div className="coverage-summary" role="status">
            <span>Evidence basis: static</span>
            <span>Coverage: {props.graph.graph.meta.coverage}</span>
            <span>
              {props.graph.graph.meta.truncated
                ? `Truncated: ${props.graph.graph.meta.truncationReasons.join(', ')}`
                : 'Query not truncated'}
            </span>
            <details>
              <summary>Applied query limits</summary>
              <pre>
                {JSON.stringify(props.graph.graph.meta.appliedLimits, null, 2)}
              </pre>
            </details>
          </div>
        ) : null}
        {props.activeView === 'trace' && graph?.relations.length ? (
          <TraceGraph graph={graph} />
        ) : null}
        {graph?.relations.length ? (
          <ol className="relationship-list">
            {graph.relations.map((relation) => {
              const source = symbolById.get(relation.sourceSymbolId);
              const target =
                relation.resolution.status === 'exact'
                  ? symbolById.get(relation.resolution.targetId)
                  : undefined;
              return (
                <li
                  key={relation.id}
                  className={
                    props.selectedRelationId === relation.id ? 'selected' : ''
                  }
                  data-relation-id={relation.id}
                >
                  <div>
                    <strong>
                      {relation.kind.toUpperCase()} ·{' '}
                      {relation.resolution.status}
                    </strong>
                    <span>
                      {source?.name ?? relation.sourceSymbolId}
                      {target
                        ? ` → ${target.name}`
                        : relation.resolution.status === 'exact'
                          ? ' → target omitted by graph limit'
                          : ' → no exact target'}
                    </span>
                    {source ? (
                      <code>
                        {source.filePath}:{source.range.start.line}
                      </code>
                    ) : null}
                  </div>
                  <div className="row-actions">
                    <button
                      type="button"
                      onClick={(event) =>
                        props.onSelectEvidence(
                          relation.siteEvidenceId,
                          event.currentTarget,
                          relation.id,
                        )
                      }
                    >
                      Inspect occurrence evidence
                    </button>
                    {relation.resolution.status === 'exact' && target ? (
                      <button
                        type="button"
                        onClick={() => props.onFollowSymbol(target)}
                      >
                        Follow {target.name}
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        ) : root && !props.graphLoading ? (
          <p className="empty-state">
            No returned relationships match these filters. This does not
            establish that unsupported or unanalysed relationships are absent.
          </p>
        ) : null}
        {props.graph?.unknowns.items.length ? (
          <section aria-labelledby="unknown-heading">
            <h3 id="unknown-heading">Unresolved or unsupported observations</h3>
            <ol className="relationship-list">
              {props.graph.unknowns.items.map((item) => (
                <li key={item.evidenceId}>
                  <div>
                    <strong>{item.status}</strong>
                    <span>
                      {item.diagnostic?.message ??
                        'No exact target is available.'}
                    </span>
                    {item.diagnostic?.code ? (
                      <code>{item.diagnostic.code}</code>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={(event) =>
                      props.onSelectEvidence(
                        item.evidenceId,
                        event.currentTarget,
                      )
                    }
                  >
                    Inspect source evidence
                  </button>
                </li>
              ))}
            </ol>
            {props.graph.unknowns.total > props.graph.unknowns.items.length ? (
              <p className="notice warning">
                {props.graph.unknowns.total - props.graph.unknowns.items.length}{' '}
                additional uncertain observations are omitted from this
                presentation.
              </p>
            ) : null}
          </section>
        ) : null}
      </section>
      {props.session ? (
        <details className="session-coverage">
          <summary>Snapshot coverage by capability</summary>
          <ul>
            {Object.entries(props.session.coverageByCapability).map(
              ([capability, status]) => (
                <li key={capability}>
                  <code>{capability}</code>
                  <span>{status}</span>
                </li>
              ),
            )}
          </ul>
        </details>
      ) : null}
    </main>
  );
}
