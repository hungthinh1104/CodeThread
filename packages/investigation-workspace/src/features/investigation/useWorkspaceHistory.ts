import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { CodeSymbol } from './types.ts';

export type NavigationEntry = {
  scanId: string;
  projectId: string;
  snapshotId: string;
  root: CodeSymbol | null;
  relationKinds: ('calls' | 'references')[];
  direction: 'outgoing' | 'incoming' | 'both';
  selectedRelationId: string | null;
  selectedEvidenceId: string | null;
  view: 'source' | 'trace';
};

type StoredEntry = {
  key: string;
  entry: NavigationEntry;
  segment: symbol;
  offset: number;
};

const HISTORY_LIMIT = 40;

function keyFromState(state: unknown): string | null {
  return typeof state === 'object' &&
    state !== null &&
    'ctWorkspaceKey' in state &&
    typeof state.ctWorkspaceKey === 'string'
    ? state.ctWorkspaceKey
    : null;
}

function sameEntry(left: NavigationEntry, right: NavigationEntry): boolean {
  return (
    left.scanId === right.scanId &&
    left.projectId === right.projectId &&
    left.snapshotId === right.snapshotId &&
    left.root?.id === right.root?.id &&
    left.direction === right.direction &&
    left.relationKinds.length === right.relationKinds.length &&
    left.relationKinds.every((kind) => right.relationKinds.includes(kind)) &&
    left.selectedRelationId === right.selectedRelationId &&
    left.selectedEvidenceId === right.selectedEvidenceId &&
    left.view === right.view
  );
}

export function useWorkspaceHistory(
  restore: (entry: NavigationEntry, accept: () => void) => Promise<void>,
) {
  const entries = useRef<StoredEntry[]>([]);
  const cursor = useRef(-1);
  const restoreSeq = useRef(0);
  const restoring = useRef(false);
  const [controls, setControls] = useState({
    canBack: false,
    canForward: false,
  });

  function updateControls() {
    setControls({
      canBack: !restoring.current && cursor.current > 0,
      canForward:
        !restoring.current &&
        cursor.current >= 0 &&
        cursor.current < entries.current.length - 1,
    });
  }

  function browserEntry(state: unknown) {
    return entries.current.find((item) => item.key === keyFromState(state));
  }

  function reset(entry: NavigationEntry | null) {
    ++restoreSeq.current;
    restoring.current = false;
    const key = entry ? crypto.randomUUID() : null;
    entries.current =
      entry && key ? [{ key, entry, segment: Symbol(), offset: 0 }] : [];
    cursor.current = entries.current.length - 1;
    window.history.replaceState(key ? { ctWorkspaceKey: key } : null, '');
    updateControls();
  }

  function push(entry: NavigationEntry) {
    ++restoreSeq.current;
    restoring.current = false;
    const current = entries.current[cursor.current];
    if (current && sameEntry(current.entry, entry)) {
      updateControls();
      return;
    }
    const linked = current && browserEntry(window.history.state) === current;
    const item = {
      key: crypto.randomUUID(),
      entry,
      segment: linked ? current.segment : Symbol(),
      offset: linked ? current.offset + 1 : 0,
    };
    window.history.pushState({ ctWorkspaceKey: item.key }, '');
    entries.current = [
      ...entries.current.slice(0, cursor.current + 1),
      item,
    ].slice(-HISTORY_LIMIT);
    cursor.current = entries.current.length - 1;
    updateControls();
  }

  function restoreEntry(item: StoredEntry) {
    const seq = ++restoreSeq.current;
    restoring.current = true;
    updateControls();
    void restore(item.entry, () => {
      const index = entries.current.indexOf(item);
      if (index < 0) return;
      cursor.current = index;
      updateControls();
    }).finally(() => {
      if (seq === restoreSeq.current) {
        restoring.current = false;
        updateControls();
      }
    });
  }

  function move(step: -1 | 1) {
    if (restoring.current) return;
    const target = entries.current[cursor.current + step];
    if (!target) return;
    const browser = browserEntry(window.history.state);
    if (
      browser &&
      browser.segment === target.segment &&
      browser.offset !== target.offset
    ) {
      window.history.go(target.offset - browser.offset);
    } else {
      // A failed restore can leave the browser at the target. An evicted slot
      // can also be current after native Back. The workspace still has its own cursor.
      restoreEntry(target);
    }
  }

  const onPopState = useEffectEvent((event: PopStateEvent) => {
    const item = browserEntry(event.state);
    if (item) restoreEntry(item);
  });

  useEffect(() => {
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  return { ...controls, reset, push, move };
}
