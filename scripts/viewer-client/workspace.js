/* global document, window */

export function installWorkspaceControls() {
  const tabList = document.querySelector('[role="tablist"]'),
    tabs = [
      document.getElementById('source-tab'),
      document.getElementById('trace-tab'),
    ],
    panels = [
      document.getElementById('source-panel'),
      document.getElementById('trace-panel'),
    ];

  function selectTab(index, focus = false) {
    for (const [current, tab] of tabs.entries()) {
      const selected = current === index;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      panels[current].hidden = !selected;
    }
    if (focus) tabs[index].focus();
  }

  for (const [index, tab] of tabs.entries())
    tab.addEventListener('click', () => selectTab(index));

  tabList.addEventListener('keydown', (event) => {
    const active = tabs.indexOf(document.activeElement);
    if (active < 0) return;
    const next =
      event.key === 'ArrowRight'
        ? (active + 1) % tabs.length
        : event.key === 'ArrowLeft'
          ? (active + tabs.length - 1) % tabs.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tabs.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    selectTab(next, true);
  });

  const panel = document.getElementById('evidence-inspector'),
    workspace = document.querySelector('.workspace'),
    backdrop = document.getElementById('inspector-backdrop'),
    toggle = document.getElementById('inspector-toggle'),
    close = document.getElementById('close-inspector'),
    compact = window.matchMedia('(max-width: 900px)');
  const background = [
    document.querySelector('.page-header'),
    ...Array.from(workspace.children).filter(
      (element) => element !== panel && element !== backdrop,
    ),
    document.getElementById('error'),
    document.querySelector('footer'),
  ].filter(Boolean);
  let open = false,
    previousInert = null;

  function setBackgroundInert(inert) {
    if (inert) {
      if (previousInert === null)
        previousInert = background.map((element) => [element, element.inert]);
      for (const element of background) element.inert = true;
      return;
    }
    if (previousInert === null) return;
    for (const [element, wasInert] of previousInert) element.inert = wasInert;
    previousInert = null;
  }

  function updateInspector() {
    const isCompact = compact.matches;
    if (!isCompact) open = false;
    const modal = isCompact && open;
    toggle.hidden = !isCompact;
    close.hidden = !isCompact;
    panel.hidden = isCompact && !open;
    panel.inert = isCompact && !open;
    panel.setAttribute('aria-hidden', String(isCompact && !open));
    if (modal) {
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');
      backdrop.hidden = false;
      document.body.classList.add('inspector-open');
      setBackgroundInert(true);
    } else {
      panel.setAttribute('role', 'complementary');
      panel.removeAttribute('aria-modal');
      backdrop.hidden = true;
      document.body.classList.remove('inspector-open');
      setBackgroundInert(false);
    }
    toggle.setAttribute('aria-expanded', String(modal));
  }

  function closeInspector() {
    open = false;
    updateInspector();
    if (compact.matches) toggle.focus();
    else document.getElementById('source-tab').focus();
  }

  toggle.addEventListener('click', () => {
    open = true;
    updateInspector();
    close.focus();
  });
  close.addEventListener('click', closeInspector);
  backdrop.addEventListener('click', closeInspector);
  document.addEventListener('keydown', (event) => {
    if (!compact.matches || !open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeInspector();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(
      panel.querySelectorAll(
        'button:not(:disabled):not([hidden]), a[href], input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => !element.closest('[hidden], [inert]'));
    if (focusable.length === 0) {
      event.preventDefault();
      panel.focus();
      return;
    }
    const first = focusable[0],
      last = focusable[focusable.length - 1],
      active = document.activeElement;
    if (event.shiftKey && (active === first || !panel.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (
      !event.shiftKey &&
      (active === last || !panel.contains(active))
    ) {
      event.preventDefault();
      first.focus();
    }
  });
  compact.addEventListener('change', () => {
    const wasOpen = open;
    updateInspector();
    if (wasOpen)
      (compact.matches
        ? toggle
        : document.getElementById('source-tab')
      ).focus();
  });
  updateInspector();
  selectTab(0);
  return {
    openCompactInspector() {
      if (!compact.matches || open) return;
      open = true;
      updateInspector();
      close.focus();
    },
  };
}
