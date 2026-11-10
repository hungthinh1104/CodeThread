import { byId, visibleText, appendText, actionButton } from './dom.js';

export function renderProjects(metadata) {
  const repository = metadata.mode === 'repository';
  byId('repository-controls').hidden = !repository;
  byId('catalog-label').hidden = !repository;
  if (!repository) return;
  const source = metadata.source;
  byId('repository-summary').textContent = visibleText(
    `Pinned commit ${metadata.commitId}; ${source.files} .ts files, ${source.bytes} bytes. Inventory complete=${source.inventoryComplete}; source analyzed=${source.sourceCoverageComplete}; projects finished=${source.analysisComplete}; compiler/type context complete=${source.contextComplete}. Semantic coverage and query truncation are separate below.`,
  );
  const select = byId('project-select'),
    diagnostics = byId('project-diagnostics');
  select.replaceChildren();
  diagnostics.replaceChildren();
  for (const project of metadata.items) {
    const option = appendText(
      select,
      'option',
      `${project.label} (${project.status})`,
    );
    option.value = project.id;
    option.disabled = !project.snapshotId;
    for (const diagnostic of project.diagnostics)
      appendText(
        diagnostics,
        'li',
        `${project.label}: ${diagnostic.code} — ${diagnostic.message}`,
      );
    if (project.diagnosticCount > project.diagnostics.length)
      appendText(
        diagnostics,
        'li',
        `${project.label}: ${project.diagnosticCount - project.diagnostics.length} further configuration diagnostics omitted.`,
      );
    if (project.sourceDiagnosticCount)
      appendText(
        diagnostics,
        'li',
        `${project.label}: ${project.sourceDiagnosticCount} source diagnostics; inspect uncertain observations and evidence.`,
      );
  }
  for (const diagnostic of source.diagnostics)
    appendText(diagnostics, 'li', `${diagnostic.code}: ${diagnostic.message}`);
}

export function renderProjectStatus(metadata, projectId) {
  if (metadata.mode !== 'repository') return;
  const project = metadata.items.find((item) => item.id === projectId);
  byId('project-select').value = projectId ?? '';
  byId('project-status').textContent = project
    ? visibleText(
        `${project.label}; ${project.rootFiles} root files; ${project.status}; ${project.diagnosticCount} context diagnostics, ${project.sourceDiagnosticCount} source diagnostics.`,
      )
    : 'No usable project context.';
}

export function renderSourceFiles(page, metadata) {
  const list = byId('source-files');
  list.replaceChildren();
  for (const file of page.items) {
    const labels = file.projectIds.map(
      (id) => metadata.items.find((item) => item.id === id)?.label ?? id,
    );
    appendText(
      list,
      'li',
      `${file.path}: ${file.status}, ${file.byteLength} bytes, SHA-256 ${file.sha256}; root contexts: ${labels.join(', ') || 'none (inspect project failures)'}`,
    );
  }
  if (page.total > page.items.length)
    appendText(
      list,
      'li',
      `Showing ${page.offset + 1}–${page.offset + page.items.length} of ${page.total} source inputs.`,
    );
  byId('previous-files').disabled = page.offset === 0;
  byId('next-files').disabled = page.nextOffset === null;
}

export function renderContextChoices(candidates) {
  const panel = byId('context-choices');
  panel.replaceChildren();
  panel.hidden = false;
  appendText(panel, 'h3', 'Choose the declaration project context');
  appendText(
    panel,
    'p',
    'These contexts share the verified declaration anchor and source hash. Each opens its own snapshot.',
  );
  for (const candidate of candidates)
    actionButton(panel, candidate.projectLabel, 'choose-context', candidate);
}
