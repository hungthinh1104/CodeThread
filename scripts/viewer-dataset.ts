import type { CodeSymbol } from '@codethread/code-model';
import type { AnalysisSnapshot } from '@codethread/symbol-indexer';
import { createInvestigation, TraceError } from '@codethread/trace-engine';
import type { RepositoryInvestigationSession } from './investigation/repository-session.ts';

const order = (a: string, b: string) =>
  Buffer.compare(Buffer.from(a), Buffer.from(b));
type Entry = {
  id: string;
  label: string;
  status: string;
  rootPaths: readonly string[];
  snapshot?: AnalysisSnapshot;
  diagnostics: readonly { code: string; message: string }[];
};
export type ViewerInput = AnalysisSnapshot | RepositoryInvestigationSession;

export function createViewerDataset(input: ViewerInput) {
  const repository = 'projects' in input ? input : null;
  const selected = 'facts' in input ? input : null;
  const entries: Entry[] = selected
    ? [
        {
          id: 'selected',
          label: 'Selected files',
          status: 'ready',
          rootPaths: selected.facts.files.map((file) => file.path),
          snapshot: selected,
          diagnostics: [],
        },
      ]
    : repository!.projects.map((item) => ({
        id: item.project.id,
        label: item.project.configPath ?? 'Default context (unassigned source)',
        status: item.status,
        rootPaths: item.project.rootPaths,
        ...(item.snapshot ? { snapshot: item.snapshot } : {}),
        diagnostics: [
          ...item.project.diagnostics,
          ...(item.snapshot?.contextDiagnostics ?? []),
          ...(item.error ? [item.error] : []),
        ],
      }));
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const cache = new Map<string, ReturnType<typeof createInvestigation>>();
  const first = entries.find((entry) => entry.snapshot);
  const catalog = entries
    .flatMap(
      (entry) =>
        entry.snapshot?.facts.symbols.map((symbol) => ({
          projectId: entry.id,
          projectLabel: entry.label,
          snapshotId: entry.snapshot!.facts.snapshotId,
          symbol,
        })) ?? [],
    )
    .sort(
      (a, b) =>
        order(a.symbol.filePath, b.symbol.filePath) ||
        a.symbol.range.start.offset - b.symbol.range.start.offset ||
        order(a.projectId, b.projectId) ||
        order(a.symbol.key, b.symbol.key),
    );
  function get(projectId: string) {
    const entry = byId.get(projectId);
    if (!entry?.snapshot)
      throw new TraceError(
        'ENTITY_NOT_FOUND',
        'A usable project context was not found.',
      );
    let investigation = cache.get(projectId);
    if (!investigation) {
      investigation = createInvestigation(
        entry.snapshot.facts,
        entry.snapshot.source,
        { resourceProfile: entry.snapshot.resourceProfile ?? 'selected' },
      );
      if (cache.size >= 2) cache.delete(cache.keys().next().value!);
      cache.set(projectId, investigation);
    }
    return { entry, snapshot: entry.snapshot, investigation };
  }
  // Preserve eager validation of the legacy single-snapshot viewer.
  if (selected) get('selected');
  function projects() {
    return {
      mode: repository ? 'repository' : 'selected',
      initialProjectId: first?.id ?? null,
      repositoryId:
        repository?.repositoryId ?? selected!.facts.identity.repositoryId,
      commitId: repository?.commitId ?? null,
      source: repository
        ? {
            files: repository.files.length,
            bytes: repository.inventory.sourceBytes,
            inventoryComplete: repository.inventory.complete,
            sourceCoverageComplete: repository.sourceCoverageComplete,
            analysisComplete: repository.analysisComplete,
            contextComplete: repository.contextComplete,
            diagnostics: repository.diagnostics,
          }
        : null,
      items: entries.map((entry) => ({
        id: entry.id,
        label: entry.label,
        status: entry.status,
        snapshotId: entry.snapshot?.facts.snapshotId ?? null,
        rootFiles: entry.rootPaths.length,
        diagnosticCount: entry.diagnostics.length,
        diagnostics: entry.diagnostics.slice(0, 10),
        sourceDiagnosticCount: entry.snapshot?.facts.diagnostics.length ?? 0,
      })),
    };
  }
  function search(query: string, offset: number, projectId?: string) {
    const normalized = query.toLowerCase();
    const matches = catalog.filter(
      (row) =>
        (!projectId || row.projectId === projectId) &&
        (!normalized ||
          row.symbol.name.toLowerCase().includes(normalized) ||
          row.symbol.filePath.toLowerCase().includes(normalized)),
    );
    const items = matches.slice(offset, offset + 50);
    const next = offset + items.length;
    return {
      query,
      offset,
      limit: 50,
      total: matches.length,
      nextOffset: next < matches.length ? next : null,
      items,
    };
  }
  function files(offset: number) {
    const files =
      repository?.files ??
      selected!.facts.files.map((file) => ({
        path: file.path,
        sha256: file.contentHash,
        byteLength: file.byteLength,
        status: 'analyzed',
        projectIds: ['selected'],
      }));
    const items = files.slice(offset, offset + 50),
      next = offset + items.length;
    return {
      offset,
      limit: 50,
      total: files.length,
      nextOffset: next < files.length ? next : null,
      items,
    };
  }
  function follow(projectId: string, snapshotId: string, symbolId: string) {
    const current = get(projectId);
    if (snapshotId !== current.snapshot.facts.snapshotId)
      throw new TraceError(
        'SNAPSHOT_NOT_FOUND',
        'Snapshot does not belong to this project context.',
      );
    const symbol = current.snapshot.facts.symbols.find(
      (symbol) => symbol.id === symbolId,
    );
    if (!symbol)
      throw new TraceError(
        'ENTITY_NOT_FOUND',
        'Declaration does not belong to this snapshot.',
      );
    const retained = current.investigation.sourceEvidence({
      snapshotId,
      evidenceIds: [symbol.declarationEvidenceId],
    }).items[0];
    if (!retained || retained.status !== 'available')
      throw new TraceError(
        'SOURCE_UNAVAILABLE',
        'A verified declaration anchor is required.',
      );
    const sameAnchor = (candidate: CodeSymbol) =>
      candidate.filePath === symbol.filePath &&
      candidate.kind === symbol.kind &&
      candidate.range.start.offset === symbol.range.start.offset &&
      candidate.range.end.offset === symbol.range.end.offset;
    const owners = entries.filter(
      (entry) => entry.snapshot && entry.rootPaths.includes(symbol.filePath),
    );
    const candidates = owners.flatMap((entry) => {
      const snapshot = entry.snapshot!,
        files = new Map(snapshot.facts.files.map((file) => [file.id, file]));
      return snapshot.facts.symbols
        .filter(
          (candidate) =>
            sameAnchor(candidate) &&
            files.get(candidate.fileId)?.contentHash ===
              retained.evidence.contentHash,
        )
        .map((candidate) => {
          const verified = get(entry.id).investigation.sourceEvidence({
            snapshotId: snapshot.facts.snapshotId,
            evidenceIds: [candidate.declarationEvidenceId],
          }).items[0];
          if (
            !verified ||
            verified.status !== 'available' ||
            verified.evidence.contentHash !== retained.evidence.contentHash
          )
            throw new TraceError(
              'HASH_MISMATCH',
              'Cross-context declaration evidence did not match.',
            );
          return {
            projectId: entry.id,
            projectLabel: entry.label,
            snapshotId: snapshot.facts.snapshotId,
            symbolId: candidate.id,
          };
        });
    });
    // A file consumed only as a dependency can still be investigated in its current context.
    if (!candidates.length)
      candidates.push({
        projectId,
        projectLabel: current.entry.label,
        snapshotId,
        symbolId,
      });
    return {
      projectId,
      snapshotId,
      symbolId,
      requiresChoice: candidates.length > 1,
      candidates,
    };
  }
  return {
    repository: repository !== null,
    get,
    projects,
    search,
    files,
    follow,
    defaultProjectId: first?.id ?? null,
  };
}
export type ViewerDataset = ReturnType<typeof createViewerDataset>;
