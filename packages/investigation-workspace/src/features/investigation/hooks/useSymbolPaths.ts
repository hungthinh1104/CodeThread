import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { readViewer } from '../api.ts';
import { errorMessage, readSymbolPaths, unwrapScoped } from '../queries.ts';
import type {
  ApiResponse,
  CodeSymbol,
  FindSymbolPathsResponse,
  RelationKindFilter,
  Scope,
  SymbolPage,
} from '../types.ts';

export type PathDepthOption = 2 | 3 | 4 | 5;

export interface UseSymbolPathsInput {
  readonly scope: Scope | null;
  readonly root: CodeSymbol | null;
  readonly relationKinds: RelationKindFilter[];
  readonly knownSymbols: readonly CodeSymbol[];
}

export interface UseSymbolPathsState {
  readonly targetQuery: string;
  readonly candidates: CodeSymbol[];
  readonly candidatesLoading: boolean;
  readonly candidatesError: string | null;
  readonly targetSymbolId: string;
  readonly depth: PathDepthOption;
  readonly pathsResult: FindSymbolPathsResponse | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly canFindPaths: boolean;
  setTargetQuery(query: string): void;
  setTargetSymbolId(symbolId: string): void;
  setDepth(depth: PathDepthOption): void;
  findPaths(): Promise<void>;
  clearPaths(): void;
}

function dedupeCandidates(
  symbols: readonly CodeSymbol[],
  snapshotId: string | undefined,
  excludeId: string | undefined,
): CodeSymbol[] {
  if (!snapshotId) return [];
  const seen = new Set<string>();
  const items: CodeSymbol[] = [];
  for (const symbol of symbols) {
    if (
      symbol.snapshotId !== snapshotId ||
      symbol.id === excludeId ||
      seen.has(symbol.id)
    )
      continue;
    seen.add(symbol.id);
    items.push(symbol);
  }
  return items;
}

function usePathCandidateQuery(
  scope: Scope | null,
  rootId: string | null,
  rootKey: string | null,
  targetQuery: string,
) {
  const [queried, setQueried] = useState<CodeSymbol[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const candidateGeneration = useRef(0);

  useEffect(() => {
    ++candidateGeneration.current;
    setQueried([]);
    setLoading(false);
    setError(null);
  }, [rootKey]);

  useEffect(() => {
    const trimmed = targetQuery.trim();
    if (!scope || !rootId || !trimmed) {
      ++candidateGeneration.current;
      setQueried([]);
      setLoading(false);
      setError(null);
      return;
    }
    const capturedScope = scope;
    const generation = ++candidateGeneration.current;
    const timer = setTimeout(() => {
      if (generation !== candidateGeneration.current) return;
      setLoading(true);
      setError(null);
      void readViewer<ApiResponse<SymbolPage>>(
        capturedScope.scanId,
        'symbols',
        {
          projectId: capturedScope.projectId,
          request: { query: trimmed, offset: 0 },
        },
      )
        .then((response) => {
          if (generation !== candidateGeneration.current) return;
          setQueried(unwrapScoped(response, capturedScope).items);
        })
        .catch((caught: unknown) => {
          if (generation === candidateGeneration.current)
            setError(errorMessage(caught));
        })
        .finally(() => {
          if (generation === candidateGeneration.current) setLoading(false);
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [rootKey, targetQuery]);

  return { queried, loading, error };
}

async function runPathQuery(params: {
  scope: Scope;
  fromSymbolId: string;
  toSymbolId: string;
  relationKinds: RelationKindFilter[];
  depth: PathDepthOption;
  capturedKey: string | null;
  pathGeneration: RefObject<number>;
  latestFilterKey: RefObject<string | null>;
  setLoading: (value: boolean) => void;
  setError: (value: string | null) => void;
  setPathsResult: (value: FindSymbolPathsResponse | null) => void;
}) {
  const generation = ++params.pathGeneration.current;
  const isCurrent = () =>
    generation === params.pathGeneration.current &&
    params.latestFilterKey.current === params.capturedKey;
  params.setLoading(true);
  params.setError(null);
  try {
    const result = await readSymbolPaths(params.scope, {
      snapshotId: params.scope.snapshotId,
      fromSymbolId: params.fromSymbolId,
      toSymbolId: params.toSymbolId,
      relationKinds: params.relationKinds,
      depth: params.depth,
      nodeLimit: 200,
      pathLimit: 20,
    });
    if (!isCurrent()) return;
    params.setPathsResult(result);
    params.setError(null);
  } catch (caught) {
    if (!isCurrent()) return;
    params.setPathsResult(null);
    params.setError(errorMessage(caught));
  } finally {
    if (isCurrent()) params.setLoading(false);
  }
}

export function useSymbolPaths(
  input: UseSymbolPathsInput,
): UseSymbolPathsState {
  const [targetQuery, setTargetQueryState] = useState('');
  const [targetSymbolId, setTargetSymbolIdState] = useState('');
  const [depth, setDepthState] = useState<PathDepthOption>(3);
  const [pathsResult, setPathsResult] =
    useState<FindSymbolPathsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pathGeneration = useRef(0);

  const validRoot =
    input.scope &&
    input.root &&
    input.root.snapshotId === input.scope.snapshotId
      ? input.root
      : null;
  const rootKey =
    input.scope && validRoot
      ? `${input.scope.scanId}:${input.scope.projectId}:${input.scope.snapshotId}:${validRoot.id}`
      : null;
  const filterKey = rootKey
    ? `${rootKey}:${input.relationKinds.join(',')}`
    : null;
  const latestFilterKey = useRef<string | null>(filterKey);
  latestFilterKey.current = filterKey;

  const candidateSearch = usePathCandidateQuery(
    input.scope,
    validRoot?.id ?? null,
    rootKey,
    targetQuery,
  );

  const clearPaths = useCallback(() => {
    ++pathGeneration.current;
    setPathsResult(null);
    setLoading(false);
    setError(null);
  }, []);

  useEffect(() => {
    setTargetQueryState('');
    setTargetSymbolIdState('');
    clearPaths();
  }, [rootKey, clearPaths]);

  useEffect(() => {
    clearPaths();
  }, [filterKey, clearPaths]);

  const candidates = dedupeCandidates(
    targetQuery.trim() ? candidateSearch.queried : input.knownSymbols,
    input.scope?.snapshotId,
    validRoot?.id,
  );
  const effectiveTargetId = candidates.some(
    (item) => item.id === targetSymbolId,
  )
    ? targetSymbolId
    : (candidates[0]?.id ?? '');

  const setTargetQuery = useCallback(
    (next: string) => {
      setTargetQueryState(next);
      clearPaths();
    },
    [clearPaths],
  );

  const setTargetSymbolId = useCallback(
    (next: string) => {
      setTargetSymbolIdState(next);
      clearPaths();
    },
    [clearPaths],
  );

  const setDepth = useCallback(
    (next: PathDepthOption) => {
      setDepthState(next);
      clearPaths();
    },
    [clearPaths],
  );

  const findPaths = useCallback(async () => {
    if (!input.scope || !validRoot || !effectiveTargetId) return;
    await runPathQuery({
      scope: input.scope,
      fromSymbolId: validRoot.id,
      toSymbolId: effectiveTargetId,
      relationKinds: [...input.relationKinds],
      depth,
      capturedKey: latestFilterKey.current,
      pathGeneration,
      latestFilterKey,
      setLoading,
      setError,
      setPathsResult,
    });
  }, [depth, effectiveTargetId, input.relationKinds, input.scope, validRoot]);

  return {
    targetQuery,
    candidates,
    candidatesLoading: candidateSearch.loading,
    candidatesError: candidateSearch.error,
    targetSymbolId: effectiveTargetId,
    depth,
    pathsResult,
    loading,
    error,
    canFindPaths: Boolean(
      filterKey && effectiveTargetId && !candidateSearch.loading,
    ),
    setTargetQuery,
    setTargetSymbolId,
    setDepth,
    findPaths,
    clearPaths,
  };
}
