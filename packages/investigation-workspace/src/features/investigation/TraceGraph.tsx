import type { GraphProjection } from './types.ts';

type Props = { graph: GraphProjection['graph'] };

type Point = { x: number; y: number };

export function TraceGraph({ graph }: Props) {
  const symbols = graph.symbols;
  if (!symbols.length) return null;
  const positions = new Map<string, Point>();
  symbols.forEach((symbol, index) => {
    positions.set(symbol.id, {
      x: 28 + (index % 2) * 366,
      y: 26 + Math.floor(index / 2) * 92,
    });
  });
  const visibleRelations = graph.relations.filter(
    (relation) =>
      relation.resolution.status === 'exact' &&
      relation.resolution.targetId !== null &&
      positions.has(relation.sourceSymbolId) &&
      positions.has(relation.resolution.targetId),
  );
  const height = Math.max(96, Math.ceil(symbols.length / 2) * 92 + 14);
  const nameById = new Map(symbols.map((symbol) => [symbol.id, symbol.name]));
  return (
    <section
      className="trace-graph-section"
      aria-labelledby="trace-graph-heading"
    >
      <h3 id="trace-graph-heading">Returned exact relationships</h3>
      <p className="muted small">
        The diagram includes only returned symbols and exact edges. Use the
        relationship list for evidence and navigation.
      </p>
      <div
        className="trace-graph-scroll"
        tabIndex={0}
        aria-label="Scrollable relationship diagram"
      >
        <svg
          className="trace-graph"
          role="img"
          aria-label={`Bounded graph with ${symbols.length} returned symbols and ${visibleRelations.length} exact returned relationships.`}
          viewBox={`0 0 760 ${height}`}
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            <marker
              id="trace-arrow"
              markerWidth="8"
              markerHeight="8"
              refX="7"
              refY="4"
              orient="auto"
            >
              <path d="M0,0 L8,4 L0,8 Z" fill="var(--ct-accent)" />
            </marker>
          </defs>
          {visibleRelations.map((relation) => {
            const source = positions.get(relation.sourceSymbolId);
            const targetId = relation.resolution.targetId;
            if (targetId === null) return null;
            const target = positions.get(targetId);
            if (!source || !target) return null;
            const startX = source.x + 150;
            const endX = target.x;
            const middleX = (startX + endX) / 2;
            return (
              <g
                key={relation.id}
                className={`trace-edge trace-${relation.kind}`}
              >
                <path
                  d={`M ${startX} ${source.y + 28} C ${middleX} ${source.y + 28}, ${middleX} ${target.y + 28}, ${endX} ${target.y + 28}`}
                  markerEnd="url(#trace-arrow)"
                >
                  <title>
                    {relation.kind.toUpperCase()}:{' '}
                    {nameById.get(relation.sourceSymbolId)}
                    {' to '}
                    {nameById.get(relation.resolution.targetId)}
                  </title>
                </path>
              </g>
            );
          })}
          {symbols.map((symbol) => {
            const point = positions.get(symbol.id);
            if (!point) return null;
            return (
              <g key={symbol.id} className="trace-node">
                <rect x={point.x} y={point.y} width="150" height="58" rx="6" />
                <text
                  x={point.x + 9}
                  y={point.y + 22}
                  className="trace-node-name"
                >
                  {symbol.name.slice(0, 22)}
                </text>
                <text
                  x={point.x + 9}
                  y={point.y + 42}
                  className="trace-node-location"
                >
                  {symbol.filePath.split('/').at(-1)?.slice(0, 22)}:
                  {symbol.range.start.line}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </section>
  );
}
