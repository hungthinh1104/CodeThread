import { appendText } from './dom.js';

function renderMessage(panel, message) {
  panel.replaceChildren();
  appendText(panel, 'p', message);
}

function renderEvidence(panel, item, label) {
  panel.replaceChildren();
  appendText(panel, 'p', label, 'evidence-kind');
  if (!item) {
    appendText(panel, 'p', 'Evidence unavailable: EVIDENCE_NOT_FOUND');
    return;
  }
  if (item.status === 'unavailable') {
    appendText(panel, 'p', `Evidence unavailable: ${item.code}`);
    return;
  }

  const range = item.evidence.range;
  appendText(
    panel,
    'p',
    `${item.filePath}@${range.start.line}:${range.start.column}–${range.end.line}:${range.end.column}`,
  );
  appendText(panel, 'p', `Snapshot ${item.evidence.snapshotId}`);
  appendText(panel, 'p', `SHA-256 ${item.evidence.contentHash}`);
  appendText(panel, 'p', `Evidence ${item.evidence.id}`);
  appendText(panel, 'pre', item.text, 'evidence-excerpt');
}

export function renderEvidenceState(sourcePanel, inspectorPanel, state) {
  if (state.kind === 'empty') {
    renderMessage(sourcePanel, state.message);
    renderMessage(inspectorPanel, state.message);
    return;
  }
  if (state.kind === 'loading') {
    renderMessage(sourcePanel, 'Loading verified source evidence...');
    renderMessage(inspectorPanel, 'Loading verified source evidence...');
    return;
  }
  if (state.kind === 'error') {
    renderMessage(sourcePanel, `Evidence unavailable: ${state.message}`);
    renderMessage(inspectorPanel, `Evidence unavailable: ${state.message}`);
    return;
  }
  renderEvidence(sourcePanel, state.item, state.label);
  renderEvidence(inspectorPanel, state.item, state.label);
}
