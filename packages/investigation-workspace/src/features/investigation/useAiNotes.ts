import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiFailure, synthesizeAiNotes } from './api.ts';
import type {
  AiStatusResponse,
  AiSynthesisResponse,
  AiTaskKind,
  CodeSymbol,
} from './types.ts';

type Scope = { scanId: string; projectId: string; snapshotId: string };

export type AiNotesError = {
  readonly code: string;
  readonly message: string;
};

export interface UseAiNotesInput {
  readonly aiStatus: AiStatusResponse;
  readonly scope: Scope | null;
  readonly selected: CodeSymbol | null;
  readonly relationKinds: ('calls' | 'references')[];
  readonly direction: 'outgoing' | 'incoming' | 'both';
}

export interface UseAiNotesState {
  readonly task: AiTaskKind;
  readonly loading: boolean;
  readonly notes: AiSynthesisResponse | null;
  readonly error: AiNotesError | null;
  readonly canDraft: boolean;
  setTask(next: AiTaskKind): void;
  draft(): Promise<void>;
}

/**
 * Isolated state and async-sequence guard for optional 04 / Generated notes.
 * Never auto-runs; discards both stale successes and stale errors whenever
 * scan, project, snapshot, symbol, filter, direction, or task changes.
 */
export function useAiNotes(input: UseAiNotesInput): UseAiNotesState {
  const [task, setTaskState] = useState<AiTaskKind>('explain_trace');
  const [loading, setLoading] = useState(false);
  const [notes, setNotes] = useState<AiSynthesisResponse | null>(null);
  const [error, setError] = useState<AiNotesError | null>(null);
  const requestGeneration = useRef(0);

  const contextKey =
    input.aiStatus.enabled &&
    input.scope &&
    input.selected &&
    input.selected.snapshotId === input.scope.snapshotId
      ? [
          input.scope.scanId,
          input.scope.projectId,
          input.scope.snapshotId,
          input.selected.id,
          input.relationKinds.join(','),
          input.direction,
        ].join(':')
      : null;

  const latestContextKey = useRef<string | null>(contextKey);
  latestContextKey.current = contextKey;

  useEffect(() => {
    requestGeneration.current++;
    setLoading(false);
    setNotes(null);
    setError(null);
  }, [contextKey]);

  const setTask = useCallback((next: AiTaskKind) => {
    requestGeneration.current++;
    setTaskState(next);
    setLoading(false);
    setNotes(null);
    setError(null);
  }, []);

  const draft = useCallback(async () => {
    if (
      !input.aiStatus.enabled ||
      !input.scope ||
      !input.selected ||
      input.selected.snapshotId !== input.scope.snapshotId
    ) {
      return;
    }
    const capturedScope = input.scope;
    const capturedSymbolId = input.selected.id;
    const capturedTask = task;
    const capturedKinds = [...input.relationKinds];
    const capturedDirection = input.direction;
    const capturedKey = latestContextKey.current;
    const generation = ++requestGeneration.current;

    setLoading(true);
    setError(null);
    try {
      const response = await synthesizeAiNotes(
        capturedScope.scanId,
        capturedScope.projectId,
        {
          task: capturedTask,
          neighbors: {
            snapshotId: capturedScope.snapshotId,
            symbolId: capturedSymbolId,
            direction: capturedDirection,
            relationKinds: capturedKinds,
            depth: 2,
            nodeLimit: 50,
          },
          maxClaims: 5,
          maxNextSteps: 3,
        },
      );
      if (
        generation !== requestGeneration.current ||
        latestContextKey.current !== capturedKey
      ) {
        return;
      }
      if (
        response.snapshotId !== capturedScope.snapshotId ||
        response.rootSymbolId !== capturedSymbolId ||
        response.task !== capturedTask
      ) {
        setNotes(null);
        setError({
          code: 'WORKSPACE_CONTEXT_MISMATCH',
          message: 'Generated notes did not match the selected symbol context.',
        });
        return;
      }
      setNotes(response);
      setError(null);
    } catch (caught) {
      if (
        generation !== requestGeneration.current ||
        latestContextKey.current !== capturedKey
      ) {
        return;
      }
      setNotes(null);
      if (caught instanceof ApiFailure) {
        setError({ code: caught.code, message: caught.message });
      } else {
        setError({
          code: 'WORKSPACE_UNAVAILABLE',
          message: 'Generated notes request failed.',
        });
      }
    } finally {
      if (
        generation === requestGeneration.current &&
        latestContextKey.current === capturedKey
      ) {
        setLoading(false);
      }
    }
  }, [
    input.aiStatus.enabled,
    input.scope,
    input.selected,
    input.relationKinds,
    input.direction,
    task,
  ]);

  return {
    task,
    loading,
    notes,
    error,
    canDraft: contextKey !== null,
    setTask,
    draft,
  };
}
