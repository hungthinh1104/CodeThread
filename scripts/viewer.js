/* global document, Element, fetch, location */
import {
  byId,
  visibleText,
  symbolAnchor,
  appendText,
  actionButton,
} from './viewer-client/dom.js';
import {
  renderGraph,
  renderRelationships,
  renderUnknowns,
} from './viewer-client/projection.js';

import { createNavigationHistory } from './viewer-client/history.js';
import {
  renderProjects,
  renderProjectStatus,
  renderSourceFiles,
  renderContextChoices,
} from './viewer-client/repository.js';
const token = location.hash.slice(1);
const state = {
  projectId: null,
  snapshotId: null,
  rootSymbolId: null,
  relationKinds: ['calls'],
  direction: 'both',
  selectedRelationId: null,
  selectedGraphSymbolId: null,
  evidenceId: null,
};
const navigation = createNavigationHistory(20);
let repositoryMode = false,
  projectMetadata = null,
  projectQuerySequence = 0,
  followQuerySequence = 0;
let symbolChoices = [],
  pendingContextChoices = [],
  filePage = { offset: 0, nextOffset: null };
let symbolPage = { query: '', offset: 0, nextOffset: null, total: 0 };
let graphResult = null;
let symbolSearchSequence = 0;
let graphQuerySequence = 0;
let evidenceQuerySequence = 0;

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
  const projectId = state.projectId,
    snapshotId = state.snapshotId;
  const scoped =
    repositoryMode &&
    [
      '/api/session',
      '/api/symbols',
      '/api/neighbors',
      '/api/evidence',
      '/api/follow-context',
    ].includes(path);
  const payload = scoped ? { projectId, request: body } : body;
  const response = await fetch(path, {
    method,
    headers: {
      'X-CodeThread-Token': token,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(payload) }),
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
  if (scoped) {
    if (value.projectId !== projectId)
      throw new Error('The response belongs to another project context.');
    if (path === '/api/follow-context') return value;
    const responseSnapshotId =
      value.result?.snapshotId ??
      value.result?.graph?.meta?.snapshotId ??
      value.result?.meta?.snapshotId;
    if (path !== '/api/session' && responseSnapshotId !== snapshotId)
      throw new Error('The response belongs to another analysis snapshot.');
    return value.result;
  }
  return value;
}

function cloneState() {
  return {
    ...state,
    relationKinds: [...state.relationKinds],
    symbolPage: { ...symbolPage },
    globalSymbols: byId('global-symbols').checked,
  };
}

function applyQueryState(
  next,
  { remember = true, restore = null, focusRoot = false } = {},
) {
  const rootSymbolId = Object.hasOwn(next, 'rootSymbolId')
    ? next.rootSymbolId
    : state.rootSymbolId;
  const relationKinds = next.relationKinds ?? state.relationKinds;
  const direction = next.direction ?? state.direction;
  const queryChanged =
    rootSymbolId !== state.rootSymbolId ||
    direction !== state.direction ||
    relationKinds.length !== state.relationKinds.length ||
    relationKinds.some((kind) => !state.relationKinds.includes(kind));
  if (!queryChanged) return false;
  if (remember && state.rootSymbolId !== null) {
    navigation.remember(cloneState());
  }
  Object.assign(state, {
    rootSymbolId,
    relationKinds: [...relationKinds],
    direction,
    selectedRelationId: null,
    selectedGraphSymbolId: null,
    evidenceId: null,
  });
  followQuerySequence++;
  pendingContextChoices = [];
  byId('context-choices').hidden = true;
  renderHistoryButton();
  renderFilters();
  void loadGraph(restore, focusRoot);
  return true;
}

function renderHistoryButton() {
  const projectLoading = repositoryMode && state.snapshotId === null;
  byId('back').disabled = projectLoading || !navigation.canBack;
  byId('forward').disabled = projectLoading || !navigation.canForward;
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
    const global = repositoryMode && byId('global-symbols').checked;
    const result = await api(global ? '/api/catalog' : '/api/symbols', 'POST', {
      query,
      offset,
    });
    if (sequence !== symbolSearchSequence) return;
    symbolPage = {
      query: result.query,
      offset: result.offset,
      nextOffset: result.nextOffset,
      total: result.total,
    };
    const list = byId('symbol-results');
    list.replaceChildren();
    symbolChoices = result.items.map((item) =>
      item.symbol
        ? item
        : {
            projectId: state.projectId,
            snapshotId: state.snapshotId,
            symbol: item,
          },
    );
    for (const choice of symbolChoices) {
      const symbol = choice.symbol;
      const row = document.createElement('li');
      const button = actionButton(
        row,
        `${symbol.name} · ${symbol.kind} · ${symbolAnchor(symbol)}${global ? ' · ' + choice.projectLabel : ''}`,
        'select-root',
        {
          symbolId: symbol.id,
          ...(choice.projectId
            ? { projectId: choice.projectId, snapshotId: choice.snapshotId }
            : {}),
        },
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

async function followGraphSymbol(symbolId) {
  if (!graphResult?.graph.symbols.some((item) => item.id === symbolId)) {
    showError(
      'Only a symbol in the current validated projection can be followed.',
    );
    return false;
  }
  if (!repositoryMode)
    return applyQueryState({ rootSymbolId: symbolId }, { focusRoot: true });
  const sequence = ++followQuerySequence,
    graphSequence = graphQuerySequence;
  try {
    const result = await api('/api/follow-context', 'POST', {
      snapshotId: state.snapshotId,
      symbolId,
    });
    if (
      sequence !== followQuerySequence ||
      graphSequence !== graphQuerySequence
    )
      return false;
    pendingContextChoices = result.candidates;
    if (result.requiresChoice) {
      renderContextChoices(result.candidates);
      return true;
    }
    const candidate = result.candidates[0];
    if (candidate)
      await navigateToSymbol(
        candidate.symbolId,
        candidate.projectId,
        candidate.snapshotId,
      );
    return true;
  } catch (error) {
    if (
      sequence === followQuerySequence &&
      graphSequence === graphQuerySequence
    )
      showError(
        error instanceof Error ? error.message : 'Declaration handoff failed.',
      );
    return false;
  }
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

  renderGraph(graph, state);
  renderRelationships(graph, state);
  renderUnknowns(result.unknowns);
  renderSelection();
  if (state.evidenceId) void showEvidence(state.evidenceId);
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

async function restoreNavigation(direction) {
  if (repositoryMode && state.snapshotId === null) return;
  const previous = navigation.move(direction, cloneState());
  if (!previous) return;
  byId('global-symbols').checked = previous.globalSymbols;
  byId('symbol-query').value = previous.symbolPage.query;
  if (repositoryMode && previous.projectId !== state.projectId) {
    await changeProject(previous.projectId, {
      remember: false,
      rootSymbolId: previous.rootSymbolId,
      restore: previous,
    });
  } else {
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
    await loadSymbolPage(previous.symbolPage.query, previous.symbolPage.offset);
  }
  renderHistoryButton();
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
  } else if (event.target.id === 'project-select') {
    void changeProject(event.target.value);
  } else if (event.target.id === 'global-symbols') {
    void loadSymbolPage(byId('symbol-query').value, 0);
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
    const choice = symbolChoices.find(
      (item) =>
        item.symbol.id === symbolId &&
        (!repositoryMode ||
          (item.projectId === button.dataset.projectId &&
            item.snapshotId === button.dataset.snapshotId)),
    );
    if (!choice) {
      showError('Choose a declaration from the current search page.');
      return;
    }
    void navigateToSymbol(symbolId, choice.projectId, choice.snapshotId);
  } else if (action === 'choose-context') {
    const choice = pendingContextChoices.find(
      (item) =>
        item.symbolId === button.dataset.symbolId &&
        item.projectId === button.dataset.projectId &&
        item.snapshotId === button.dataset.snapshotId,
    );
    if (!choice) {
      showError('Choose a current verified declaration context.');
      return;
    }
    void navigateToSymbol(choice.symbolId, choice.projectId, choice.snapshotId);
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

byId('back').addEventListener('click', () => void restoreNavigation('back'));
byId('retry-project').addEventListener(
  'click',
  () => void changeProject(state.projectId, { remember: false }),
);
byId('forward').addEventListener(
  'click',
  () => void restoreNavigation('forward'),
);
byId('previous-files').addEventListener(
  'click',
  () => void loadFiles(Math.max(0, filePage.offset - 50)),
);
byId('next-files').addEventListener('click', () => {
  if (filePage.nextOffset !== null) void loadFiles(filePage.nextOffset);
});
byId('previous-symbols').addEventListener(
  'click',
  () =>
    void loadSymbolPage(symbolPage.query, Math.max(0, symbolPage.offset - 50)),
);
byId('next-symbols').addEventListener('click', () => {
  if (symbolPage.nextOffset !== null)
    void loadSymbolPage(symbolPage.query, symbolPage.nextOffset);
});

function renderSession(session) {
  byId('snapshot-summary').textContent = visibleText(
    `Snapshot ${session.snapshotId} · ${session.counts.files} source files · ${session.counts.declarations} declarations · ${session.counts.callSites} call sites · ${session.coverage} coverage`,
  );
  const coverage = byId('coverage');
  coverage.replaceChildren();
  for (const [name, status] of Object.entries(session.coverageByCapability))
    appendText(coverage, 'li', `${name}: ${status}`);
}

async function loadFiles(offset = 0) {
  try {
    const result = await api('/api/files', 'POST', { offset });
    filePage = { offset: result.offset, nextOffset: result.nextOffset };
    renderSourceFiles(result, projectMetadata);
  } catch (error) {
    showError(
      error instanceof Error
        ? error.message
        : 'Source inventory request failed.',
    );
  }
}

async function navigateToSymbol(symbolId, projectId, snapshotId) {
  if (
    repositoryMode &&
    (projectId !== state.projectId || state.snapshotId === null)
  ) {
    const project = projectMetadata.items.find(
      (item) => item.id === projectId && item.snapshotId === snapshotId,
    );
    if (!project) {
      showError('Declaration context is unavailable.');
      return;
    }
    await changeProject(projectId, { rootSymbolId: symbolId });
  } else {
    if (repositoryMode && snapshotId !== state.snapshotId) {
      showError('Declaration belongs to another snapshot.');
      return;
    }
    applyQueryState({ rootSymbolId: symbolId }, { focusRoot: true });
    await loadSymbolPage(symbolPage.query, symbolPage.offset);
  }
}

async function changeProject(
  projectId,
  { remember = true, rootSymbolId = null, restore = null } = {},
) {
  const project = projectMetadata.items.find(
    (item) => item.id === projectId && item.snapshotId,
  );
  if (!project) {
    showError('This project has no usable snapshot.');
    return;
  }
  if (remember && state.snapshotId) navigation.remember(cloneState());
  const sequence = ++projectQuerySequence;
  symbolSearchSequence++;
  graphQuerySequence++;
  evidenceQuerySequence++;
  followQuerySequence++;
  symbolChoices = [];
  pendingContextChoices = [];
  Object.assign(state, {
    projectId,
    snapshotId: null,
    rootSymbolId: null,
    selectedRelationId: null,
    selectedGraphSymbolId: null,
    evidenceId: null,
  });
  byId('symbol-results').replaceChildren();
  byId('symbol-count').textContent = '';
  byId('context-choices').hidden = true;
  byId('retry-project').hidden = true;
  renderProjectStatus(projectMetadata, projectId);
  renderHistoryButton();
  void loadGraph();
  byId('snapshot-summary').textContent = 'Loading project context…';
  clearError();
  try {
    const session = await api('/api/session', 'POST', {});
    if (sequence !== projectQuerySequence) return;
    if (session.snapshotId !== project.snapshotId)
      throw new Error('Project snapshot identity changed.');
    state.snapshotId = session.snapshotId;
    state.rootSymbolId = rootSymbolId;
    if (restore) {
      state.relationKinds = [...restore.relationKinds];
      state.direction = restore.direction;
    }
    renderSession(session);
    renderFilters();
    renderHistoryButton();
    await loadSymbolPage(
      restore?.symbolPage.query ?? symbolPage.query,
      restore?.symbolPage.offset ?? 0,
    );
    if (sequence !== projectQuerySequence) return;
    void loadGraph(restore, Boolean(rootSymbolId));
  } catch (error) {
    if (sequence === projectQuerySequence) {
      renderHistoryButton();
      byId('snapshot-summary').textContent =
        'Project context is unavailable. Select a context to retry.';
      byId('retry-project').hidden = false;
      showError(
        error instanceof Error ? error.message : 'Project context failed.',
      );
    }
  }
}

async function initialize() {
  if (!/^[a-f0-9]{64}$/i.test(token)) {
    showError('The viewer session token is missing or invalid.');
    return;
  }
  try {
    projectMetadata = await api('/api/projects', 'POST', {});
    repositoryMode = projectMetadata.mode === 'repository';
    renderProjects(projectMetadata);
    if (repositoryMode) {
      void loadFiles();
      if (projectMetadata.initialProjectId)
        await changeProject(projectMetadata.initialProjectId, {
          remember: false,
        });
      else {
        byId('snapshot-summary').textContent =
          'No usable project snapshot; inspect source inventory and project diagnostics.';
        showError(
          'All project contexts are unavailable; source coverage is incomplete.',
        );
      }
    } else {
      const session = await api('/api/session', 'POST', {});
      state.snapshotId = session.snapshotId;
      renderSession(session);
      await loadSymbolPage('', 0);
    }
  } catch (error) {
    showError(
      error instanceof Error ? error.message : 'Viewer initialization failed.',
    );
  }
}

renderFilters();
renderHistoryButton();
void initialize();
