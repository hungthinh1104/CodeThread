/* global document, fetch, location */

const MAX_HISTORY = 20;
const token = location.hash.slice(1);
const byId = (id) => document.getElementById(id);
const state = {
  snapshotId: null,
  rootSymbolId: null,
  relationKinds: ['calls'],
  direction: 'both',
  selectedRelationId: null,
  evidenceId: null,
};
const historyStack = [];
let symbolPage = { query: '', offset: 0, nextOffset: null, total: 0 };
let graphResult = null;
let symbolSearchSequence = 0;
let graphQuerySequence = 0;
let evidenceQuerySequence = 0;

function visibleText(value) {
  let result = '';
  for (const character of String(value)) {
    const point = character.codePointAt(0);
    if (
      (point < 0x20 && point !== 0x09 && point !== 0x0a && point !== 0x0d) ||
      (point >= 0x7f && point <= 0x9f) ||
      point === 0x2028 ||
      point === 0x2029 ||
      /\p{Cf}/u.test(character)
    ) {
      result += `\\u{${point.toString(16)}}`;
    } else {
      result += character;
    }
  }
  return result;
}

function showError(message) {
  const error = byId('error');
  error.textContent = visibleText(message);
  error.hidden = false;
}

function clearError() {
  const error = byId('error');
  error.textContent = '';
  error.hidden = true;
}

async function api(path, method, body) {
  const response = await fetch(path, {
    method,
    headers: {
      'X-CodeThread-Token': token,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: 'no-store',
    credentials: 'same-origin',
    referrerPolicy: 'no-referrer',
  });
  let value;
  try {
    value = await response.json();
  } catch {
    throw new Error('The local viewer returned an invalid response.');
  }
  if (!response.ok) {
    const code = value?.error?.code ?? 'REQUEST_FAILED';
    const message = value?.error?.message ?? 'The local request failed.';
    throw new Error(`${code}: ${message}`);
  }
  return value;
}

function appendText(parent, tag, text, className) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  item.textContent = visibleText(text);
  parent.append(item);
  return item;
}

function actionButton(parent, label, action, data = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = visibleText(label);
  button.dataset.action = action;
  for (const [key, value] of Object.entries(data)) button.dataset[key] = value;
  parent.append(button);
  return button;
}

function symbolAnchor(symbol) {
  return `${symbol.filePath}@${symbol.range.start.line}:${symbol.range.start.column}`;
}

function cloneState() {
  return { ...state, relationKinds: [...state.relationKinds] };
}

function applyState(next, remember = true) {
  if (remember && state.rootSymbolId !== null) {
    historyStack.push(cloneState());
    if (historyStack.length > MAX_HISTORY) historyStack.shift();
  }
  Object.assign(state, next);
  renderHistoryButton();
  renderFilters();
  void loadGraph();
}

function renderHistoryButton() {
  byId('back').disabled = historyStack.length === 0;
}

function renderFilters() {
  for (const input of document.querySelectorAll('input[name="kind"]'))
    input.checked = state.relationKinds.includes(input.value);
  byId('direction').value = state.direction;
}

async function loadSymbolPage(query = symbolPage.query, offset = 0) {
  const sequence = ++symbolSearchSequence;
  clearError();
  try {
    const result = await api('/api/symbols', 'POST', { query, offset });
    if (sequence !== symbolSearchSequence) return;
    symbolPage = {
      query: result.query,
      offset: result.offset,
      nextOffset: result.nextOffset,
      total: result.total,
    };
    const list = byId('symbol-results');
    list.replaceChildren();
    for (const symbol of result.items) {
      const row = document.createElement('li');
      const button = actionButton(
        row,
        `${symbol.name} · ${symbol.kind} · ${symbolAnchor(symbol)}`,
        'select-root',
        { symbolId: symbol.id },
      );
      button.className = 'symbol-choice';
      button.setAttribute(
        'aria-current',
        String(state.rootSymbolId === symbol.id),
      );
      list.append(row);
    }
    byId('symbol-count').textContent =
      result.total === 0
        ? 'No matching declarations.'
        : `Showing ${result.offset + 1}–${result.offset + result.items.length} of ${result.total} declarations.`;
    byId('previous-symbols').disabled = result.offset === 0;
    byId('next-symbols').disabled = result.nextOffset === null;
  } catch (error) {
    if (sequence !== symbolSearchSequence) return;
    showError(error instanceof Error ? error.message : 'Symbol search failed.');
  }
}

async function loadGraph() {
  const sequence = ++graphQuerySequence;
  evidenceQuerySequence++;
  const status = byId('investigation-status');
  if (!state.rootSymbolId || !state.snapshotId) {
    graphResult = null;
    status.textContent = 'Select a symbol to begin.';
    byId('root-symbol').replaceChildren();
    byId('relationships').replaceChildren();
    byId('unknowns').replaceChildren();
    byId('evidence').textContent =
      'Choose an evidence control to inspect retained source.';
    clearGraph();
    return;
  }
  clearError();
  status.textContent = 'Loading bounded source relationships…';
  graphResult = null;
  byId('root-symbol').replaceChildren();
  byId('relationships').replaceChildren();
  byId('unknowns').replaceChildren();
  byId('evidence').textContent =
    'Choose an evidence control to inspect retained source.';
  clearGraph();
  const request = {
    snapshotId: state.snapshotId,
    symbolId: state.rootSymbolId,
    direction: state.direction,
    relationKinds: [...state.relationKinds],
    depth: 2,
    nodeLimit: 50,
  };
  try {
    const result = await api('/api/neighbors', 'POST', request);
    if (sequence !== graphQuerySequence) return;
    graphResult = result;
    renderInvestigation();
  } catch (error) {
    if (sequence !== graphQuerySequence) return;
    graphResult = null;
    status.textContent = 'The requested projection is unavailable.';
    showError(error instanceof Error ? error.message : 'Investigation failed.');
  }
}

function clearGraph() {
  const svg = byId('graph');
  svg.replaceChildren();
  svg.setAttribute('viewBox', '0 0 640 150');
}

function renderInvestigation() {
  const result = graphResult;
  if (!result) return;
  const graph = result.graph;
  const root = graph.symbols.find((symbol) => symbol.id === graph.rootSymbolId);
  if (!root) {
    showError('The projection did not include its selected root.');
    return;
  }
  const rootPanel = byId('root-symbol');
  rootPanel.replaceChildren();
  appendText(rootPanel, 'h3', `${root.kind} ${root.name}`);
  appendText(rootPanel, 'p', symbolAnchor(root));
  const rootActions = document.createElement('div');
  rootActions.className = 'row-actions';
  actionButton(rootActions, 'View declaration evidence', 'evidence', {
    evidenceId: root.declarationEvidenceId,
  });
  rootPanel.append(rootActions);

  const truncation = graph.meta.truncated
    ? `Query truncated: ${graph.meta.truncationReasons.join(', ')}.`
    : 'The engine reported no truncation for this bounded query.';
  byId('investigation-status').textContent =
    `${truncation} Depth ${graph.meta.appliedLimits.depth}, node limit ${graph.meta.appliedLimits.nodes}. ` +
    'Coverage may be partial; an empty result does not prove no relationship exists.';

  renderGraph(graph);
  renderRelationships(graph);
  renderUnknowns(result.unknowns);
  if (state.evidenceId) void showEvidence(state.evidenceId);
}

function renderGraph(graph) {
  const svg = byId('graph');
  svg.replaceChildren();
  const symbols = [...graph.symbols];
  const positions = new Map();
  const cellWidth = 210;
  const rowHeight = 105;
  const width = 660;
  const height = Math.max(150, Math.ceil(symbols.length / 3) * rowHeight + 30);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const marker = document.createElementNS(
    'http://www.w3.org/2000/svg',
    'marker',
  );
  marker.setAttribute('id', 'arrow');
  marker.setAttribute('viewBox', '0 0 10 10');
  marker.setAttribute('refX', '8');
  marker.setAttribute('refY', '5');
  marker.setAttribute('markerWidth', '6');
  marker.setAttribute('markerHeight', '6');
  marker.setAttribute('orient', 'auto-start-reverse');
  const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  arrow.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
  arrow.setAttribute('fill', 'currentColor');
  marker.append(arrow);
  defs.append(marker);
  svg.append(defs);

  symbols.forEach((symbol, index) => {
    positions.set(symbol.id, {
      x: 100 + (index % 3) * cellWidth,
      y: 48 + Math.floor(index / 3) * rowHeight,
    });
  });
  const exactRelations = graph.relations.filter(
    (relation) => relation.resolution.status === 'exact',
  );
  const edgeTotals = new Map();
  for (const relation of exactRelations) {
    const key = `${relation.sourceSymbolId}:${relation.resolution.targetId}`;
    edgeTotals.set(key, (edgeTotals.get(key) ?? 0) + 1);
  }
  const edgeSeen = new Map();
  for (const relation of exactRelations) {
    const source = positions.get(relation.sourceSymbolId);
    const target = positions.get(relation.resolution.targetId);
    if (!source || !target) continue;
    const edgeKey = `${relation.sourceSymbolId}:${relation.resolution.targetId}`;
    const edgeIndex = edgeSeen.get(edgeKey) ?? 0;
    edgeSeen.set(edgeKey, edgeIndex + 1);
    const edgeCount = edgeTotals.get(edgeKey);
    const offset = (edgeIndex - (edgeCount - 1) / 2) * 10;
    const deltaX = target.x - source.x;
    const deltaY = target.y - source.y;
    const distance = Math.hypot(deltaX, deltaY) || 1;
    const normalX = -deltaY / distance;
    const normalY = deltaX / distance;
    const edge = document.createElementNS(
      'http://www.w3.org/2000/svg',
      source.x === target.x && source.y === target.y ? 'path' : 'line',
    );
    edge.classList.add('graph-edge', relation.kind);
    if (edge.tagName.toLowerCase() === 'line') {
      edge.setAttribute('x1', String(source.x + 75 + normalX * offset));
      edge.setAttribute('y1', String(source.y + 24 + normalY * offset));
      edge.setAttribute('x2', String(target.x + 75 + normalX * offset));
      edge.setAttribute('y2', String(target.y + 24 + normalY * offset));
    } else {
      const lift = 24 + edgeIndex * 9;
      edge.setAttribute(
        'd',
        `M ${source.x + 48} ${source.y + 12} C ${source.x + 45} ${source.y - lift}, ${source.x + 105} ${source.y - lift}, ${source.x + 102} ${source.y + 12}`,
      );
    }
    svg.append(edge);
    const label = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'text',
    );
    label.classList.add('graph-edge-label');
    label.textContent = relation.kind.toUpperCase();
    label.setAttribute(
      'x',
      String((source.x + target.x) / 2 + 75 + normalX * offset),
    );
    label.setAttribute(
      'y',
      String((source.y + target.y) / 2 + normalY * offset - 8),
    );
    svg.append(label);
  }
  symbols.forEach((symbol) => {
    const position = positions.get(symbol.id);
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.classList.add('graph-node');
    rect.setAttribute('x', String(position.x));
    rect.setAttribute('y', String(position.y));
    rect.setAttribute('width', '150');
    rect.setAttribute('height', '48');
    rect.setAttribute('rx', '6');
    const label = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'text',
    );
    label.classList.add('graph-node-text');
    label.setAttribute('x', String(position.x + 8));
    label.setAttribute('y', String(position.y + 19));
    const name = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'tspan',
    );
    name.textContent = visibleText(symbol.name.slice(0, 19));
    label.append(name);
    const location = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'tspan',
    );
    location.setAttribute('x', String(position.x + 8));
    location.setAttribute('dy', '16');
    location.textContent = visibleText(
      `${symbol.filePath}:${symbol.range.start.line}`.slice(0, 24),
    );
    label.append(location);
    group.append(rect, label);
    svg.append(group);
  });
}

function renderRelationships(graph) {
  const list = byId('relationships');
  list.replaceChildren();
  if (graph.relations.length === 0) {
    appendText(
      list,
      'li',
      `No ${state.relationKinds.join(' or ').toUpperCase()} rows were returned for this direction. Coverage and query bounds remain in effect.`,
    );
  }
  const symbolMap = new Map(graph.symbols.map((symbol) => [symbol.id, symbol]));
  for (const relation of graph.relations) {
    const row = document.createElement('li');
    row.className = 'relationship-item';
    if (relation.id === state.selectedRelationId) row.classList.add('selected');
    const source = symbolMap.get(relation.sourceSymbolId);
    const target =
      relation.resolution.status === 'exact'
        ? symbolMap.get(relation.resolution.targetId)
        : undefined;
    const sourceIsRoot = relation.sourceSymbolId === state.rootSymbolId;
    const targetIsRoot = target?.id === state.rootSymbolId;
    const relativeDirection = sourceIsRoot
      ? 'outgoing from selected symbol'
      : targetIsRoot
        ? 'incoming to selected symbol'
        : 'within selected neighborhood';
    const status = relation.resolution.status;
    const heading = document.createElement('p');
    const badge = document.createElement('span');
    badge.className = `relation-label ${relation.kind}`;
    badge.textContent = relation.kind.toUpperCase();
    heading.append(badge);
    heading.append(
      document.createTextNode(` ${status} · ${relativeDirection}`),
    );
    row.append(heading);
    appendText(row, 'p', `Relation identity: ${relation.id}`);
    appendText(
      row,
      'p',
      `Source: ${source ? `${source.name} (${symbolAnchor(source)}) · ${source.id}` : relation.sourceSymbolId}`,
    );
    if (target)
      appendText(
        row,
        'p',
        `Target: ${target.name} (${target.kind}) · ${symbolAnchor(target)} · ${target.id}`,
      );
    else
      appendText(
        row,
        'p',
        'Target: unknown; no exact declaration is available to follow.',
      );
    if (status !== 'exact') {
      const diagnosticIds = relation.resolution.diagnosticIds ?? [];
      for (const id of diagnosticIds) {
        const diagnostic = graph.diagnostics.find((item) => item.id === id);
        if (diagnostic)
          appendText(row, 'p', `${diagnostic.code}: ${diagnostic.message}`);
      }
    }
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    actionButton(actions, 'Select relationship', 'select-relation', {
      relationId: relation.id,
    });
    actionButton(actions, 'View occurrence evidence', 'evidence', {
      evidenceId: relation.siteEvidenceId,
    });
    if (status === 'exact') {
      const followable = [source, target].filter(
        (symbol) => symbol && symbol.id !== state.rootSymbolId,
      );
      for (const symbol of followable) {
        actionButton(
          actions,
          `View ${symbol.name} declaration evidence`,
          'evidence',
          { evidenceId: symbol.declarationEvidenceId },
        );
        actionButton(actions, `Follow ${symbol.name}`, 'follow', {
          symbolId: symbol.id,
        });
      }
    }
    row.append(actions);
    list.append(row);
  }
}

function renderUnknowns(unknowns) {
  const list = byId('unknowns');
  list.replaceChildren();
  if (unknowns.total === 0) {
    appendText(
      list,
      'li',
      'No unrepresented uncertain observations were returned for this symbol.',
    );
    return;
  }
  for (const observation of unknowns.items) {
    const row = document.createElement('li');
    row.className = 'relationship-item';
    appendText(row, 'p', `Observation status: ${observation.status}`);
    if (observation.diagnostic)
      appendText(
        row,
        'p',
        `${observation.diagnostic.code}: ${observation.diagnostic.message}`,
      );
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    actionButton(actions, 'View uncertain site evidence', 'evidence', {
      evidenceId: observation.evidenceId,
    });
    row.append(actions);
    list.append(row);
  }
  if (unknowns.total > unknowns.items.length)
    appendText(
      list,
      'li',
      `${unknowns.total - unknowns.items.length} additional uncertain observations are omitted by the viewer display bound.`,
    );
}

async function showEvidence(evidenceId) {
  if (!state.snapshotId) return;
  const sequence = ++evidenceQuerySequence;
  const snapshotId = state.snapshotId;
  const panel = byId('evidence');
  panel.replaceChildren();
  appendText(panel, 'p', 'Loading verified source…');
  try {
    const result = await api('/api/evidence', 'POST', {
      snapshotId,
      evidenceIds: [evidenceId],
    });
    if (sequence !== evidenceQuerySequence || state.evidenceId !== evidenceId)
      return;
    const item = result.items[0];
    panel.replaceChildren();
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
    appendText(panel, 'p', `SHA-256 ${item.evidence.contentHash}`);
    appendText(panel, 'pre', item.text, 'evidence-excerpt');
  } catch (error) {
    if (sequence !== evidenceQuerySequence || state.evidenceId !== evidenceId)
      return;
    panel.replaceChildren();
    appendText(
      panel,
      'p',
      error instanceof Error ? error.message : 'Evidence lookup failed.',
    );
  }
}

function restorePrevious() {
  const previous = historyStack.pop();
  if (!previous) return;
  Object.assign(state, previous);
  renderHistoryButton();
  renderFilters();
  void loadGraph();
}

document.addEventListener('submit', (event) => {
  if (event.target.id !== 'symbol-search') return;
  event.preventDefault();
  void loadSymbolPage(byId('symbol-query').value, 0);
});

document.addEventListener('change', (event) => {
  if (event.target.matches('input[name="kind"]')) {
    const selected = [
      ...document.querySelectorAll('input[name="kind"]:checked'),
    ].map((input) => input.value);
    if (selected.length === 0) {
      event.target.checked = true;
      showError('Choose at least one relationship kind.');
      return;
    }
    applyState({
      relationKinds: selected,
      selectedRelationId: null,
      evidenceId: null,
    });
  } else if (event.target.id === 'direction') {
    applyState({
      direction: event.target.value,
      selectedRelationId: null,
      evidenceId: null,
    });
  }
});

document.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'select-root') {
    const symbolId = button.dataset.symbolId;
    if (!symbolId) return;
    applyState({
      rootSymbolId: symbolId,
      selectedRelationId: null,
      evidenceId: null,
    });
    void loadSymbolPage(symbolPage.query, symbolPage.offset);
  } else if (action === 'follow') {
    const symbolId = button.dataset.symbolId;
    if (!symbolId) return;
    applyState({
      rootSymbolId: symbolId,
      selectedRelationId: null,
      evidenceId: null,
    });
  } else if (action === 'select-relation') {
    const relationId = button.dataset.relationId;
    if (!relationId) return;
    applyState({ selectedRelationId: relationId, evidenceId: null });
  } else if (action === 'evidence') {
    const evidenceId = button.dataset.evidenceId;
    if (!evidenceId) return;
    Object.assign(state, { evidenceId });
    void showEvidence(evidenceId);
  }
});

byId('back').addEventListener('click', restorePrevious);
byId('previous-symbols').addEventListener(
  'click',
  () =>
    void loadSymbolPage(symbolPage.query, Math.max(0, symbolPage.offset - 50)),
);
byId('next-symbols').addEventListener('click', () => {
  if (symbolPage.nextOffset !== null)
    void loadSymbolPage(symbolPage.query, symbolPage.nextOffset);
});

async function initialize() {
  if (!/^[a-f0-9]{64}$/i.test(token)) {
    showError('The viewer session token is missing or invalid.');
    return;
  }
  try {
    const session = await api('/api/session', 'POST', {});
    state.snapshotId = session.snapshotId;
    byId('snapshot-summary').textContent =
      `Snapshot ${session.snapshotId} · ${session.counts.files} source files · ${session.counts.declarations} declarations · ${session.counts.callSites} call sites · ${session.coverage} coverage`;
    const coverage = byId('coverage');
    coverage.replaceChildren();
    for (const [name, status] of Object.entries(session.coverageByCapability))
      appendText(coverage, 'li', `${name}: ${status}`);
    await loadSymbolPage('', 0);
  } catch (error) {
    showError(
      error instanceof Error ? error.message : 'Viewer initialization failed.',
    );
  }
}

renderFilters();
renderHistoryButton();
void initialize();
