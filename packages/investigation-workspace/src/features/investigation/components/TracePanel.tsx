import { useState } from 'react';
import type { UseSymbolPathsState } from '../hooks/useSymbolPaths.ts';
import type {
  CodeSymbol,
  GraphProjection,
  RelationKindFilter,
  TraceDepthOption,
  TraceDirection,
  TraceNodeLimitOption,
} from '../types.ts';
import { PathFinderPanel } from './PathFinderPanel.tsx';
import { TraceGraph } from './TraceGraph.tsx';

type Props = {
  active: boolean;
  root: CodeSymbol | null;
  graph: GraphProjection | null;
  graphLoading: boolean;
  graphError: string | null;
  onRetryGraph: () => void;
  relationKinds: RelationKindFilter[];
  onRelationKindsChange: (value: RelationKindFilter[]) => void;
  direction: TraceDirection;
  onDirectionChange: (value: TraceDirection) => void;
  traceDepth: TraceDepthOption;
  onTraceDepthChange: (value: TraceDepthOption) => void;
  traceNodeLimit: TraceNodeLimitOption;
  onTraceNodeLimitChange: (value: TraceNodeLimitOption) => void;
  selectedRelationId: string | null;
  onSelectEvidence: (
    id: string,
    trigger: HTMLButtonElement,
    relationId?: string,
  ) => void;
  onFollowSymbol: (symbol: CodeSymbol) => void;
  symbolPaths: UseSymbolPathsState;
};

function RelationshipList(props: {
  graph: GraphProjection['graph'];
  edgeFilter: string;
  selectedRelationId: string | null;
  onSelectEvidence: Props['onSelectEvidence'];
  onFollowSymbol: Props['onFollowSymbol'];
}) {
  const symbolById = new Map(
    props.graph.symbols.map((symbol) => [symbol.id, symbol]),
  );
  const evidenceById = new Map(
    props.graph.evidenceRefs.map((ref) => [ref.id, ref]),
  );
  const needle = props.edgeFilter.trim().toLowerCase();
  const filtered = needle
    ? props.graph.relations.filter((rel) => {
        const src = symbolById.get(rel.sourceSymbolId);
        const tgt =
          rel.resolution.status === 'exact'
            ? symbolById.get(rel.resolution.targetId)
            : undefined;
        const text = [
          rel.kind,
          rel.resolution.status,
          src?.name ?? '',
          src?.filePath ?? '',
          tgt?.name ?? '',
          tgt?.filePath ?? '',
        ]
          .join(' ')
          .toLowerCase();
        return text.includes(needle);
      })
    : props.graph.relations;

  return (
    <>
      {needle && filtered.length === 0 ? (
        <p className="muted small">
          No returned relationships match filter “{props.edgeFilter.trim()}”.
        </p>
      ) : null}
      <ol className="relationship-list">
        {filtered.map((relation) => {
          const source = symbolById.get(relation.sourceSymbolId);
          const site = evidenceById.get(relation.siteEvidenceId);
          const target =
            relation.resolution.status === 'exact'
              ? symbolById.get(relation.resolution.targetId)
              : undefined;
          const isSelected = props.selectedRelationId === relation.id;
          return (
            <li
              key={relation.id}
              className={isSelected ? 'selected' : ''}
              aria-current={isSelected ? 'true' : undefined}
              data-relation-id={relation.id}
            >
              <div>
                <strong>
                  {relation.kind.toUpperCase()} · {relation.resolution.status}
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
                    {source.filePath}:
                    {site?.range.start.line ?? source.range.start.line}
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
    </>
  );
}

function UnknownObservationsSection(props: {
  unknowns: GraphProjection['unknowns'];
  onSelectEvidence: Props['onSelectEvidence'];
}) {
  if (!props.unknowns.items.length) return null;
  return (
    <section aria-labelledby="unknown-heading">
      <h3 id="unknown-heading">Unresolved or unsupported observations</h3>
      <ol className="relationship-list">
        {props.unknowns.items.map((item) => (
          <li key={item.evidenceId}>
            <div>
              <strong>{item.status}</strong>
              <span>
                {item.diagnostic?.message ?? 'No exact target is available.'}
              </span>
              {item.diagnostic?.code ? (
                <code>{item.diagnostic.code}</code>
              ) : null}
            </div>
            <button
              type="button"
              onClick={(event) =>
                props.onSelectEvidence(item.evidenceId, event.currentTarget)
              }
            >
              Inspect source evidence
            </button>
          </li>
        ))}
      </ol>
      {props.unknowns.total > props.unknowns.items.length ? (
        <p className="notice warning">
          {props.unknowns.total - props.unknowns.items.length} additional
          uncertain observations are omitted from this presentation.
        </p>
      ) : null}
    </section>
  );
}

function TraceFilterControls(props: {
  root: CodeSymbol | null;
  relationKinds: RelationKindFilter[];
  onRelationKindsChange: Props['onRelationKindsChange'];
  direction: TraceDirection;
  onDirectionChange: Props['onDirectionChange'];
  traceDepth: TraceDepthOption;
  onTraceDepthChange: Props['onTraceDepthChange'];
  traceNodeLimit: TraceNodeLimitOption;
  onTraceNodeLimitChange: Props['onTraceNodeLimitChange'];
}) {
  const { root } = props;
  return (
    <fieldset className="filters">
      <legend>Relationship kinds &amp; traversal bounds</legend>
      {(['calls', 'references', 'constructs'] as const).map((kind) => (
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
            disabled={
              !root ||
              (props.relationKinds.length === 1 &&
                props.relationKinds.includes(kind))
            }
          />
          {kind.toUpperCase()}
        </label>
      ))}
      <label htmlFor="direction-select">Direction</label>
      <select
        id="direction-select"
        value={props.direction}
        onChange={(event) =>
          props.onDirectionChange(event.currentTarget.value as TraceDirection)
        }
        disabled={!root}
      >
        <option value="outgoing">Outgoing</option>
        <option value="incoming">Incoming</option>
        <option value="both">Incoming and outgoing</option>
      </select>
      <label htmlFor="trace-depth-select">Depth</label>
      <select
        id="trace-depth-select"
        value={props.traceDepth}
        onChange={(event) =>
          props.onTraceDepthChange(
            Number(event.currentTarget.value) as TraceDepthOption,
          )
        }
        disabled={!root}
      >
        <option value={1}>1 hop</option>
        <option value={2}>2 hops</option>
        <option value={3}>3 hops</option>
        <option value={4}>4 hops</option>
        <option value={5}>5 hops</option>
      </select>
      <label htmlFor="trace-limit-select">Limit</label>
      <select
        id="trace-limit-select"
        value={props.traceNodeLimit}
        onChange={(event) =>
          props.onTraceNodeLimitChange(
            Number(event.currentTarget.value) as TraceNodeLimitOption,
          )
        }
        disabled={!root}
      >
        <option value={50}>50 nodes</option>
        <option value={100}>100 nodes</option>
        <option value={200}>200 nodes</option>
      </select>
    </fieldset>
  );
}

export function TracePanel(props: Props) {
  const [edgeFilter, setEdgeFilter] = useState('');
  const root = props.root;
  const graph = props.graph?.graph;
  const exactCount =
    graph?.relations.filter((rel) => rel.resolution.status === 'exact')
      .length ?? 0;

  return (
    <section
      id="trace-panel"
      role="tabpanel"
      aria-labelledby="trace-tab"
      hidden={!props.active}
      tabIndex={0}
    >
      <TraceFilterControls
        root={root}
        relationKinds={props.relationKinds}
        onRelationKindsChange={props.onRelationKindsChange}
        direction={props.direction}
        onDirectionChange={props.onDirectionChange}
        traceDepth={props.traceDepth}
        onTraceDepthChange={props.onTraceDepthChange}
        traceNodeLimit={props.traceNodeLimit}
        onTraceNodeLimitChange={props.onTraceNodeLimitChange}
      />
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
      {graph?.meta ? (
        <div className="coverage-summary">
          <div className="coverage-status" role="status">
            <span>Evidence basis: static</span>
            <span>Coverage: {graph.meta.coverage}</span>
            <span>
              Nodes: {graph.symbols.length} · Edges: {graph.relations.length} (
              {exactCount} exact)
            </span>
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
      {props.active && graph?.relations.length ? (
        <TraceGraph
          graph={graph}
          rootSymbolId={root?.id}
          onFollowSymbol={props.onFollowSymbol}
        />
      ) : null}
      {graph && graph.relations.length > 4 ? (
        <div className="edge-filter-row">
          <label className="field-label" htmlFor="trace-edge-filter">
            Filter returned relationships
          </label>
          <input
            id="trace-edge-filter"
            value={edgeFilter}
            onChange={(event) => setEdgeFilter(event.currentTarget.value)}
            placeholder="Filter by symbol name, file path, or resolution"
            maxLength={128}
            autoComplete="off"
          />
        </div>
      ) : null}
      {graph?.relations.length ? (
        <RelationshipList
          graph={graph}
          edgeFilter={edgeFilter}
          selectedRelationId={props.selectedRelationId}
          onSelectEvidence={props.onSelectEvidence}
          onFollowSymbol={props.onFollowSymbol}
        />
      ) : graph && root && !props.graphLoading ? (
        <p className="empty-state">
          No returned relationships match these filters. This does not establish
          that unsupported or unanalysed relationships are absent.
        </p>
      ) : null}
      {props.graph ? (
        <UnknownObservationsSection
          unknowns={props.graph.unknowns}
          onSelectEvidence={props.onSelectEvidence}
        />
      ) : null}
      {root ? (
        <PathFinderPanel
          root={root}
          relationKinds={props.relationKinds}
          paths={props.symbolPaths}
          selectedRelationId={props.selectedRelationId}
          onSelectEvidence={props.onSelectEvidence}
          onFollowSymbol={props.onFollowSymbol}
        />
      ) : null}
    </section>
  );
}
