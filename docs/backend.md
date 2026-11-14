# CodeThread local PostgreSQL backend

Status: **local review candidate**. The user authorized DB-02 implementation,
testing and PR review on 2026-11-13. This does not authorize production
credentials, deployment, destructive production migration or automated merge.

## Scope and data flow

The backend preserves the existing analyzer and trace engine. A loopback HTTP
transport validates requests and delegates to the scan or query application
service. PostgreSQL stores scan state, immutable Git provenance, content-
addressed source bytes, project sessions and published analysis snapshots. The
snapshot is stored as both a JSONB facts envelope and normalized relational
rows. Publication and active-pointer changes commit together.

The worker resolves a revision to a commit and persists its commit/tree/object
format before source inventory or analysis. It stores an ordered complete input
manifest and verified source objects, then passes the acquired data directly to
analysis. It does not read working-tree source or execute analyzed repository
scripts. Restart recovery fails work that stopped before the pin and requeues
only jobs with immutable provenance. Generation and attempt fences protect
publication and activation; PostgreSQL bigint values remain decimal strings in
JavaScript.

Published facts and their relational projections are checked against each other
before publication, on snapshot hydration and when an existing snapshot is
reused. Source object hashes are checked on insertion and retrieval. Missing or
corrupt bytes fail explicitly; there is no working-tree fallback.

## Migrations and roles

The versioned, checksummed runner applies the contiguous SQL files in
`db/migrations/` under an advisory lock. `pnpm backend:migrate` is repeatable
and forward-only. It can adopt the previous unversioned schema only when all
expected core tables and integrity triggers are present; incomplete schemas or
checksum/name drift stop for review.

Current migrations provide:

- `001_core.sql`: repository, jobs, immutable snapshots, source objects,
  provenance, normalized facts and publication guards.
- `002_integrity_guards.sql`: cross-row ownership, job transitions, pinned
  provenance and complete source-manifest constraints.
- `003_persistent_viewer.sql`: durable project/session metadata.
- `004_retention.sql`: protected, bounded manual cleanup and snapshot/job read
  fencing.
- `005_symbol_payload.sql`: immutable complete symbol projections for bounded
  search, backfilled from and checked against stored facts.
- `006_active_scan_queue.sql`: a partial index for bounded queue admission. At
  most 32 scans may be queued or running globally; excess requests receive
  `429 SCAN_QUEUE_FULL` without advancing repository generation.

Use a dedicated migration owner for DDL. `pnpm backend:roles` applies the
idempotent `db/roles.sql` grants for `codethread_runtime` and
`codethread_retention`; it does not create login credentials or grant table
ownership. The runtime group has no DDL, trigger-disable or direct delete
privilege. A database administrator must assign the runtime login to the group
outside this repository.

```sh
export CODETHREAD_MIGRATION_DATABASE_URL='postgres://migration-role:...@127.0.0.1:5432/codethread'
pnpm backend:migrate
pnpm backend:roles
```

Do not point these commands at a production database. Use the repository's
pinned Node 24.22.2 and pnpm 12.16.1.

## Running locally

Provision a disposable PostgreSQL 17 database and use separate migration and
runtime logins. Supply the API token through the environment; it must contain at
least 32 characters. The analyzer build hash must be a verified lowercase
SHA-256 fingerprint from the build process.

```sh
export CODETHREAD_DATABASE_URL='postgres://runtime-login:...@127.0.0.1:5432/codethread'
export CODETHREAD_API_TOKEN='a-random-secret-at-least-32-characters'
export CODETHREAD_ALLOWED_REPO_ROOT='/absolute/path/to/allowed/repos'
export CODETHREAD_ANALYZER_BUILD_HASH='<verified lowercase SHA-256 build fingerprint>'
pnpm build
pnpm backend:start
```

The service binds `127.0.0.1:8765`, requires a bearer token, validates Host and
Origin, requires JSON for POST bodies, caps request bodies at 64 KiB and
responses at 1 MiB, accepts at most 64 concurrent connections, limits headers to
10 seconds and complete requests to 30 seconds, and closes keep-alive sockets
after 5 seconds or 100 requests. Database pools and statement/lock/idle-
transaction timeouts are bounded. At most 32 scan jobs may be queued or running
globally; excess new submissions return 429 `SCAN_QUEUE_FULL` without advancing
generation, while idempotent retries still reuse their original job. Health
reports API, database and worker readiness separately. One serial worker runs
per backend process; the database lock prevents a second worker process from
silently competing. This is not a team, multi-user or remote service.

At most four graph-neighbor, path or evidence queries may be active per API
instance. Further requests in those families receive 429
`QUERY_CAPACITY_EXCEEDED` and can retry; symbol and health requests are not
counted against this admission limit. This bounds concurrent snapshot hydration,
but does not guarantee fairness or cancel work when a client disconnects.

The worker holds its advisory lock and executes worker SQL on one dedicated
PostgreSQL session. If the session closes, the worker stops and the backend
exits with an error instead of silently continuing on another session. On
SIGINT/SIGTERM, the backend stops the worker, cancels a statement on the
lock-holding session through its normal database role, closes that session, and
gives active HTTP connections a bounded grace period. A failed or timed-out
shutdown exits nonzero. PostgreSQL can retain a disconnected session until it
detects the connection loss; a new worker must wait for that lock to disappear.
On recovery, interrupted pinned jobs are requeued with their original commit;
interrupted jobs without a persisted pin fail with `REVISION_NOT_PINNED`.
Explicit cancellation remains `cancelled`, and analysis errors remain failures.

## Routes

| Request                                            | Behavior                                                                                                              |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/health`                                   | API, database and worker readiness.                                                                                   |
| `POST /v1/repositories`                            | Register an existing Git repository beneath the configured root.                                                      |
| `GET /v1/repositories` and `/v1/repositories/:id`  | List or inspect registered repositories and active scan.                                                              |
| `POST /v1/repositories/:id/scans`                  | Queue a pinned revision with repository-scoped idempotency; 429 `SCAN_QUEUE_FULL` applies at the global 32-job bound. |
| `GET /v1/scans/:id`                                | Job state, attempt, pinned commit/tree and activation result.                                                         |
| `POST /v1/scans/:id/cancel`                        | Cancel queued or running work.                                                                                        |
| `GET /v1/scans/:id/projects`                       | Project readiness, diagnostics and snapshot IDs.                                                                      |
| `GET /v1/scans/:id/files?offset=0`                 | Bounded page of committed source provenance.                                                                          |
| `GET /v1/scans/:id/projects/:projectId/symbols`    | Snapshot-scoped, deterministic 50-row symbol search with `query` and bounded `offset`.                                |
| `POST /v1/scans/:id/projects/:projectId/neighbors` | Validated, bounded graph-neighbor projection.                                                                         |
| `POST /v1/scans/:id/projects/:projectId/paths`     | Validated, bounded exact-symbol path projection.                                                                      |
| `POST /v1/scans/:id/projects/:projectId/evidence`  | Verified source excerpts for requested evidence IDs.                                                                  |
| `POST /v1/scans/:id/viewer`                        | Open the existing local viewer from a persisted investigation.                                                        |

Graph and evidence bodies use the corresponding `@codethread/contracts` request
and returned `snapshotId`. The query application service checks that the
snapshot belongs to the selected completed scan and validates the result against
the original request before transport. The symbol route reads only its bounded
page from immutable `symbol_json` rows and returns coverage and truncation
metadata. Other graph/evidence requests still hydrate and validate the complete
snapshot and its retained bytes.

The viewer adapter reconstructs the existing viewer from persisted data. It does
not send the backend bearer token to browser JavaScript. The viewer gets a
separate short-lived loopback token in its URL fragment; the server limits
active viewers and closes expired sessions.

## Retention and backup

Retention is manual; there is no scheduled deletion. The protected
`codethread.prune_inactive_data(before, job_limit, snapshot_limit, source_limit)`
procedure rejects future cutoffs and excessive batch sizes. It removes only old
terminal jobs that are not active, published snapshots that are no longer
referenced by scan projects, and source objects no longer referenced by either
snapshots or scan inputs. Snapshot and viewer reads hold shared advisory locks;
retention skips an item while a reader uses it. Runtime logins cannot execute
the procedure; grant access only to the retention role.

Backups are PostgreSQL custom archives of the complete `codethread` schema,
including the content-addressed source bytes. The target must not exist.
Restoration requires an empty isolated database; verification checks migration
checksums, every published snapshot, source hashes, representative graph and
evidence queries, and active persistent sessions.

```sh
export CODETHREAD_BACKUP_DATABASE_URL='postgres://backup-login:...@127.0.0.1:5432/codethread'
export CODETHREAD_BACKUP_FILE='/safe/local/path/codethread.dump'
pnpm backend:backup

export CODETHREAD_RESTORE_TEST_DATABASE_URL='postgres://restore-login:...@127.0.0.1:5432/codethread_restore'
pnpm backend:restore:verify
```

The scripts use local `pg_dump`/`pg_restore` by default. For disposable Docker
integration databases only, `CODETHREAD_PG_TOOLS_CONTAINER` can name the local
PostgreSQL container; the helper runs tools through its local socket and does
not forward URL passwords.

### Local recovery runbook

1. Stop the backend worker and API so no scan or query is changing during the
   drill. Record the repository, scan/job ID, pinned commit/tree, analyzer build
   hash, migration versions and current database identity. Never put connection
   strings or bearer tokens in the record.
2. Keep the source database intact. Choose a new backup path and an empty,
   isolated loopback restore database. The restore command refuses a nonempty
   target and will not overwrite the source.
3. Run `pnpm backend:backup` against the source. Record its archive SHA-256 and
   byte count. Then run `pnpm backend:restore:verify` with the same source URL,
   archive path and isolated restore URL. It restores the `codethread` schema,
   verifies migration checksums and all published snapshots/source hashes,
   compares representative symbol/graph/evidence outputs and active sessions,
   including project failure and timeout reasons, reapplies the reviewed NOLOGIN
   roles, and checks runtime/retention grants.
4. Proceed with a local restore only when the verifier reports
   `status=verified`; record its verification digest and role checks. Confirm
   the restored API's health, job state and pinned commit/tree before directing
   any client to it. Keep the original database and archive until that
   comparison is complete.

This is a reproducible local drill, not production recovery approval. Production
incident response, credentials, target selection and traffic cutover require a
separate operator runbook and authorization.

## Reproducible performance measurement

Run `pnpm backend:bench` against an empty, dedicated loopback database whose
name starts with `codethread_bench_`. The harness scans deterministic TypeScript
repositories at 25, 250 and 900 files through the actual HTTP API and production
worker, then scans Hono at the frozen CT-REALWORLD-001 commit. It verifies the
local Git commit/tree and every Hono source blob against
`docs/evaluation/ct-realworld-001/repositories.json`; it runs no Hono scripts or
dependencies. Set `CODETHREAD_BENCH_REALWORLD_REPOSITORY` if the local clone is
not at `.tooling/ct-realworld-sources/hono` (or its sibling path from the
worktree).

The report includes full scan lifecycle and phase timings, snapshot hydration,
symbol search, graph-query timing, checksums, host/software versions, peak RSS,
source bytes and before/after PostgreSQL query plans. Actual HTTP symbol,
neighbor, path and evidence requests report response bytes, outcomes and
P50/P95/P99 at concurrency 1/4/8/16/32. Cold samples use a new API server and
database client pool; PostgreSQL shared-buffer and operating-system caches are
not flushed. Warm samples follow one excluded warm-up on a persistent
server/pool. Database time is summed tagged-SQL client round-trip latency.
Driver diagnostics separately report transaction pool-lease wait, queued-to-sent
time and sent-to-completion round trips; none is a server-only execution
measurement. Each request has a 30-second client timeout, and outcomes and
sampled peak process RSS are reported. Successful-request latency percentiles
are separate from immediate overload responses. For the local 900-file synthetic
stress fixture, the candidate budget is P99 at most 10 seconds for admitted
requests and sampled process RSS at most 1 GiB; this is a workload-specific
gate, not a general service-level promise. Defaults are 10 cold samples and 20
warm iterations per concurrency; set `CODETHREAD_HTTP_BENCH_COLD_SAMPLES` and
`CODETHREAD_HTTP_BENCH_ITERATIONS` to repeat the run with different sample
counts. Set `CODETHREAD_BENCH_PROFILES` to a comma-separated subset of `small`,
`medium`, `large` and `pinned-hono` when measuring a named subset; the default
includes all four.

The 900-file synthetic profile stays below the current repository-scope cap of
1,000 files. The before path models full snapshot hydration; the after path uses
the normalized search projection. Both pages must match exactly. No new index is
added. These measurements are local workload evidence, not performance claims
for arbitrary repositories; use `pnpm eval:external` for the separate
pinned-source correctness evaluation.

## Verification and remaining limits

The PostgreSQL CI job runs fresh and repeatable migrations, the role grant
script twice, adversarial integration tests and an isolated backup/restore
verification. The Windows and Ubuntu jobs run `pnpm check`, semantic and pinned
external evaluation, browser tests and the dependency audit. Local PostgreSQL
tests and local benchmarks do not replace hosted CI or independent review.

The driver-loss and worker-loss suites exercise terminated sessions and forced
TCP closure. The dedicated, explicitly labelled PostgreSQL restart service is
restarted during input persistence, publication and activation. POSIX tests send
real SIGINT/SIGTERM while a scan is pinned or unpinned and while an HTTP body is
still arriving. The partial-session suite injects a project timeout or resource
error while using real Git inputs, PostgreSQL publication and API reopening; the
injected limit is not a maximum-size performance result. The persistent-browser
test opens a real partial PostgreSQL session in Chromium, checks
CALLS/REFERENCES and source hashes, then reopens it after moving HEAD, removing
the fixture repository and restarting the backend.

Persisted test-case/test-step analysis is not exposed by the backend routes.
Full graph/evidence queries currently hydrate and verify all facts/source bytes;
only symbol search has a direct bounded SQL path. Authentication remains a
single local bearer token. There is no remote deployment, automatic retention
scheduler, general frontend rewrite or independent human semantic study. This
candidate is not production approved.
