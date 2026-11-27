import type { ReactNode, RefObject } from 'react';

type Props = {
  inspectorModal: boolean;
  canBack: boolean;
  canForward: boolean;
  onMoveHistory: (step: -1 | 1) => void;
  compactViewport: boolean;
  inspectorTriggerRef: RefObject<HTMLButtonElement | null>;
  onOpenInspector: (trigger: HTMLButtonElement) => void;
  expiresAt: string | null;
  statusBar: ReactNode;
  children: ReactNode;
};

export function WorkspaceChrome(props: Props) {
  return (
    <div className="page-shell">
      <header className="page-header" inert={props.inspectorModal}>
        <div>
          <p className="eyebrow">CODETHREAD / LOCAL ANALYSIS</p>
          <h1>Investigation Workspace</h1>
          <p>Trace source-backed relationships in a pinned snapshot.</p>
        </div>
        <nav className="history-controls" aria-label="Investigation history">
          <button
            type="button"
            onClick={() => props.onMoveHistory(-1)}
            disabled={!props.canBack}
          >
            Back
          </button>
          <button
            type="button"
            onClick={() => props.onMoveHistory(1)}
            disabled={!props.canForward}
          >
            Forward
          </button>
        </nav>
        <button
          id="inspector-toggle"
          ref={props.inspectorTriggerRef}
          type="button"
          hidden={!props.compactViewport}
          aria-expanded={props.inspectorModal}
          aria-controls="evidence-inspector"
          aria-haspopup="dialog"
          onClick={(event) => props.onOpenInspector(event.currentTarget)}
        >
          Evidence
        </button>
      </header>
      {props.statusBar}
      <div className="workspace-grid">{props.children}</div>
      <footer className="page-footer" inert={props.inspectorModal}>
        <span>Static source evidence · validated API projections</span>
        {props.expiresAt ? (
          <span>
            Viewer expires {new Date(props.expiresAt).toLocaleTimeString()}
          </span>
        ) : null}
      </footer>
    </div>
  );
}
