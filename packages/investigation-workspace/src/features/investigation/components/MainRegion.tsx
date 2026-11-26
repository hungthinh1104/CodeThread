import type { RefObject } from 'react';
import type { UseSymbolPathsState } from '../hooks/useSymbolPaths.ts';
import type {
  CodeSymbol,
  EvidenceItem,
  FollowContextProjection,
  GraphProjection,
  InvestigationView,
  RelationKindFilter,
  SessionProjection,
  TraceDirection,
} from '../types.ts';
import { SourcePanel } from './SourcePanel.tsx';
import { TracePanel } from './TracePanel.tsx';

type Props = {
  inert: boolean;
  headingRef: RefObject<HTMLHeadingElement | null>;
  selected: CodeSymbol | null;
  evidence: EvidenceItem | null;
  evidenceLoading: boolean;
  graph: GraphProjection | null;
  graphLoading: boolean;
  graphError: string | null;
  evidenceError: string | null;
  onRetryGraph: () => void;
  onRetryEvidence: () => void;
  session: SessionProjection | null;
  activeView: InvestigationView;
  onViewChange: (view: InvestigationView) => void;
  relationKinds: RelationKindFilter[];
  onRelationKindsChange: (value: RelationKindFilter[]) => void;
  direction: TraceDirection;
  onDirectionChange: (value: TraceDirection) => void;
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
  symbolPaths: UseSymbolPathsState;
};

export function MainRegion(props: Props) {
  const root = props.selected;
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

      <SourcePanel
        active={props.activeView === 'source'}
        root={root}
        evidence={props.evidence}
        evidenceLoading={props.evidenceLoading}
        evidenceError={props.evidenceError}
        onRetryEvidence={props.onRetryEvidence}
        onSelectEvidence={props.onSelectEvidence}
        contextCandidates={props.contextCandidates}
        contextSearchLoading={props.contextSearchLoading}
        contextSearchMessage={props.contextSearchMessage}
        onFindContexts={props.onFindContexts}
        onChooseContext={props.onChooseContext}
      />

      <TracePanel
        active={props.activeView === 'trace'}
        root={root}
        graph={props.graph}
        graphLoading={props.graphLoading}
        graphError={props.graphError}
        onRetryGraph={props.onRetryGraph}
        relationKinds={props.relationKinds}
        onRelationKindsChange={props.onRelationKindsChange}
        direction={props.direction}
        onDirectionChange={props.onDirectionChange}
        selectedRelationId={props.selectedRelationId}
        onSelectEvidence={props.onSelectEvidence}
        onFollowSymbol={props.onFollowSymbol}
        symbolPaths={props.symbolPaths}
      />

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
