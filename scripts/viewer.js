/* global document, Element, fetch, location */

const MAX_HISTORY = 20;
const token = location.hash.slice(1);
const byId = (id) => document.getElementById(id);
const state = {
  snapshotId: null,
  rootSymbolId: null,
  relationKinds: ['calls'],
  direction: 'both',
  selectedRelationId: null,
  selectedGraphSymbolId: null,
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

function applyQueryState(
  next,
  { remember = true, restore = null, focusRoot = false } = {},
) {
  const rootSymbolId = next.rootSymbolId ?? state.rootSymbolId;
  const relationKinds = next.relationKinds ?? state.relationKinds;
  const direction = next.direction ?? state.direction;
  const queryChanged =
    rootSymbolId !== state.rootSymbolId ||
    direction !== state.direction ||
    relationKinds.length !== state.relationKinds.length ||
    relationKinds.some((kind) => !state.relationKinds.includes(kind));
  if (!queryChanged) return false;
  if (remember && state.rootSymbolId !== null) {
    historyStack.push(cloneState());
    if (historyStack.length > MAX_HISTORY) historyStack.shift();
  }
  Object.assign(state, {
    rootSymbolId,
    relationKinds: [...relationKinds],
    direction,
    selectedRelationId: null,
    selectedGraphSymbolId: null,
    evidenceId: null,
  });
  renderHistoryButton();
  renderFilters();
  void loadGraph(restore, focusRoot);
  return true;
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

function restoreEligibleSelection(previous) {
  if (!graphResult) return;
  const graph = graphResult.graph;
  const relation = previous.selectedRelationId
    ? graph.relations.find((item) => item.id === previous.selectedRelationId)
    : undefined;
  const symbol = previous.selectedGraphSymbolId
    ? graph.symbols.find((item) => item.id === previous.selectedGraphSymbolId)
    : undefined;
  const evidenceId = previous.evidenceId;
  const evidenceAvailable =
    evidenceId !== null &&
    (graph.evidenceRefs.some((item) => item.id === evidenceId) ||
      graphResult.unknowns.items.some(
        (item) => item.evidenceId === evidenceId,
      ));
  const relationEvidenceMatches =
    !previous.selectedRelationId ||
    Boolean(
      relation &&
      evidenceId &&
      (relation.siteEvidenceId === evidenceId ||
        relation.resolution.evidenceIds.includes(evidenceId)),
    );
  const symbolEvidenceMatches =
    !previous.selectedGraphSymbolId ||
    Boolean(symbol && symbol.declarationEvidenceId === evidenceId);
  const evidenceMatches =
    evidenceAvailable && relationEvidenceMatches && symbolEvidenceMatches;

  state.selectedRelationId = relationEvidenceMatches
    ? (relation?.id ?? null)
    : null;
  state.selectedGraphSymbolId = symbolEvidenceMatches
    ? (symbol?.id ?? null)
    : null;
  state.evidenceId = evidenceMatches ? evidenceId : null;
  if (
    (previous.selectedRelationId && !relation) ||
    (previous.selectedGraphSymbolId && !symbol)
  ) {
    state.selectedRelationId = null;
    state.selectedGraphSymbolId = null;
    state.evidenceId = null;
  }
}

async function loadGraph(restore = null, focusRoot = false) {
  const sequence = ++graphQuerySequence;
  evidenceQuerySequence++;
  const status = byId('investigation-status');
  if (!state.rootSymbolId || !state.snapshotId) {
    graphResult = null;
    status.textContent = 'Select a symbol to begin.';
    byId('root-symbol').replaceChildren();
    byId('graph-symbol-selection').replaceChildren();
    byId('graph-symbol-selection').hidden = true;
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
  byId('graph-symbol-selection').replaceChildren();
  byId('graph-symbol-selection').hidden = true;
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
    if (restore) restoreEligibleSelection(restore);
    renderInvestigation();
    if (focusRoot)
      byId('root-symbol').querySelector('h3')?.focus({ preventScroll: true });
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

function renderSelection() {
  for (const edge of byId('graph').querySelectorAll(
    '.graph-edge[data-relation-id]',
  ))
    edge.classList.toggle(
      'selected',
      edge.dataset.relationId === state.selectedRelationId,
    );
  for (const edge of byId('graph').querySelectorAll(
    '.graph-edge-hit[data-relation-id]',
  ))
    edge.setAttribute(
      'aria-pressed',
      String(edge.dataset.relationId === state.selectedRelationId),
    );
  for (const node of byId('graph').querySelectorAll('[data-symbol-id]')) {
    const selected = node.dataset.symbolId === state.selectedGraphSymbolId;
    const isRoot = node.dataset.symbolId === state.rootSymbolId;
    node.classList.toggle('selected', selected);
    node.setAttribute('aria-pressed', String(selected || isRoot));
  }
  for (const row of byId('relationships').querySelectorAll(
    '.relationship-item[data-relation-id]',
  )) {
    const selected = row.dataset.relationId === state.selectedRelationId;
    row.classList.toggle('selected', selected);
    row
      .querySelector('[data-action="select-relation"]')
      ?.setAttribute('aria-pressed', String(selected));
  }
  renderGraphSymbolSelection();
}

function renderGraphSymbolSelection() {
  const panel = byId('graph-symbol-selection');
  const symbol = graphResult?.graph.symbols.find(
    (item) => item.id === state.selectedGraphSymbolId,
  );
  panel.replaceChildren();
  panel.hidden = !symbol;
  if (!symbol) return;
  appendText(panel, 'h3', `Selected symbol: ${symbol.kind} ${symbol.name}`);
  appendText(panel, 'p', symbolAnchor(symbol));
  const actions = document.createElement('div');
  actions.className = 'row-actions';
  actionButton(actions, 'View declaration evidence', 'evidence', {
    evidenceId: symbol.declarationEvidenceId,
    symbolId: symbol.id,
  });
  if (symbol.id !== state.rootSymbolId)
    actionButton(actions, `Follow symbol ${symbol.name}`, 'follow', {
      symbolId: symbol.id,
    });
  panel.append(actions);
}

function selectEvidence(
  evidenceId,
  { relationId = null, symbolId = null } = {},
) {
  if (!graphResult) {
    showError('Evidence selection requires a current validated projection.');
    return false;
  }
  const relation = relationId
    ? graphResult.graph.relations.find((item) => item.id === relationId)
    : undefined;
  const symbol = symbolId
    ? graphResult.graph.symbols.find((item) => item.id === symbolId)
    : undefined;
  const evidenceAvailable =
    graphResult.graph.evidenceRefs.some((item) => item.id === evidenceId) ||
    graphResult.unknowns.items.some((item) => item.evidenceId === evidenceId);
  const relationEvidenceMatches =
    relationId === null ||
    Boolean(
      relation &&
      (relation.siteEvidenceId === evidenceId ||
        relation.resolution.evidenceIds.includes(evidenceId)),
    );
  const symbolEvidenceMatches =
    symbolId === null || Boolean(symbol?.declarationEvidenceId === evidenceId);
  const symbolBelongsToRelation =
    !relation ||
    !symbol ||
    relation.sourceSymbolId === symbol.id ||
    (relation.resolution.status === 'exact' &&
      relation.resolution.targetId === symbol.id);
  if (
    !evidenceAvailable ||
    (relationId !== null && !relation) ||
    (symbolId !== null && !symbol) ||
    !relationEvidenceMatches ||
    !symbolEvidenceMatches ||
    !symbolBelongsToRelation
  ) {
    showError('The evidence is not in the current validated projection.');
    return false;
  }
  clearError();
  Object.assign(state, {
    selectedRelationId: relation?.id ?? null,
    selectedGraphSymbolId: symbol?.id ?? null,
    evidenceId,
  });
  renderSelection();
  void showEvidence(evidenceId);
  return true;
}

function selectRelation(relationId) {
  const relation = graphResult?.graph.relations.find(
    (item) => item.id === relationId,
  );
  if (!relation) {
    showError('The relationship is not in the current validated projection.');
    return false;
  }
  return selectEvidence(relation.siteEvidenceId, { relationId });
}

function selectGraphSymbol(symbolId) {
  const symbol = graphResult?.graph.symbols.find(
    (item) => item.id === symbolId,
  );
  if (!symbol) {
    showError('The symbol is not in the current validated projection.');
    return false;
  }
  return selectEvidence(symbol.declarationEvidenceId, { symbolId });
}

function followGraphSymbol(symbolId) {
  if (!graphResult?.graph.symbols.some((item) => item.id === symbolId)) {
    showError(
      'Only a symbol in the current validated projection can be followed.',
    );
    return false;
  }
  return applyQueryState({ rootSymbolId: symbolId }, { focusRoot: true });
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
  const rootHeading = appendText(rootPanel, 'h3', `${root.kind} ${root.name}`);
  rootHeading.tabIndex = -1;
  appendText(rootPanel, 'p', symbolAnchor(root));
  const rootActions = document.createElement('div');
  rootActions.className = 'row-actions';
  actionButton(rootActions, 'View declaration evidence', 'evidence', {
    evidenceId: root.declarationEvidenceId,
    symbolId: root.id,
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
  renderSelection();
  if (state.evidenceId) void showEvidence(state.evidenceId);
}

function renderGraph(graph) {
  const svg = byId('graph');
  svg.replaceChildren();
  svg.setAttribute('role', 'group');
  svg.setAttribute(
    'aria-label',
    'Bounded static source relationship graph. Activate a node for declaration evidence or an edge for occurrence evidence.',
  );
  const symbols = [...graph.symbols];
  const symbolMap = new Map(symbols.map((symbol) => [symbol.id, symbol]));
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
    const offset = (edgeIndex - (edgeCount - 1) / 2) * 22;
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
      const lift = 30 + edgeIndex * 24;
      edge.setAttribute(
        'd',
        `M ${source.x + 48} ${source.y + 12} C ${source.x + 45} ${source.y - lift}, ${source.x + 105} ${source.y - lift}, ${source.x + 102} ${source.y + 12}`,
      );
    }
    const sourceSymbol = symbolMap.get(relation.sourceSymbolId);
    const targetSymbol = symbolMap.get(relation.resolution.targetId);
    const siteEvidence = graph.evidenceRefs.find(
      (item) => item.id === relation.siteEvidenceId,
    );
    if (!sourceSymbol || !targetSymbol || !siteEvidence) continue;
    edge.dataset.relationId = relation.id;
    edge.setAttribute('aria-hidden', 'true');
    const hitTarget = edge.cloneNode(false);
    hitTarget.classList.remove('graph-edge', relation.kind);
    hitTarget.classList.add('graph-edge-hit');
    if (hitTarget.tagName.toLowerCase() === 'line') {
      const x1 = hitTarget.getAttribute('x1');
      const x2 = hitTarget.getAttribute('x2');
      const y1 = hitTarget.getAttribute('y1');
      const y2 = hitTarget.getAttribute('y2');
      if (y1 === y2 && y2 !== null)
        hitTarget.setAttribute('y2', String(Number(y2) + 1));
      else if (x1 === x2 && x2 !== null)
        hitTarget.setAttribute('x2', String(Number(x2) + 1));
    }
    hitTarget.removeAttribute('aria-hidden');
    hitTarget.dataset.relationId = relation.id;
    hitTarget.dataset.action = 'select-relation';
    hitTarget.setAttribute('role', 'button');
    hitTarget.setAttribute('tabindex', '0');
    hitTarget.setAttribute('focusable', 'true');
    hitTarget.setAttribute('aria-pressed', 'false');
    hitTarget.setAttribute(
      'aria-label',
      visibleText(
        `${relation.kind.toUpperCase()} occurrence at ${sourceSymbol.filePath}:${siteEvidence.range.start.line}:${siteEvidence.range.start.column}, from ${sourceSymbol.name} to ${targetSymbol.name}; select and inspect verified occurrence evidence`,
      ),
    );
    svg.append(hitTarget, edge);
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
    group.classList.add('graph-node-control');
    if (symbol.id === state.rootSymbolId)
      group.classList.add('graph-node-root');
    group.dataset.symbolId = symbol.id;
    group.dataset.action = 'select-node';
    group.setAttribute('role', 'button');
    group.setAttribute('tabindex', '0');
    group.setAttribute('focusable', 'true');
    group.setAttribute(
      'aria-label',
      visibleText(
        `${symbol.kind} ${symbol.name} at ${symbolAnchor(symbol)}${symbol.id === state.rootSymbolId ? ', current investigation root' : ', select symbol and inspect declaration evidence'}`,
      ),
    );
    group.setAttribute(
      'aria-pressed',
      String(
        symbol.id === state.rootSymbolId ||
          symbol.id === state.selectedGraphSymbolId,
      ),
    );
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
    row.dataset.relationId = relation.id;
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
      relationId: relation.id,
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
          {
            evidenceId: symbol.declarationEvidenceId,
            relationId: relation.id,
            symbolId: symbol.id,
          },
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
  const changed = applyQueryState(
    {
      rootSymbolId: previous.rootSymbolId,
      relationKinds: previous.relationKinds,
      direction: previous.direction,
    },
    { remember: false, restore: previous },
  );
  if (!changed && graphResult) {
    restoreEligibleSelection(previous);
    renderSelection();
    if (state.evidenceId) void showEvidence(state.evidenceId);
  }
}

function activateGraphControl(target) {
  if (!(target instanceof Element)) return;
  const control = target.closest(
    '#graph [data-action="select-relation"], #graph [data-action="select-node"]',
  );
  if (!control) return;
  if (control.dataset.action === 'select-relation')
    selectRelation(control.dataset.relationId);
  else if (control.dataset.action === 'select-node')
    selectGraphSymbol(control.dataset.symbolId);
}

byId('graph').addEventListener('click', (event) => {
  activateGraphControl(event.target);
});

byId('graph').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  activateGraphControl(event.target);
});

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
    applyQueryState({ relationKinds: selected });
  } else if (event.target.id === 'direction') {
    applyQueryState({ direction: event.target.value });
  }
});

document.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'select-root') {
    const symbolId = button.dataset.symbolId;
    if (!symbolId) return;
    applyQueryState({ rootSymbolId: symbolId }, { focusRoot: true });
    void loadSymbolPage(symbolPage.query, symbolPage.offset);
  } else if (action === 'follow') {
    const symbolId = button.dataset.symbolId;
    if (!symbolId) return;
    followGraphSymbol(symbolId);
  } else if (action === 'select-relation') {
    const relationId = button.dataset.relationId;
    if (!relationId) return;
    selectRelation(relationId);
  } else if (action === 'evidence') {
    const evidenceId = button.dataset.evidenceId;
    if (!evidenceId) return;
    selectEvidence(evidenceId, {
      relationId: button.dataset.relationId ?? null,
      symbolId: button.dataset.symbolId ?? null,
    });
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
