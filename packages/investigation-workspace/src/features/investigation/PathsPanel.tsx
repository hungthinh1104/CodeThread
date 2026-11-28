import { useEffect, useRef, useState } from 'react';
import { readViewer } from './api.ts';
import {
  errorMessage,
  readSymbolPaths,
  unwrapScoped,
  type ApiResponse,
} from './scoped-api.ts';
import type {
  CodeSymbol,
  PathsProjection,
  Scope,
  SymbolPage,
} from './types.ts';

type Props = {
  hidden: boolean;
  root: CodeSymbol | null;
  scope: Scope | null;
  relationKinds: ('calls' | 'references')[];
  onRelationKindsChange: (value: ('calls' | 'references')[]) => void;
  onSelectEvidence: (
    id: string,
    trigger: HTMLButtonElement,
    relationId?: string,
    verifiedFromPath?: boolean,
  ) => void;
  onFollowSymbol: (symbol: CodeSymbol) => void;
  aiEnabled?: boolean;
  onExplainPath?: (target: CodeSymbol, depth: number) => void;
};

export function PathsPanel(props: Props) {
  const { root, scope } = props;
  const [targetQuery, setTargetQuery] = useState('');
  const [candidates, setCandidates] = useState<CodeSymbol[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [target, setTarget] = useState<CodeSymbol | null>(null);
  const [depth, setDepth] = useState(3);
  const [result, setResult] = useState<PathsProjection | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const searchGen = useRef(0);
  const pathGen = useRef(0);

  useEffect(() => {
    ++searchGen.current;
    ++pathGen.current;
    setTarget(null);
    setCandidates([]);
    setResult(null);
    setError(null);
    setSearchError(null);
  }, [root?.id, scope?.snapshotId]);

  useEffect(() => {
    if (props.hidden || !scope || !root) return;
    const gen = ++searchGen.current;
    const timer = setTimeout(() => {
      if (gen !== searchGen.current) return;
      setSearching(true);
      setSearchError(null);
      void readViewer<ApiResponse<SymbolPage>>(scope.scanId, 'symbols', {
        projectId: scope.projectId,
        request: { query: targetQuery, offset: 0 },
      })
        .then((response) => {
          if (gen !== searchGen.current) return;
          const page = unwrapScoped(response, scope);
          setCandidates(page.items.filter((item) => item.id !== root.id));
        })
        .catch((err: unknown) => {
          if (gen === searchGen.current) setSearchError(errorMessage(err));
        })
        .finally(() => {
          if (gen === searchGen.current) setSearching(false);
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [
    props.hidden,
    scope?.scanId,
    scope?.projectId,
    scope?.snapshotId,
    root?.id,
    targetQuery,
  ]);

  async function runPathQuery(
    selectedTarget: CodeSymbol | null = target,
    kinds: ('calls' | 'references')[] = props.relationKinds,
    maxDepth: number = depth,
  ) {
    if (!scope || !root || !selectedTarget) return;
    const gen = ++pathGen.current;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const projection = await readSymbolPaths(
        root.id,
        selectedTarget.id,
        scope,
        kinds,
        maxDepth,
      );
      if (gen === pathGen.current) setResult(projection);
    } catch (err) {
      if (gen === pathGen.current) setError(errorMessage(err));
    } finally {
      if (gen === pathGen.current) setLoading(false);
    }
  }

  const symbolById = new Map(
    (result?.symbols ?? []).map((symbol) => [symbol.id, symbol]),
  );
  const relationById = new Map(
    (result?.relations ?? []).map((relation) => [relation.id, relation]),
  );

  return (
    <section
      id="paths-panel"
      role="tabpanel"
      aria-labelledby="paths-tab"
      hidden={props.hidden}
      tabIndex={0}
    >
      {props.hidden ? null : !root || !scope ? (
        <p className="empty-state">
          Select a symbol in Explorer to search exact static paths within this
          snapshot.
        </p>
      ) : (
        <>
          <fieldset className="filters paths-filters">
            <legend className="sr-only">Path relationship kinds</legend>
            <div className="filter-group">
              {(['calls', 'references'] as const).map((kind) => (
                <label
                  key={kind}
                  className={`filter-check filter-${kind}${props.relationKinds.includes(kind) ? ' is-checked' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={props.relationKinds.includes(kind)}
                    onChange={(event) => {
                      const next = event.currentTarget.checked
                        ? [...props.relationKinds, kind]
                        : props.relationKinds.filter((value) => value !== kind);
                      if (!next.length) return;
                      props.onRelationKindsChange(next);
                      if (target) void runPathQuery(target, next, depth);
                    }}
                    disabled={
                      props.relationKinds.length === 1 &&
                      props.relationKinds.includes(kind)
                    }
                  />
                  <span className="kind-swatch" aria-hidden="true" />
                  {kind.toUpperCase()}
                </label>
              ))}
            </div>
            <div className="filter-direction">
              <label htmlFor="path-depth-select">Max depth</label>
              <select
                id="path-depth-select"
                value={depth}
                onChange={(event) => {
                  const nextDepth = Number(event.currentTarget.value);
                  setDepth(nextDepth);
                  if (target)
                    void runPathQuery(target, props.relationKinds, nextDepth);
                }}
              >
                {[1, 2, 3, 4, 5].map((value) => (
                  <option key={value} value={value}>
                    {value} {value === 1 ? 'hop' : 'hops'}
                  </option>
                ))}
              </select>
            </div>
          </fieldset>

          <div className="paths-toolbar">
            <div className="paths-target-field">
              <label className="field-label" htmlFor="path-target-query">
                Target symbol from {root.name}
              </label>
              <input
                id="path-target-query"
                value={targetQuery}
                onChange={(event) => setTargetQuery(event.currentTarget.value)}
                placeholder="Filter symbols in active project…"
                maxLength={256}
                autoComplete="off"
              />
            </div>
            <button
              className="btn-primary paths-run-btn"
              type="button"
              disabled={!target || loading}
              onClick={() => void runPathQuery()}
            >
              {loading ? 'Searching…' : 'Find paths'}
            </button>
          </div>

          {target ? (
            <p className="muted small paths-selection-note">
              Target selected: <strong>{target.name}</strong>{' '}
              <code>
                {target.filePath}:{target.range.start.line}
              </code>
            </p>
          ) : null}

          {searching ? (
            <p className="muted small" role="status">
              Searching candidate targets…
            </p>
          ) : null}
          {searchError ? (
            <div className="notice error" role="alert">
              <span>{searchError}</span>
            </div>
          ) : null}

          {candidates.length ? (
            <ul className="paths-candidate-list" aria-label="Target candidates">
              {candidates.slice(0, 8).map((candidate) => {
                const isPicked = target?.id === candidate.id;
                return (
                  <li key={candidate.id}>
                    <button
                      className={`symbol-result${isPicked ? ' is-selected' : ''}`}
                      type="button"
                      aria-pressed={isPicked}
                      onClick={() => {
                        setTarget(candidate);
                        void runPathQuery(candidate);
                      }}
                    >
                      <strong>{candidate.name}</strong>
                      <span>
                        {candidate.kind} · {candidate.filePath}:
                        {candidate.range.start.line}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : !searching && !searchError ? (
            <p className="muted small">
              No other symbols in this project match the target filter.
            </p>
          ) : null}

          {error ? (
            <div className="notice error" role="alert">
              <span>{error}</span>
              {target ? (
                <button type="button" onClick={() => void runPathQuery()}>
                  Retry path search
                </button>
              ) : null}
            </div>
          ) : null}

          {result ? (
            <>
              <div className="coverage-summary">
                <div className="coverage-status" role="status">
                  <span>Evidence basis: static</span>
                  <span>Coverage: {result.meta.coverage}</span>
                  <span>
                    {result.meta.truncated
                      ? `Truncated: ${result.meta.truncationReasons.join(', ')}`
                      : 'Query not truncated'}
                  </span>
                  <span>{result.paths.length} exact path(s)</span>
                  {props.aiEnabled && props.onExplainPath && target ? (
                    <button
                      type="button"
                      className="small-btn"
                      onClick={() => props.onExplainPath?.(target, depth)}
                    >
                      Explain path
                    </button>
                  ) : null}
                </div>
              </div>
              {result.paths.length ? (
                <ol className="relationship-list">
                  {result.paths.map((path, pathIndex) => (
                    <li
                      key={`${path.symbolIds.join('>')}-${pathIndex}`}
                      className="relation-row relation-calls path-result-row"
                    >
                      <div className="relation-body">
                        <div className="relation-head">
                          <strong className="relation-kind kind-calls">
                            PATH #{pathIndex + 1}
                          </strong>
                          <span className="relation-resolution status-exact">
                            {path.relationIds.length} hop(s)
                          </span>
                        </div>
                        <span className="relation-flow">
                          {path.symbolIds
                            .map((id) => symbolById.get(id)?.name ?? id)
                            .join(' → ')}
                        </span>
                        <div className="path-hops">
                          {path.relationIds.map((relId, hopIndex) => {
                            const relation = relationById.get(relId);
                            const nextSymbol = symbolById.get(
                              path.symbolIds[hopIndex + 1]!,
                            );
                            if (!relation) return null;
                            return (
                              <div key={relId} className="path-hop-item">
                                <span className="small muted">
                                  Hop {hopIndex + 1} (
                                  {relation.kind.toUpperCase()}
                                  ):
                                </span>
                                <button
                                  className="btn-ghost"
                                  type="button"
                                  onClick={(event) => {
                                    if (
                                      result.evidenceRefs.some(
                                        (ref) =>
                                          ref.id === relation.siteEvidenceId,
                                      )
                                    )
                                      props.onSelectEvidence(
                                        relation.siteEvidenceId,
                                        event.currentTarget,
                                        relation.id,
                                        true,
                                      );
                                  }}
                                >
                                  Inspect evidence
                                </button>
                                {nextSymbol ? (
                                  <button
                                    className="btn-subtle"
                                    type="button"
                                    onClick={() =>
                                      props.onFollowSymbol(nextSymbol)
                                    }
                                  >
                                    Follow {nextSymbol.name}
                                  </button>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="empty-state">
                  No exact static path was returned within depth {depth}. This
                  does not establish that indirect or unanalyzed paths are
                  absent.
                </p>
              )}
            </>
          ) : null}
        </>
      )}
    </section>
  );
}
