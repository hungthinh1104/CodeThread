import type { RefObject } from 'react';
import { PathsPanel } from './PathsPanel.tsx';
import { SourcePanel } from './SourcePanel.tsx';
import { TracePanel } from './TracePanel.tsx';
import type {
  CodeSymbol,
  EvidenceProjection,
  FollowContextProjection,
  GraphProjection,
  Scope,
  SessionProjection,
} from './types.ts';

export type MainModel = {
  scope: Scope | null;
  selected: CodeSymbol | null;
  evidence: EvidenceProjection['items'][number] | null;
  evidenceLoading: boolean;
  evidenceError: string | null;
  graph: GraphProjection | null;
  graphLoading: boolean;
  graphError: string | null;
  session: SessionProjection | null;
  activeView: 'source' | 'trace' | 'paths';
  relationKinds: ('calls' | 'references')[];
  direction: 'outgoing' | 'incoming' | 'both';
  selectedRelationId: string | null;
  contextCandidates: FollowContextProjection['candidates'];
  contextSearchLoading: boolean;
  contextSearchMessage: string | null;
  onViewChange: (view: 'source' | 'trace' | 'paths') => void;
  onRelationKindsChange: (value: ('calls' | 'references')[]) => void;
  onDirectionChange: (value: 'outgoing' | 'incoming' | 'both') => void;
  onSelectEvidence: (
    id: string,
    trigger: HTMLButtonElement,
    relationId?: string,
    verifiedFromPath?: boolean,
  ) => void;
  onFollowSymbol: (symbol: CodeSymbol) => void;
  onRetryGraph: () => void;
  onRetryEvidence: () => void;
  onFindContexts: () => void;
  onChooseContext: (
    candidate: FollowContextProjection['candidates'][number],
  ) => void;
};

type Props = {
  inert: boolean;
  headingRef: RefObject<HTMLHeadingElement | null>;
  model: MainModel;
};

export function MainRegion({ inert, headingRef, model }: Props) {
  const root = model.selected;
  return (
    <main
      className="region main-region"
      aria-labelledby="workspace-heading"
      inert={inert}
    >
      <div className="main-heading pane-header">
        <div className="main-heading-meta">
          <h2 id="workspace-heading" ref={headingRef} tabIndex={-1}>
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
            const order = ['source', 'trace', 'paths'] as const;
            const currentIndex = order.indexOf(model.activeView);
            const nextIndex =
              event.key === 'ArrowRight'
                ? (currentIndex + 1) % order.length
                : (currentIndex - 1 + order.length) % order.length;
            const next = order[nextIndex]!;
            model.onViewChange(next);
            document.getElementById(`${next}-tab`)?.focus();
          }}
        >
          <button
            id="source-tab"
            type="button"
            role="tab"
            aria-selected={model.activeView === 'source'}
            aria-controls="source-panel"
            tabIndex={model.activeView === 'source' ? 0 : -1}
            onClick={() => model.onViewChange('source')}
          >
            Source
          </button>
          <button
            id="trace-tab"
            type="button"
            role="tab"
            aria-selected={model.activeView === 'trace'}
            aria-controls="trace-panel"
            tabIndex={model.activeView === 'trace' ? 0 : -1}
            onClick={() => model.onViewChange('trace')}
          >
            Trace
          </button>
          <button
            id="paths-tab"
            type="button"
            role="tab"
            aria-selected={model.activeView === 'paths'}
            aria-controls="paths-panel"
            tabIndex={model.activeView === 'paths' ? 0 : -1}
            onClick={() => model.onViewChange('paths')}
          >
            Paths
          </button>
        </div>
      </div>

      <div className="pane-body">
        <div className="main-content">
          <SourcePanel
            hidden={model.activeView !== 'source'}
            root={root}
            evidence={model.evidence}
            evidenceLoading={model.evidenceLoading}
            evidenceError={model.evidenceError}
            onRetryEvidence={model.onRetryEvidence}
            onSelectEvidence={model.onSelectEvidence}
            contextCandidates={model.contextCandidates}
            contextSearchLoading={model.contextSearchLoading}
            contextSearchMessage={model.contextSearchMessage}
            onFindContexts={model.onFindContexts}
            onChooseContext={model.onChooseContext}
          />

          <TracePanel
            hidden={model.activeView !== 'trace'}
            root={root}
            graphProjection={model.graph}
            graphLoading={model.graphLoading}
            graphError={model.graphError}
            onRetryGraph={model.onRetryGraph}
            relationKinds={model.relationKinds}
            onRelationKindsChange={model.onRelationKindsChange}
            direction={model.direction}
            onDirectionChange={model.onDirectionChange}
            selectedRelationId={model.selectedRelationId}
            onSelectEvidence={model.onSelectEvidence}
            onFollowSymbol={model.onFollowSymbol}
          />

          <PathsPanel
            hidden={model.activeView !== 'paths'}
            root={root}
            scope={model.scope}
            relationKinds={model.relationKinds}
            onRelationKindsChange={model.onRelationKindsChange}
            onSelectEvidence={model.onSelectEvidence}
            onFollowSymbol={model.onFollowSymbol}
          />

          {model.session ? (
            <details className="session-coverage">
              <summary>Snapshot coverage by capability</summary>
              <ul>
                {Object.entries(model.session.coverageByCapability).map(
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
        </div>
      </div>
    </main>
  );
}
