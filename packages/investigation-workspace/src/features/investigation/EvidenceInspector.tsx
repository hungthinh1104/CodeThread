import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';
import { CodeExcerpt } from './CodeExcerpt.tsx';
import type { EvidenceProjection } from './types.ts';

const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' ? useLayoutEffect : useEffect;

type EvidenceItem = EvidenceProjection['items'][number];

type EvidenceRole = 'declaration' | 'occurrence' | 'observation';

const EVIDENCE_ROLE_LABEL: Record<EvidenceRole, string> = {
  declaration: 'Declaration evidence',
  occurrence: 'Occurrence evidence',
  observation: 'Observation evidence',
};

type Props = {
  item: EvidenceItem | null;
  evidenceRole?: EvidenceRole | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  compact: boolean;
  open: boolean;
  onClose: () => void;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
};

export function EvidenceInspector(props: Props) {
  const [copyStatus, setCopyStatus] = useState<
    'idle' | 'copied' | 'unavailable'
  >('idle');

  useEffect(() => {
    setCopyStatus('idle');
  }, [props.item]);

  useIsomorphicLayoutEffect(() => {
    if (!props.compact || !props.open) return;
    props.closeButtonRef.current?.focus();
  }, [props.compact, props.open, props.closeButtonRef]);

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
    return () => document.removeEventListener('keydown', close);
  }, [props.compact, props.open, props.onClose]);

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
        <div className="inspector-header pane-header">
          <div>
            <p className="step-label">03 / Evidence</p>
            <h2 id="evidence-heading">Evidence inspector</h2>
          </div>
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
        </div>
        <div className="pane-body">
          <p className="muted small inspector-subtitle">
            Evidence is verified against the pinned snapshot. Static facts do
            not establish runtime execution.
          </p>
          {props.loading ? (
            <p role="status">Loading verified evidence…</p>
          ) : null}
          {props.error ? (
            <div className="notice error" role="alert">
              <span>{props.error}</span>
              <button type="button" onClick={props.onRetry}>
                Retry evidence
              </button>
            </div>
          ) : null}
          {!props.item && !props.loading && !props.error ? (
            <p className="inspector-empty">
              Select a declaration or relation occurrence.
            </p>
          ) : null}
          {props.item?.status === 'available' ? (
            <div className="evidence-card">
              <div className="evidence-details">
                <div className="evidence-role-row">
                  {props.evidenceRole ? (
                    <p className={`evidence-role role-${props.evidenceRole}`}>
                      {EVIDENCE_ROLE_LABEL[props.evidenceRole]}
                    </p>
                  ) : (
                    <span />
                  )}
                  <button
                    className="btn-ghost copy-ref-btn"
                    type="button"
                    aria-label={
                      copyStatus === 'copied'
                        ? 'Source reference copied'
                        : copyStatus === 'unavailable'
                          ? 'Clipboard unavailable for source reference'
                          : 'Copy source reference'
                    }
                    onClick={() => {
                      const refText =
                        props.item?.status === 'available'
                          ? `${props.item.filePath}:${props.item.evidence.range.start.line}`
                          : '';
                      if (!refText || !navigator.clipboard?.writeText) {
                        setCopyStatus('unavailable');
                        return;
                      }
                      void navigator.clipboard.writeText(refText).then(
                        () => setCopyStatus('copied'),
                        () => setCopyStatus('unavailable'),
                      );
                    }}
                  >
                    {copyStatus === 'copied'
                      ? 'Copied'
                      : copyStatus === 'unavailable'
                        ? 'Copy unavailable'
                        : 'Copy ref'}
                  </button>
                  <span className="sr-only" role="status" aria-live="polite">
                    {copyStatus === 'copied'
                      ? `Copied ${props.item.filePath}:${props.item.evidence.range.start.line}`
                      : copyStatus === 'unavailable'
                        ? 'Clipboard is unavailable; copy the source location from the metadata table.'
                        : ''}
                  </span>
                </div>
                <dl className="evidence-meta">
                  <div>
                    <dt>Source</dt>
                    <dd>
                      <code>{props.item.filePath}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Location</dt>
                    <dd>
                      Line {props.item.evidence.range.start.line}, column{' '}
                      {props.item.evidence.range.start.column}
                    </dd>
                  </div>
                  <div>
                    <dt>SHA-256</dt>
                    <dd>
                      <code className="hash">
                        {props.item.evidence.contentHash}
                      </code>
                    </dd>
                  </div>
                  <div>
                    <dt>Extractor</dt>
                    <dd>
                      {props.item.evidence.extractor.name}{' '}
                      {props.item.evidence.extractor.version}
                    </dd>
                  </div>
                </dl>
              </div>
              <div className="evidence-code-col">
                <CodeExcerpt
                  text={props.item.text}
                  startLine={props.item.evidence.range.start.line}
                  focusable
                />
                <p className="caption">
                  Exact verified evidence excerpt; this is not the complete
                  file.
                </p>
              </div>
            </div>
          ) : null}
          {props.item?.status === 'unavailable' ? (
            <p className="notice warning" role="status">
              Evidence unavailable: {props.item.code}. No working-tree source
              was substituted.
            </p>
          ) : null}
        </div>
      </aside>
    </>
  );
}
