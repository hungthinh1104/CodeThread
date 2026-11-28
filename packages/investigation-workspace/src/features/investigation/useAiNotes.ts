import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiFailure, readAiStatus, readViewer } from './api.ts';
import { errorMessage, unwrapScoped, type ApiResponse } from './scoped-api.ts';
import type {
  AiStatusResponse,
  AiSynthesisResponse,
  AiTaskKind,
  CodeSymbol,
  Scope,
} from './types.ts';

export type AiNotesError = {
  code: string;
  message: string;
  retryable: boolean;
};

type Input = {
  scope: Scope | null;
  root: CodeSymbol | null;
  relationKinds: ('calls' | 'references')[];
  direction: 'outgoing' | 'incoming' | 'both';
};

export function useAiNotes(input: Input) {
  const { scope, root, relationKinds, direction } = input;
  const [aiStatus, setAiStatus] = useState<AiStatusResponse>({
    enabled: false,
  });
  const [task, setTask] = useState<AiTaskKind>('explain_trace');
  const [pathTarget, setPathTarget] = useState<CodeSymbol | null>(null);
  const [pathDepth, setPathDepth] = useState(3);
  const [loading, setLoading] = useState(false);
  const [notes, setNotes] = useState<AiSynthesisResponse | null>(null);
  const [error, setError] = useState<AiNotesError | null>(null);

  const requestGen = useRef(0);

  useEffect(() => {
    let active = true;
    void readAiStatus().then((status) => {
      if (active) setAiStatus(status);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    ++requestGen.current;
    setLoading(false);
    setNotes(null);
    setError(null);
    setPathTarget(null);
  }, [scope?.scanId, scope?.projectId, scope?.snapshotId, root?.id]);

  const draftNotes = useCallback(
    async (overrides?: {
      task?: AiTaskKind;
      target?: CodeSymbol | null;
      depth?: number;
    }) => {
      if (!aiStatus.enabled || !scope || !root) return;
      const activeTask = overrides?.task ?? task;
      const activeTarget =
        overrides?.target !== undefined ? overrides.target : pathTarget;
      const activeDepth = overrides?.depth ?? pathDepth;

      if (activeTask === 'explain_path' && !activeTarget) {
        setError({
          code: 'INVALID_REQUEST',
          message: 'Select a target symbol to explain static paths.',
          retryable: false,
        });
        return;
      }

      const gen = ++requestGen.current;
      setLoading(true);
      setError(null);
      setNotes(null);

      const requestBody =
        activeTask === 'explain_path'
          ? {
              task: activeTask,
              paths: {
                snapshotId: scope.snapshotId,
                fromSymbolId: root.id,
                toSymbolId: activeTarget!.id,
                relationKinds,
                depth: activeDepth,
                pathLimit: 5,
                nodeLimit: 100,
              },
              maxClaims: 6,
              maxNextSteps: 3,
            }
          : {
              task: activeTask,
              neighbors: {
                snapshotId: scope.snapshotId,
                symbolId: root.id,
                direction,
                relationKinds,
                depth: 1,
                nodeLimit: 50,
              },
              maxClaims: 5,
              maxNextSteps: 3,
            };

      try {
        const response = await readViewer<ApiResponse<AiSynthesisResponse>>(
          scope.scanId,
          'ai',
          { projectId: scope.projectId, request: requestBody },
        );
        if (gen !== requestGen.current) return;
        const result = unwrapScoped(response, scope);
        if (result.snapshotId !== scope.snapshotId) {
          setError({
            code: 'SNAPSHOT_MISMATCH',
            message: 'AI notes snapshot did not match the active project.',
            retryable: false,
          });
          return;
        }
        setNotes(result);
      } catch (err) {
        if (gen !== requestGen.current) return;
        if (err instanceof ApiFailure) {
          setError({
            code: err.code,
            message: err.message,
            retryable:
              err.status === 429 ||
              err.status === 502 ||
              err.status === 503 ||
              err.status === 504,
          });
        } else {
          setError({
            code: 'AI_REQUEST_FAILED',
            message: errorMessage(err),
            retryable: true,
          });
        }
      } finally {
        if (gen === requestGen.current) setLoading(false);
      }
    },
    [
      aiStatus.enabled,
      scope,
      root,
      task,
      pathTarget,
      pathDepth,
      relationKinds,
      direction,
    ],
  );

  const chooseTask = useCallback((nextTask: AiTaskKind) => {
    ++requestGen.current;
    setTask(nextTask);
    setLoading(false);
    setNotes(null);
    setError(null);
  }, []);

  const preparePathExplanation = useCallback(
    (target: CodeSymbol, depth: number) => {
      setTask('explain_path');
      setPathTarget(target);
      setPathDepth(depth);
      void draftNotes({ task: 'explain_path', target, depth });
    },
    [draftNotes],
  );

  return {
    aiStatus,
    task,
    onTaskChange: chooseTask,
    pathTarget,
    onPathTargetChange: setPathTarget,
    pathDepth,
    onPathDepthChange: setPathDepth,
    loading,
    notes,
    error,
    onDraft: () => void draftNotes(),
    onExplainPath: preparePathExplanation,
  };
}
