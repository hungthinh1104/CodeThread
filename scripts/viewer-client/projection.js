/* global document */
import {
  byId,
  visibleText,
  symbolAnchor,
  appendText,
  actionButton,
} from './dom.js';
export function renderGraph(graph, state) {
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

export function renderRelationships(graph, state) {
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

export function renderUnknowns(unknowns) {
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
