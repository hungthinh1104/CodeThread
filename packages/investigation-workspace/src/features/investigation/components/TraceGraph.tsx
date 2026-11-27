import { useState } from 'react';
import type { CodeSymbol, GraphProjection } from '../types.ts';

type Props = {
  graph: GraphProjection['graph'];
  rootSymbolId?: string;
  onFollowSymbol?: (symbol: CodeSymbol) => void;
};

type Point = { x: number; y: number };

const nodeWidth = 150;
const nodeHeight = 58;

function edgePath(source: Point, target: Point): string {
  if (source.x === target.x && source.y === target.y) {
    const right = source.x + nodeWidth;
    return `M ${right} ${source.y + 14} C ${right + 42} ${source.y - 4}, ${right + 42} ${source.y + 62}, ${right} ${source.y + 44}`;
  }
  if (source.x === target.x) {
    const below = target.y > source.y;
    const x = source.x + nodeWidth / 2;
    const startY = source.y + (below ? nodeHeight : 0);
    const endY = target.y + (below ? 0 : nodeHeight);
    return `M ${x} ${startY} L ${x} ${endY}`;
  }
  const toRight = source.x < target.x;
  const startX = source.x + (toRight ? nodeWidth : 0);
  const endX = target.x + (toRight ? 0 : nodeWidth);
  const startY = source.y + nodeHeight / 2;
  const endY = target.y + nodeHeight / 2;
  const middleX = (startX + endX) / 2;
  return `M ${startX} ${startY} C ${middleX} ${startY}, ${middleX} ${endY}, ${endX} ${endY}`;
}

export function TraceGraph(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="trace-graph-disclosure"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Show exact relationship diagram</summary>
      {open ? <TraceDiagram {...props} /> : null}
    </details>
  );
}

function TraceDiagram({ graph, rootSymbolId, onFollowSymbol }: Props) {
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
        The diagram includes only returned symbols and exact edges. Click a
        symbol node to focus its declaration, or use the list below for
        occurrence evidence.
      </p>
      <div
        className="trace-graph-scroll"
        role="region"
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
              refX="8"
              refY="4"
              orient="auto"
            >
              <path d="M0,0 L8,4 L0,8 Z" fill="var(--ct-accent)" />
            </marker>
            {symbols.map((symbol, index) => {
              const point = positions.get(symbol.id);
              if (!point) return null;
              return (
                <clipPath key={symbol.id} id={`trace-node-clip-${index}`}>
                  <rect
                    x={point.x + 4}
                    y={point.y + 4}
                    width={nodeWidth - 8}
                    height={nodeHeight - 8}
                  />
                </clipPath>
              );
            })}
          </defs>
          {visibleRelations.map((relation) => {
            const source = positions.get(relation.sourceSymbolId);
            const targetId = relation.resolution.targetId;
            if (targetId === null) return null;
            const target = positions.get(targetId);
            if (!source || !target) return null;
            return (
              <g
                key={relation.id}
                className={`trace-edge trace-${relation.kind}`}
                data-relation-id={relation.id}
              >
                <path
                  d={edgePath(source, target)}
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
          {symbols.map((symbol, index) => {
            const point = positions.get(symbol.id);
            if (!point) return null;
            const isRoot = symbol.id === rootSymbolId;
            return (
              <g
                key={symbol.id}
                className={`trace-node${isRoot ? ' trace-node-root' : ''}${onFollowSymbol ? ' trace-node-interactive' : ''}`}
                onClick={
                  onFollowSymbol ? () => onFollowSymbol(symbol) : undefined
                }
              >
                <title>
                  {symbol.kind} {symbol.name} ({symbol.filePath}:
                  {symbol.range.start.line})
                </title>
                <rect
                  x={point.x}
                  y={point.y}
                  width={nodeWidth}
                  height={nodeHeight}
                  rx="6"
                />
                <g clipPath={`url(#trace-node-clip-${index})`}>
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
              </g>
            );
          })}
        </svg>
      </div>
    </section>
  );
}
