import type { RefObject } from 'react';
import { SourcePanel } from './SourcePanel.tsx';
import { TracePanel } from './TracePanel.tsx';
import type {
  CodeSymbol,
  EvidenceProjection,
  FollowContextProjection,
  GraphProjection,
  SessionProjection,
} from './types.ts';

export type MainModel = {
  selected: CodeSymbol | null;
  evidence: EvidenceProjection['items'][number] | null;
  evidenceLoading: boolean;
  evidenceError: string | null;
  graph: GraphProjection | null;
  graphLoading: boolean;
  graphError: string | null;
  session: SessionProjection | null;
  activeView: 'source' | 'trace';
  relationKinds: ('calls' | 'references')[];
  direction: 'outgoing' | 'incoming' | 'both';
  selectedRelationId: string | null;
  contextCandidates: FollowContextProjection['candidates'];
  contextSearchLoading: boolean;
  contextSearchMessage: string | null;
  onViewChange: (view: 'source' | 'trace') => void;
  onRelationKindsChange: (value: ('calls' | 'references')[]) => void;
  onDirectionChange: (value: 'outgoing' | 'incoming' | 'both') => void;
  onSelectEvidence: (
    id: string,
    trigger: HTMLButtonElement,
    relationId?: string,
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
        <div>
          <p className="step-label">02 / Investigation</p>
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
            const next = model.activeView === 'source' ? 'trace' : 'source';
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
        </div>
      </div>

      <div className="pane-body">
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
    </main>
  );
}
