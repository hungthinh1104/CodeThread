import type {
  PathDepthOption,
  UseSymbolPathsState,
} from '../hooks/useSymbolPaths.ts';
import type {
  CodeSymbol,
  FindSymbolPathsResponse,
  RelationKindFilter,
} from '../types.ts';

type Props = {
  root: CodeSymbol;
  relationKinds: RelationKindFilter[];
  paths: UseSymbolPathsState;
  selectedRelationId: string | null;
  onSelectEvidence: (
    id: string,
    trigger: HTMLButtonElement,
    relationId?: string,
  ) => void;
  onFollowSymbol: (symbol: CodeSymbol) => void;
};

function PathResultsView(props: {
  result: FindSymbolPathsResponse;
  selectedRelationId: string | null;
  onSelectEvidence: Props['onSelectEvidence'];
  onFollowSymbol: Props['onFollowSymbol'];
}) {
  const { result } = props;
  const symbolById = new Map(
    result.symbols.map((symbol) => [symbol.id, symbol] as const),
  );
  const relationById = new Map(
    result.relations.map((relation) => [relation.id, relation] as const),
  );
  const evidenceById = new Map(
    result.evidenceRefs.map((ref) => [ref.id, ref] as const),
  );

  return (
    <div className="path-results">
      <div className="coverage-summary">
        <div className="coverage-status" role="status">
          <span>Path basis: static</span>
          <span>Paths: {result.paths.length}</span>
          <span>Coverage: {result.meta.coverage}</span>
          <span>
            {result.meta.truncated
              ? `Truncated: ${result.meta.truncationReasons.join(', ')}`
              : 'Search not truncated'}
          </span>
        </div>
      </div>

      {result.paths.length === 0 ? (
        result.meta.truncated ? (
          <p className="notice warning" role="status">
            No exact path was found within the applied search bounds (
            {result.meta.truncationReasons.join(', ')}). Longer or omitted paths
            may still exist.
          </p>
        ) : (
          <p className="empty-state">
            No exact static path connects these declarations with the selected
            relationship kinds. Dynamic, ambiguous, or unanalysed relationships
            are not excluded.
          </p>
        )
      ) : (
        <ol className="path-list">
          {result.paths.map((path, pathIndex) => {
            const chainNames = path.symbolIds
              .map((id) => symbolById.get(id)?.name ?? id)
              .join(' → ');
            const hopCount = path.relationIds.length;
            return (
              <li key={`${pathIndex}-${path.relationIds.join(':')}`}>
                <p className="path-chain">
                  <strong>
                    Path {pathIndex + 1} ({hopCount}{' '}
                    {hopCount === 1 ? 'hop' : 'hops'})
                  </strong>
                  <code>{chainNames}</code>
                </p>
                <ol className="path-hop-list">
                  {path.relationIds.map((relationId, hopIndex) => {
                    const relation = relationById.get(relationId);
                    if (!relation) return null;
                    const source = symbolById.get(path.symbolIds[hopIndex]!);
                    const target = symbolById.get(
                      path.symbolIds[hopIndex + 1]!,
                    );
                    const site = evidenceById.get(relation.siteEvidenceId);
                    const isSelected = props.selectedRelationId === relation.id;
                    return (
                      <li
                        key={relation.id}
                        className={isSelected ? 'selected' : ''}
                        aria-current={isSelected ? 'true' : undefined}
                      >
                        <div>
                          <strong>
                            {relation.kind.toUpperCase()} ·{' '}
                            {relation.resolution.status}
                          </strong>
                          <span>
                            {source?.name ?? relation.sourceSymbolId} →{' '}
                            {target?.name ?? 'target'}
                          </span>
                          {source ? (
                            <code>
                              {source.filePath}:
                              {site?.range.start.line ??
                                source.range.start.line}
                            </code>
                          ) : null}
                        </div>
                        <div className="row-actions">
                          <button
                            type="button"
                            onClick={(event) =>
                              props.onSelectEvidence(
                                relation.siteEvidenceId,
                                event.currentTarget,
                                relation.id,
                              )
                            }
                          >
                            Inspect hop evidence
                          </button>
                          {target ? (
                            <button
                              type="button"
                              onClick={() => props.onFollowSymbol(target)}
                            >
                              Follow {target.name}
                            </button>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

export function PathFinderPanel(props: Props) {
  const { paths } = props;
  const activeKinds = props.relationKinds
    .map((kind) => kind.toUpperCase())
    .join(', ');

  return (
    <section
      id="symbol-paths"
      className="path-finder"
      aria-labelledby="symbol-paths-heading"
    >
      <h3 id="symbol-paths-heading">Directed symbol paths</h3>
      <p className="muted small">
        Find exact static chains from <code>{props.root.name}</code> using
        active relationship kinds ({activeKinds}).
      </p>

      <label className="field-label" htmlFor="path-target-query">
        Filter target symbol
      </label>
      <input
        id="path-target-query"
        value={paths.targetQuery}
        onChange={(event) => paths.setTargetQuery(event.currentTarget.value)}
        placeholder="Filter by target name or file path"
        maxLength={256}
        autoComplete="off"
      />

      <label className="field-label" htmlFor="path-target-select">
        Target declaration
      </label>
      <select
        id="path-target-select"
        value={paths.targetSymbolId}
        onChange={(event) => paths.setTargetSymbolId(event.currentTarget.value)}
        disabled={paths.candidatesLoading || paths.candidates.length === 0}
      >
        {paths.candidates.length === 0 ? (
          <option value="">
            {paths.candidatesLoading
              ? 'Searching snapshot symbols…'
              : 'No matching target declarations'}
          </option>
        ) : null}
        {paths.candidates.map((symbol) => (
          <option key={symbol.id} value={symbol.id}>
            {symbol.name} — {symbol.kind} ({symbol.filePath}:
            {symbol.range.start.line})
          </option>
        ))}
      </select>

      <div className="path-controls-row">
        <label htmlFor="path-depth-select">Max hops</label>
        <select
          id="path-depth-select"
          value={paths.depth}
          onChange={(event) =>
            paths.setDepth(Number(event.currentTarget.value) as PathDepthOption)
          }
          disabled={paths.loading}
        >
          <option value={2}>2 hops</option>
          <option value={3}>3 hops</option>
          <option value={4}>4 hops</option>
          <option value={5}>5 hops</option>
        </select>
        <button
          id="find-symbol-paths"
          type="button"
          onClick={() => void paths.findPaths()}
          disabled={!paths.canFindPaths || paths.loading}
        >
          {paths.loading ? 'Finding paths…' : 'Find paths'}
        </button>
        {paths.pathsResult ? (
          <button type="button" onClick={paths.clearPaths}>
            Clear paths
          </button>
        ) : null}
      </div>

      {paths.candidatesError ? (
        <p className="notice error" role="alert">
          {paths.candidatesError}
        </p>
      ) : null}
      {paths.loading ? (
        <p role="status">Searching bounded static paths…</p>
      ) : null}
      {paths.error ? (
        <p className="notice error" role="alert">
          {paths.error}{' '}
          <button type="button" onClick={() => void paths.findPaths()}>
            Retry path search
          </button>
        </p>
      ) : null}
      {paths.pathsResult ? (
        <PathResultsView
          result={paths.pathsResult}
          selectedRelationId={props.selectedRelationId}
          onSelectEvidence={props.onSelectEvidence}
          onFollowSymbol={props.onFollowSymbol}
        />
      ) : null}
    </section>
  );
}
