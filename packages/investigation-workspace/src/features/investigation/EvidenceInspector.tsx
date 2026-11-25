import { useEffect, type ReactNode, type RefObject } from 'react';
import type { EvidenceProjection } from './types.ts';

type EvidenceItem = EvidenceProjection['items'][number];

type Props = {
  item: EvidenceItem | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  compact: boolean;
  open: boolean;
  onClose: () => void;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  generatedNotes?: ReactNode;
};

export function EvidenceInspector(props: Props) {
  useEffect(() => {
    if (!props.compact || !props.open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        props.onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = document.getElementById('evidence-inspector');
      const focusable = panel?.querySelectorAll<HTMLElement>(
        'button:not(:disabled):not([hidden]), a[href], input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', close);
    props.closeButtonRef.current?.focus();
    return () => document.removeEventListener('keydown', close);
  }, [props.compact, props.open, props.onClose, props.closeButtonRef]);

  return (
    <>
      {props.compact && props.open ? (
        <button
          className="inspector-backdrop"
          type="button"
          aria-hidden="true"
          tabIndex={-1}
          onClick={props.onClose}
        />
      ) : null}
      <aside
        id="evidence-inspector"
        className={`region inspector${props.compact ? ' inspector-drawer' : ''}${props.open ? ' is-open' : ''}`}
        aria-labelledby="evidence-heading"
        aria-hidden={props.compact ? !props.open : undefined}
        aria-modal={props.compact ? props.open : undefined}
        role={props.compact ? 'dialog' : undefined}
        hidden={props.compact && !props.open}
        inert={props.compact && !props.open}
      >
        <button
          id="close-inspector"
          ref={props.closeButtonRef}
          className="inspector-close"
          type="button"
          hidden={!props.compact}
          onClick={props.onClose}
        >
          Close evidence
        </button>
        <p className="step-label">03 / Evidence</p>
        <h2 id="evidence-heading">Evidence inspector</h2>
        <p className="muted small">
          Evidence is verified against the pinned snapshot. Static facts do not
          establish runtime execution.
        </p>
        {props.loading ? <p role="status">Loading verified evidence…</p> : null}
        {props.error ? (
          <p className="notice error" role="alert">
            {props.error}
            <button type="button" onClick={props.onRetry}>
              Retry evidence
            </button>
          </p>
        ) : null}
        {!props.item && !props.loading && !props.error ? (
          <p className="empty-state">
            Select a declaration or relation occurrence.
          </p>
        ) : null}
        {props.item?.status === 'available' ? (
          <div className="evidence-card">
            <p>
              <strong>Source</strong>
              <code>{props.item.filePath}</code>
            </p>
            <p>
              <strong>Location</strong>
              <span>
                Line {props.item.evidence.range.start.line}, column{' '}
                {props.item.evidence.range.start.column}
              </span>
            </p>
            <p>
              <strong>SHA-256</strong>
              <code className="hash">{props.item.evidence.contentHash}</code>
            </p>
            <p>
              <strong>Extractor</strong>
              <span>
                {props.item.evidence.extractor.name}{' '}
                {props.item.evidence.extractor.version}
              </span>
            </p>
            <pre className="evidence-text" tabIndex={0}>
              {props.item.text}
            </pre>
            <p className="caption">
              Exact verified evidence excerpt; this is not the complete file.
            </p>
          </div>
        ) : null}
        {props.item?.status === 'unavailable' ? (
          <p className="notice warning" role="status">
            Evidence unavailable: {props.item.code}. No working-tree source was
            substituted.
          </p>
        ) : null}
        {props.generatedNotes ?? null}
      </aside>
    </>
  );
}
