import type { AiStatusResponse, BackendHealth } from '../types.ts';

type Props = {
  inert: boolean;
  health: BackendHealth | null;
  aiStatus: AiStatusResponse;
  statusError: string | null;
};

export function SystemStatusBar(props: Props) {
  const aiText = props.aiStatus.enabled
    ? `${props.aiStatus.locality} · ${props.aiStatus.model}`
    : 'disabled';

  return (
    <div className="scope-bar" inert={props.inert}>
      <p className="scope-note">
        Local snapshot only · no source execution · unsupported relationships
        and incomplete coverage stay visible.
      </p>
      <div className="system-pills" aria-label="Local service status">
        {props.health ? (
          <>
            <span
              className={`sys-pill ${props.health.ready ? 'sys-ok' : 'sys-warn'}`}
            >
              API: {props.health.api}
            </span>
            <span
              className={`sys-pill ${props.health.database === 'ready' ? 'sys-ok' : 'sys-warn'}`}
            >
              DB: {props.health.database}
            </span>
            <span
              className={`sys-pill ${props.health.worker === 'ready' ? 'sys-ok' : 'sys-warn'}`}
            >
              Worker: {props.health.worker}
            </span>
          </>
        ) : null}
        <span className="sys-pill">AI: {aiText}</span>
        {props.statusError ? (
          <span className="sys-pill sys-warn">{props.statusError}</span>
        ) : null}
      </div>
    </div>
  );
}
