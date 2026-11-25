'use client';

export default function WorkspaceError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="page-shell">
      <section className="region" role="alert">
        <h1>Investigation Workspace encountered an unexpected error</h1>
        <p className="muted">
          The active snapshot view could not render. Reload or reset the local
          workspace view to continue.
        </p>
        <button type="button" onClick={reset}>
          Reload workspace view
        </button>
      </section>
    </main>
  );
}
