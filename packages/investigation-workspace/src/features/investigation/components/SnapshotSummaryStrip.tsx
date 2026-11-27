import type { SessionProjection } from '../types.ts';

type Props = {
  session: SessionProjection;
};

export function SnapshotSummaryStrip({ session }: Props) {
  const { counts, identity } = session;
  return (
    <div className="snapshot-strip">
      <div className="snapshot-metrics" aria-label="Active snapshot metrics">
        <span>
          Snapshot: <strong>{session.coverage}</strong>
        </span>
        <span>
          Files: <strong>{counts.files}</strong>
        </span>
        <span>
          Declarations: <strong>{counts.declarations}</strong>
        </span>
        <span>
          Call sites: <strong>{counts.callSites}</strong>
        </span>
        <span>
          Exact: <strong>{counts.exact}</strong>
        </span>
        <span>
          Ambiguous: <strong>{counts.ambiguous}</strong>
        </span>
        <span>
          Unresolved: <strong>{counts.unresolved}</strong>
        </span>
        <span>
          Unsupported: <strong>{counts.unsupported}</strong>
        </span>
        {counts.notAnalyzedInputs > 0 ? (
          <span>
            Not analysed: <strong>{counts.notAnalyzedInputs}</strong>
          </span>
        ) : null}
      </div>
      <details className="session-coverage">
        <summary>Snapshot coverage &amp; provenance</summary>
        <div className="provenance-grid">
          <p>
            <strong>Snapshot ID</strong>
            <code>{session.snapshotId}</code>
          </p>
          <p>
            <strong>Analyzer</strong>
            <code>
              {identity.analyzerVersion} · build{' '}
              {identity.analyzerBuildHash.slice(0, 16)}…
            </code>
          </p>
          <p>
            <strong>Source fingerprint</strong>
            <code>{identity.sourceFingerprint}</code>
          </p>
          <p>
            <strong>Config hash</strong>
            <code>{identity.configurationHash}</code>
          </p>
        </div>
        <ul>
          {Object.entries(session.coverageByCapability).map(
            ([capability, status]) => (
              <li key={capability}>
                <code>{capability}</code>
                <span>{status}</span>
              </li>
            ),
          )}
        </ul>
      </details>
    </div>
  );
}
