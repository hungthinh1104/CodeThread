import { useCallback, useRef, useState } from 'react';
import { readSystemHealth } from '../api.ts';
import { errorMessage } from '../queries.ts';
import type { AiStatusResponse, BackendHealth } from '../types.ts';

export interface UseSystemStatusInput {
  readonly initialHealth?: BackendHealth | null;
  readonly initialAiStatus: AiStatusResponse;
}

export function useSystemStatus(input: UseSystemStatusInput) {
  const [health, setHealth] = useState<BackendHealth | null>(
    input.initialHealth ?? null,
  );
  const [aiStatus, setAiStatus] = useState<AiStatusResponse>(
    input.initialAiStatus,
  );
  const [refreshing, setRefreshing] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const generationRef = useRef(0);

  const refreshStatus = useCallback(async () => {
    const generation = ++generationRef.current;
    setRefreshing(true);
    setStatusError(null);
    try {
      const probed = await readSystemHealth();
      if (generation !== generationRef.current) return;
      setHealth(probed.health);
      setAiStatus(probed.ai);
    } catch (error) {
      if (generation === generationRef.current)
        setStatusError(errorMessage(error));
    } finally {
      if (generation === generationRef.current) setRefreshing(false);
    }
  }, []);

  return {
    health,
    aiStatus,
    refreshing,
    statusError,
    refreshStatus,
  };
}
