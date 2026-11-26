import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';

export function useInspectorDrawer(selectionGenerationRef: RefObject<number>) {
  const [compactViewport, setCompactViewport] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const workspaceHeadingRef = useRef<HTMLHeadingElement>(null);
  const inspectorTriggerRef = useRef<HTMLButtonElement>(null);
  const inspectorOpenerRef = useRef<HTMLButtonElement>(null);
  const inspectorCloseRef = useRef<HTMLButtonElement>(null);

  const openInspector = useCallback((trigger: HTMLButtonElement) => {
    inspectorOpenerRef.current = trigger;
    setInspectorOpen(true);
  }, []);

  const closeInspector = useCallback(() => {
    setInspectorOpen(false);
    window.requestAnimationFrame(() => {
      const opener = inspectorOpenerRef.current;
      const target =
        opener && !opener.isConnected && opener.id
          ? document.getElementById(opener.id)
          : opener;
      if (target?.isConnected && !target.closest('[hidden]')) target.focus();
      else if (opener?.id === 'inspect-declaration-evidence')
        workspaceHeadingRef.current?.focus();
      else inspectorTriggerRef.current?.focus();
    });
  }, []);

  const focusSelectedDeclaration = useCallback(
    (generation: number) => {
      if (window.matchMedia('(max-width: 760px)').matches) {
        window.requestAnimationFrame(() => {
          if (generation !== selectionGenerationRef.current) return;
          const heading = workspaceHeadingRef.current;
          heading?.focus({ preventScroll: true });
          heading?.closest('main')?.scrollIntoView({ block: 'start' });
        });
      }
    },
    [selectionGenerationRef],
  );

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

  return {
    compactViewport,
    inspectorOpen,
    setInspectorOpen,
    workspaceHeadingRef,
    inspectorTriggerRef,
    inspectorCloseRef,
    openInspector,
    closeInspector,
    focusSelectedDeclaration,
  };
}
