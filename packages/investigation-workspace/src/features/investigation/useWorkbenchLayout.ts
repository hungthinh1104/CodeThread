import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'codethread-workspace-layout-v1';
const DEFAULT_EXPLORER_WIDTH = 276;
const DEFAULT_INSPECTOR_WIDTH = 336;
const DEFAULT_INSPECTOR_HEIGHT = 248;

const MIN_EXPLORER_WIDTH = 210;
const MAX_EXPLORER_WIDTH = 440;
const MIN_INSPECTOR_WIDTH = 260;
const MAX_INSPECTOR_WIDTH = 540;
const MIN_INSPECTOR_HEIGHT = 150;
const MAX_INSPECTOR_HEIGHT = 480;

type PersistedLayout = {
  theme?: ThemePreference;
  explorerWidth?: number;
  inspectorWidth?: number;
  inspectorHeight?: number;
  explorerCollapsed?: boolean;
  inspectorCollapsed?: boolean;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function readStoredLayout(): PersistedLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as PersistedLayout;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function writeStoredLayout(next: PersistedLayout): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage may be disabled in restricted browser profiles.
  }
}

export function useWorkbenchLayout() {
  const [theme, setTheme] = useState<ThemePreference>('system');
  const [explorerWidth, setExplorerWidth] = useState(DEFAULT_EXPLORER_WIDTH);
  const [inspectorWidth, setInspectorWidth] = useState(DEFAULT_INSPECTOR_WIDTH);
  const [inspectorHeight, setInspectorHeight] = useState(
    DEFAULT_INSPECTOR_HEIGHT,
  );
  const [explorerCollapsed, setExplorerCollapsed] = useState(false);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [isMediumDock, setIsMediumDock] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const saved = readStoredLayout();
    if (
      saved.theme === 'system' ||
      saved.theme === 'light' ||
      saved.theme === 'dark'
    )
      setTheme(saved.theme);
    if (typeof saved.explorerWidth === 'number')
      setExplorerWidth(
        clamp(saved.explorerWidth, MIN_EXPLORER_WIDTH, MAX_EXPLORER_WIDTH),
      );
    if (typeof saved.inspectorWidth === 'number')
      setInspectorWidth(
        clamp(saved.inspectorWidth, MIN_INSPECTOR_WIDTH, MAX_INSPECTOR_WIDTH),
      );
    if (typeof saved.inspectorHeight === 'number')
      setInspectorHeight(
        clamp(
          saved.inspectorHeight,
          MIN_INSPECTOR_HEIGHT,
          MAX_INSPECTOR_HEIGHT,
        ),
      );
    if (typeof saved.explorerCollapsed === 'boolean')
      setExplorerCollapsed(saved.explorerCollapsed);
    if (typeof saved.inspectorCollapsed === 'boolean')
      setInspectorCollapsed(saved.inspectorCollapsed);
    setHydrated(true);
  }, []);

  useEffect(() => {
    const media = window.matchMedia(
      '(min-width: 901px) and (max-width: 1120px)',
    );
    const update = () => setIsMediumDock(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (!hydrated) return;
    writeStoredLayout({
      theme,
      explorerWidth,
      inspectorWidth,
      inspectorHeight,
      explorerCollapsed,
      inspectorCollapsed,
    });
  }, [
    hydrated,
    theme,
    explorerWidth,
    inspectorWidth,
    inspectorHeight,
    explorerCollapsed,
    inspectorCollapsed,
  ]);

  const startResize = useCallback(
    (
      target: 'explorer' | 'inspector-x' | 'inspector-y',
      event: PointerEvent<HTMLDivElement>,
    ) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const startY = event.clientY;
      const initial =
        target === 'explorer'
          ? explorerWidth
          : target === 'inspector-x'
            ? inspectorWidth
            : inspectorHeight;
      document.body.classList.add('is-resizing');

      const onMove = (moveEvent: globalThis.PointerEvent) => {
        if (target === 'explorer') {
          setExplorerCollapsed(false);
          setExplorerWidth(
            clamp(
              initial + (moveEvent.clientX - startX),
              MIN_EXPLORER_WIDTH,
              MAX_EXPLORER_WIDTH,
            ),
          );
        } else if (target === 'inspector-x') {
          setInspectorCollapsed(false);
          setInspectorWidth(
            clamp(
              initial - (moveEvent.clientX - startX),
              MIN_INSPECTOR_WIDTH,
              MAX_INSPECTOR_WIDTH,
            ),
          );
        } else {
          setInspectorCollapsed(false);
          setInspectorHeight(
            clamp(
              initial - (moveEvent.clientY - startY),
              MIN_INSPECTOR_HEIGHT,
              MAX_INSPECTOR_HEIGHT,
            ),
          );
        }
      };

      const onEnd = () => {
        document.body.classList.remove('is-resizing');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onEnd);
        window.removeEventListener('pointercancel', onEnd);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onEnd);
      window.addEventListener('pointercancel', onEnd);
    },
    [explorerWidth, inspectorWidth, inspectorHeight],
  );

  const handleResizeKeyDown = useCallback(
    (
      target: 'explorer' | 'inspector-x' | 'inspector-y',
      event: KeyboardEvent<HTMLDivElement>,
    ) => {
      const step = event.shiftKey ? 48 : 24;
      if (event.key === 'Home') {
        event.preventDefault();
        if (target === 'explorer') setExplorerWidth(DEFAULT_EXPLORER_WIDTH);
        else if (target === 'inspector-x')
          setInspectorWidth(DEFAULT_INSPECTOR_WIDTH);
        else setInspectorHeight(DEFAULT_INSPECTOR_HEIGHT);
        return;
      }
      if (target === 'explorer') {
        if (event.key === 'ArrowRight') {
          event.preventDefault();
          setExplorerCollapsed(false);
          setExplorerWidth((w) =>
            clamp(w + step, MIN_EXPLORER_WIDTH, MAX_EXPLORER_WIDTH),
          );
        } else if (event.key === 'ArrowLeft') {
          event.preventDefault();
          setExplorerWidth((w) =>
            clamp(w - step, MIN_EXPLORER_WIDTH, MAX_EXPLORER_WIDTH),
          );
        }
      } else if (target === 'inspector-x') {
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          setInspectorCollapsed(false);
          setInspectorWidth((w) =>
            clamp(w + step, MIN_INSPECTOR_WIDTH, MAX_INSPECTOR_WIDTH),
          );
        } else if (event.key === 'ArrowRight') {
          event.preventDefault();
          setInspectorWidth((w) =>
            clamp(w - step, MIN_INSPECTOR_WIDTH, MAX_INSPECTOR_WIDTH),
          );
        }
      } else {
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setInspectorCollapsed(false);
          setInspectorHeight((h) =>
            clamp(h + step, MIN_INSPECTOR_HEIGHT, MAX_INSPECTOR_HEIGHT),
          );
        } else if (event.key === 'ArrowDown') {
          event.preventDefault();
          setInspectorHeight((h) =>
            clamp(h - step, MIN_INSPECTOR_HEIGHT, MAX_INSPECTOR_HEIGHT),
          );
        }
      }
    },
    [],
  );

  const resetLayout = useCallback(() => {
    setExplorerWidth(DEFAULT_EXPLORER_WIDTH);
    setInspectorWidth(DEFAULT_INSPECTOR_WIDTH);
    setInspectorHeight(DEFAULT_INSPECTOR_HEIGHT);
    setExplorerCollapsed(false);
    setInspectorCollapsed(false);
  }, []);

  const expandInspector = useCallback(() => {
    setInspectorCollapsed(false);
  }, []);

  const isCustomized =
    explorerCollapsed ||
    inspectorCollapsed ||
    explorerWidth !== DEFAULT_EXPLORER_WIDTH ||
    inspectorWidth !== DEFAULT_INSPECTOR_WIDTH ||
    inspectorHeight !== DEFAULT_INSPECTOR_HEIGHT;

  const gridStyle = {
    '--ct-explorer-col': explorerCollapsed ? '36px' : `${explorerWidth}px`,
    '--ct-inspector-col': inspectorCollapsed ? '36px' : `${inspectorWidth}px`,
    '--ct-inspector-row': inspectorCollapsed ? '38px' : `${inspectorHeight}px`,
  } as CSSProperties;

  return {
    theme,
    setTheme,
    explorerWidth,
    inspectorWidth,
    inspectorHeight,
    explorerCollapsed,
    inspectorCollapsed,
    isMediumDock,
    isCustomized,
    gridStyle,
    toggleExplorer: () => setExplorerCollapsed((value) => !value),
    toggleInspector: () => setInspectorCollapsed((value) => !value),
    expandInspector,
    resetExplorerWidth: () => setExplorerWidth(DEFAULT_EXPLORER_WIDTH),
    resetInspectorSize: () => {
      if (isMediumDock) setInspectorHeight(DEFAULT_INSPECTOR_HEIGHT);
      else setInspectorWidth(DEFAULT_INSPECTOR_WIDTH);
    },
    resetLayout,
    startResize,
    handleResizeKeyDown,
  };
}
