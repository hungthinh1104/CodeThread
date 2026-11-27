import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cancelScan,
  readRepositoryById,
  readScanProjects,
  readScanStatus,
  registerRepository,
  requestRepositoryScan,
} from '../api.ts';
import { errorMessage } from '../queries.ts';
import type {
  RepositoryItem,
  ScanProjectSummary,
  ScanStatusRecord,
} from '../types.ts';

export interface UseScanLifecycleInput {
  readonly selectedRepositoryId: string;
  readonly onRepositoryUpsert: (repository: RepositoryItem) => void;
  readonly onRepositoryAdded: (repository: RepositoryItem) => void;
  readonly onOpenSucceededScan: (
    repositoryId: string,
    scanId: string,
  ) => Promise<void>;
}

export interface UseScanLifecycleState {
  readonly registerLocator: string;
  readonly registering: boolean;
  readonly registerError: string | null;
  readonly scanRevision: string;
  readonly trackedScan: ScanStatusRecord | null;
  readonly reusedNotice: boolean;
  readonly scanSubmitting: boolean;
  readonly scanCancelling: boolean;
  readonly scanError: string | null;
  readonly scanProjects: ScanProjectSummary[] | null;
  setRegisterLocator(locator: string): void;
  setScanRevision(revision: string): void;
  submitRegisterRepository(): Promise<boolean>;
  submitScan(): Promise<void>;
  cancelActiveScan(): Promise<void>;
  inspectActiveScan(scanId: string): Promise<void>;
}

function useScanPoller(params: {
  trackedScan: ScanStatusRecord | null;
  pollGenerationRef: React.RefObject<number>;
  setTrackedScan: (scan: ScanStatusRecord | null) => void;
  setScanProjects: (items: ScanProjectSummary[] | null) => void;
  setScanError: (message: string | null) => void;
  onRepositoryUpsert: (repository: RepositoryItem) => void;
  onOpenSucceededScan: (repositoryId: string, scanId: string) => Promise<void>;
}) {
  const latestCallbacks = useRef(params);
  latestCallbacks.current = params;

  const activeScanId =
    params.trackedScan &&
    (params.trackedScan.state === 'queued' ||
      params.trackedScan.state === 'running')
      ? params.trackedScan.id
      : null;

  useEffect(() => {
    if (!activeScanId) return;
    const generation = params.pollGenerationRef.current;
    let cancelled = false;
    const timer = setInterval(() => {
      if (cancelled || generation !== params.pollGenerationRef.current) return;
      void (async () => {
        try {
          const { scan } = await readScanStatus(activeScanId);
          if (cancelled || generation !== params.pollGenerationRef.current)
            return;
          latestCallbacks.current.setTrackedScan(scan);
          if (scan.state === 'succeeded') {
            const refreshed = await readRepositoryById(scan.repositoryId).catch(
              () => null,
            );
            if (cancelled || generation !== params.pollGenerationRef.current)
              return;
            if (refreshed)
              latestCallbacks.current.onRepositoryUpsert(refreshed.repository);
            await latestCallbacks.current.onOpenSucceededScan(
              scan.repositoryId,
              scan.id,
            );
          } else if (scan.state === 'failed') {
            const projects = await readScanProjects(scan.id).catch(() => null);
            if (
              !cancelled &&
              generation === params.pollGenerationRef.current &&
              projects
            )
              latestCallbacks.current.setScanProjects(projects.items);
          }
        } catch (error) {
          if (!cancelled && generation === params.pollGenerationRef.current)
            latestCallbacks.current.setScanError(errorMessage(error));
        }
      })();
    }, 800);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeScanId, params.pollGenerationRef]);
}

export function useScanLifecycle(
  input: UseScanLifecycleInput,
): UseScanLifecycleState {
  const [registerLocator, setRegisterLocator] = useState('');
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [scanRevision, setScanRevision] = useState('HEAD');
  const [trackedScan, setTrackedScan] = useState<ScanStatusRecord | null>(null);
  const [reusedNotice, setReusedNotice] = useState(false);
  const [scanSubmitting, setScanSubmitting] = useState(false);
  const [scanCancelling, setScanCancelling] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanProjects, setScanProjects] = useState<ScanProjectSummary[] | null>(
    null,
  );
  const pollGeneration = useRef(0);

  useEffect(() => {
    ++pollGeneration.current;
    setTrackedScan(null);
    setReusedNotice(false);
    setScanError(null);
    setScanProjects(null);
    setScanCancelling(false);
  }, [input.selectedRepositoryId]);

  useScanPoller({
    trackedScan,
    pollGenerationRef: pollGeneration,
    setTrackedScan,
    setScanProjects,
    setScanError,
    onRepositoryUpsert: input.onRepositoryUpsert,
    onOpenSucceededScan: input.onOpenSucceededScan,
  });

  const submitRegisterRepository = useCallback(async () => {
    const trimmed = registerLocator.trim();
    if (!trimmed) return false;
    setRegistering(true);
    setRegisterError(null);
    try {
      const { repository } = await registerRepository(trimmed);
      setRegisterLocator('');
      input.onRepositoryAdded(repository);
      return true;
    } catch (error) {
      setRegisterError(errorMessage(error));
      return false;
    } finally {
      setRegistering(false);
    }
  }, [input, registerLocator]);

  const inspectActiveScan = useCallback(async (scanId: string) => {
    const generation = ++pollGeneration.current;
    setScanError(null);
    try {
      const [{ scan }, projects] = await Promise.all([
        readScanStatus(scanId),
        readScanProjects(scanId).catch(() => null),
      ]);
      if (generation !== pollGeneration.current) return;
      setTrackedScan(scan);
      setScanProjects(projects?.items ?? null);
    } catch (error) {
      if (generation === pollGeneration.current)
        setScanError(errorMessage(error));
    }
  }, []);

  const submitScan = useCallback(async () => {
    const repositoryId = input.selectedRepositoryId;
    const revision = scanRevision.trim() || 'HEAD';
    if (!repositoryId) return;
    const generation = ++pollGeneration.current;
    setScanSubmitting(true);
    setScanError(null);
    setReusedNotice(false);
    setScanProjects(null);
    try {
      const idempotencyKey = `ui-${repositoryId.slice(0, 8)}-${crypto.randomUUID()}`;
      const { scan: accepted } = await requestRepositoryScan(
        repositoryId,
        revision,
        idempotencyKey,
      );
      if (generation !== pollGeneration.current) return;
      setReusedNotice(accepted.reused);
      const { scan: detail } = await readScanStatus(accepted.id);
      if (generation !== pollGeneration.current) return;
      setTrackedScan(detail);
      if (detail.state === 'succeeded') {
        const refreshed = await readRepositoryById(repositoryId).catch(
          () => null,
        );
        if (generation !== pollGeneration.current) return;
        if (refreshed) input.onRepositoryUpsert(refreshed.repository);
        await input.onOpenSucceededScan(repositoryId, detail.id);
      } else if (detail.state === 'failed') {
        const projects = await readScanProjects(detail.id).catch(() => null);
        if (generation === pollGeneration.current && projects)
          setScanProjects(projects.items);
      }
    } catch (error) {
      if (generation === pollGeneration.current)
        setScanError(errorMessage(error));
    } finally {
      if (generation === pollGeneration.current) setScanSubmitting(false);
    }
  }, [input, scanRevision]);

  const cancelActiveScan = useCallback(async () => {
    if (!trackedScan) return;
    const scanId = trackedScan.id;
    const generation = ++pollGeneration.current;
    setScanCancelling(true);
    setScanError(null);
    try {
      await cancelScan(scanId);
      const { scan } = await readScanStatus(scanId);
      if (generation !== pollGeneration.current) return;
      setTrackedScan(scan);
    } catch (error) {
      if (generation === pollGeneration.current)
        setScanError(errorMessage(error));
    } finally {
      if (generation === pollGeneration.current) setScanCancelling(false);
    }
  }, [trackedScan]);

  return {
    registerLocator,
    registering,
    registerError,
    scanRevision,
    trackedScan,
    reusedNotice,
    scanSubmitting,
    scanCancelling,
    scanError,
    scanProjects,
    setRegisterLocator,
    setScanRevision,
    submitRegisterRepository,
    submitScan,
    cancelActiveScan,
    inspectActiveScan,
  };
}
