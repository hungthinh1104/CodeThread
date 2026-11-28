import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export function useInspectorFocus() {
  const [compactViewport, setCompactViewport] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const workspaceHeadingRef = useRef<HTMLHeadingElement>(null);
  const inspectorTriggerRef = useRef<HTMLButtonElement>(null);
  const inspectorOpenerRef = useRef<HTMLButtonElement>(null);
  const inspectorCloseRef = useRef<HTMLButtonElement>(null);
  const pendingInspectorFocusRestoreRef = useRef(false);

  const openInspector = useCallback((trigger: HTMLButtonElement) => {
    inspectorOpenerRef.current = trigger;
    pendingInspectorFocusRestoreRef.current = false;
    setInspectorOpen(true);
  }, []);

  const closeInspector = useCallback(() => {
    pendingInspectorFocusRestoreRef.current = true;
    setInspectorOpen(false);
  }, []);

  const resetInspector = useCallback(() => {
    pendingInspectorFocusRestoreRef.current = false;
    setInspectorOpen(false);
  }, []);

  const revealInspector = useCallback(
    (trigger: HTMLButtonElement) => {
      if (compactViewport) {
        openInspector(trigger);
        return;
      }
      const panel = document.getElementById('evidence-inspector');
      if (!panel) return;
      const rect = panel.getBoundingClientRect();
      if (rect.top >= window.innerHeight || rect.bottom <= 0) {
        const reduced = window.matchMedia(
          '(prefers-reduced-motion: reduce)',
        ).matches;
        panel.scrollIntoView({
          block: 'nearest',
          behavior: reduced ? 'auto' : 'smooth',
        });
      }
    },
    [compactViewport, openInspector],
  );

  useIsomorphicLayoutEffect(() => {
    if (inspectorOpen || !pendingInspectorFocusRestoreRef.current) return;
    pendingInspectorFocusRestoreRef.current = false;
    const opener = inspectorOpenerRef.current;
    const target =
      opener && !opener.isConnected && opener.id
        ? document.getElementById(opener.id)
        : opener;
    if (target?.isConnected && !target.closest('[hidden]')) target.focus();
    else if (opener?.id === 'inspect-declaration-evidence')
      workspaceHeadingRef.current?.focus();
    else inspectorTriggerRef.current?.focus();
  }, [inspectorOpen]);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 900px)');
    const update = () => {
      setCompactViewport(media.matches);
      if (!media.matches) setInspectorOpen(false);
    };
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  const focusSelectedDeclaration = useCallback(
    (isStillCurrent: () => boolean, alwaysFocus = false) => {
      const narrow = window.matchMedia('(max-width: 760px)').matches;
      if (!narrow && !alwaysFocus) return;
      window.requestAnimationFrame(() => {
        if (!isStillCurrent()) return;
        const heading = workspaceHeadingRef.current;
        heading?.focus({ preventScroll: true });
        if (narrow)
          heading?.closest('main')?.scrollIntoView({ block: 'start' });
      });
    },
    [],
  );

  return {
    compactViewport,
    inspectorOpen,
    inspectorModal: compactViewport && inspectorOpen,
    workspaceHeadingRef,
    inspectorTriggerRef,
    inspectorCloseRef,
    openInspector,
    closeInspector,
    resetInspector,
    revealInspector,
    focusSelectedDeclaration,
  };
}
