import { TraceGraph } from './TraceGraph.tsx';
import type { CodeSymbol, GraphProjection } from './types.ts';

type Props = {
  hidden: boolean;
  root: CodeSymbol | null;
  graphProjection: GraphProjection | null;
  graphLoading: boolean;
  graphError: string | null;
  onRetryGraph: () => void;
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
};

export function TracePanel(props: Props) {
  const { root, graphProjection } = props;
  const graph = graphProjection?.graph;
  const symbolById = new Map(
    (graph?.symbols ?? []).map((symbol) => [symbol.id, symbol]),
  );
  const evidenceById = new Map(
    (graph?.evidenceRefs ?? []).map((ref) => [ref.id, ref]),
  );

  return (
    <section
      id="trace-panel"
      role="tabpanel"
      aria-labelledby="trace-tab"
      hidden={props.hidden}
      tabIndex={0}
    >
      <fieldset className="filters">
        <legend className="sr-only">Relationship kinds</legend>
        <div className="filter-group">
          {(['calls', 'references'] as const).map((kind) => (
            <label
              key={kind}
              className={`filter-check filter-${kind}${props.relationKinds.includes(kind) ? ' is-checked' : ''}`}
            >
              <input
                type="checkbox"
                checked={props.relationKinds.includes(kind)}
                onChange={(event) => {
                  const next = event.currentTarget.checked
                    ? [...props.relationKinds, kind]
                    : props.relationKinds.filter((value) => value !== kind);
                  if (next.length) props.onRelationKindsChange(next);
                }}
                disabled={
                  !root ||
                  (props.relationKinds.length === 1 &&
                    props.relationKinds.includes(kind))
                }
              />
              <span className="kind-swatch" aria-hidden="true" />
              {kind.toUpperCase()}
            </label>
          ))}
        </div>
        <div className="filter-direction">
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
        </div>
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
        <div className="notice error" role="alert">
          <span>{props.graphError}</span>
          <button type="button" onClick={props.onRetryGraph}>
            Retry trace
          </button>
        </div>
      ) : null}
      {graph?.meta ? (
        <div className="coverage-summary">
          <div className="coverage-status" role="status">
            <span>Evidence basis: static</span>
            <span>Coverage: {graph.meta.coverage}</span>
            <span>
              {graph.meta.truncated
                ? `Truncated: ${graph.meta.truncationReasons.join(', ')}`
                : 'Query not truncated'}
            </span>
          </div>
          <details>
            <summary>Applied query limits</summary>
            <pre>{JSON.stringify(graph.meta.appliedLimits, null, 2)}</pre>
          </details>
        </div>
      ) : null}
      {!props.hidden && graph?.relations.length ? (
        <TraceGraph
          graph={graph}
          rootSymbolId={root?.id ?? null}
          onFollowSymbol={props.onFollowSymbol}
        />
      ) : null}
      {graph?.relations.length ? (
        <ol className="relationship-list">
          {graph.relations.map((relation) => {
            const source = symbolById.get(relation.sourceSymbolId);
            const site = evidenceById.get(relation.siteEvidenceId);
            const target =
              relation.resolution.status === 'exact'
                ? symbolById.get(relation.resolution.targetId)
                : undefined;
            const isSelected = props.selectedRelationId === relation.id;
            const resolutionClass =
              relation.resolution.status === 'exact'
                ? 'status-exact'
                : 'status-uncertain';
            return (
              <li
                key={relation.id}
                className={`relation-row relation-${relation.kind}${isSelected ? ' selected' : ''}`}
                aria-current={isSelected ? 'true' : undefined}
                data-relation-id={relation.id}
              >
                <div className="relation-body">
                  <div className="relation-head">
                    <strong className={`relation-kind kind-${relation.kind}`}>
                      {relation.kind.toUpperCase()}
                    </strong>
                    <span className={`relation-resolution ${resolutionClass}`}>
                      {relation.resolution.status}
                    </span>
                    {source ? (
                      <code className="relation-location">
                        {source.filePath}:
                        {site?.range.start.line ?? source.range.start.line}
                      </code>
                    ) : null}
                  </div>
                  <span className="relation-flow">
                    {source?.name ?? relation.sourceSymbolId}
                    {target
                      ? ` → ${target.name}`
                      : relation.resolution.status === 'exact'
                        ? ' → target omitted by graph limit'
                        : ' → no exact target'}
                  </span>
                </div>
                <div className="row-actions">
                  <button
                    className="btn-ghost"
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
                      className="btn-primary"
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
      ) : graph && root && !props.graphLoading ? (
        <p className="empty-state">
          No returned relationships match these filters. This does not establish
          that unsupported or unanalysed relationships are absent.
        </p>
      ) : null}
      {graphProjection?.unknowns.items.length ? (
        <section aria-labelledby="unknown-heading">
          <h3 id="unknown-heading">Unresolved or unsupported observations</h3>
          <ol className="relationship-list">
            {graphProjection.unknowns.items.map((item) => (
              <li
                key={item.evidenceId}
                className="relation-row relation-observation"
              >
                <div className="relation-body">
                  <div className="relation-head">
                    <strong className="relation-resolution status-uncertain">
                      {item.status}
                    </strong>
                    {item.diagnostic?.code ? (
                      <code className="relation-location">
                        {item.diagnostic.code}
                      </code>
                    ) : null}
                  </div>
                  <span className="observation-message">
                    {item.diagnostic?.message ??
                      'No exact target is available.'}
                  </span>
                </div>
                <div className="row-actions">
                  <button
                    className="btn-ghost"
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
                </div>
              </li>
            ))}
          </ol>
          {graphProjection.unknowns.total >
          graphProjection.unknowns.items.length ? (
            <p className="notice warning">
              {graphProjection.unknowns.total -
                graphProjection.unknowns.items.length}{' '}
              additional uncertain observations are omitted from this
              presentation.
            </p>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}
