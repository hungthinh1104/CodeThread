# CodeThread DB-02 / local backend

Status: **candidate implementation; PostgreSQL integration and hosted CI must pass before approval**.

User authorized implementing DB and backend on 2026-11-13. This does not grant
production deployment, real credentials, destructive migrations, or merging.

## Ownership

The analyzer and trace-engine are unchanged. The backend exposes a token-protected
loopback service and serial scan worker; PostgreSQL stores operational job state,
acquisition provenance, immutable source bytes and project-scoped analysis facts.
The published graph is stored both as a validated JSONB fact envelope and as
normalized relational rows for SQL integrity enforcement. Queries are served
through the existing verified trace engine, never a second semantic implementation.

The source adapter reads the **pinned commit only**, never working-tree source.
Each worker pins a commit before handing it to project-aware analysis.
Acquisition and project analysis currently read that pinned commit separately;
profile this before optimizing. A single PostgreSQL advisory lock fences multiple
backend processes. Crash recovery requeues unfinished jobs; published data and
active-pointer change occur in one transaction. Source hashes are reverified
before storing and when loading them.

## Development setup

Use the repository's pinned Node and pnpm versions. Provision a disposable
PostgreSQL database **outside this repository** and execute migrations with a
dedicated privileged migration role:

```sh
export CODETHREAD_MIGRATION_DATABASE_URL='postgres://migration-role:...@127.0.0.1:5432/codethread'
pnpm backend:migrate
```

Migration 001 is forward-only and deliberately refuses reapplication; never
point it at a database with unrelated tables or production data. Create a
separate runtime role with least-privilege access to schema `codethread`.
The runtime role must not own tables or have ALTER/TRIGGER privileges.
PostgreSQL credentials and tokens must be supplied through the environment,
never committed.

For development:

```sh
export CODETHREAD_DATABASE_URL='postgres://runtime-role:...@127.0.0.1:5432/codethread'
export CODETHREAD_API_TOKEN='replace-with-a-random-secret-at-least-32-characters'
export CODETHREAD_ALLOWED_REPO_ROOT='/absolute/path/to/allowed/repos'
export CODETHREAD_ANALYZER_BUILD_HASH='<verified lowercase SHA-256 build fingerprint>'
pnpm build
pnpm backend:start
```

The service binds **127.0.0.1:8765 only**, requires `Authorization: Bearer <token>`
on all endpoints, restricts Host/Origin and JSON body sizes, and does not enable
cross-origin browser requests. This is **not a multi-user or remote API**.
The build fingerprint must be produced and verified by the release process;
supplying arbitrary hashes does not itself attest analyzer provenance.

## Routes

| Request | Behavior |
|---|---|
| POST /v1/repositories | Register an existing Git repository beneath the allowed root |
| GET /v1/repositories | List up to 50 registered repositories |
| GET /v1/repositories/:id | Repository and active scan |
| POST /v1/repositories/:id/scans | Queue pinned revision with repository-scoped idempotency key |
| GET /v1/scans/:id | Job status and immutable Git acquisition identity |
| POST /v1/scans/:id/cancel | Cancel queued/running scan |
| GET /v1/scans/:id/projects | Project readiness/diagnostics |
| GET /v1/scans/:id/files?offset=0 | Paged acquired source provenance |
| GET /v1/scans/:id/projects/:projectId/symbols | Bounded symbol search |
| POST /v1/scans/:id/projects/:projectId/neighbors | Existing graph-neighbor contract |
| POST /v1/scans/:id/projects/:projectId/paths | Existing graph-path contract |
| POST /v1/scans/:id/projects/:projectId/evidence | Existing source-evidence contract |

A scan request is JSON `{"revision":"HEAD","idempotencyKey":"unique-per-logical-request"}`.
Query bodies for neighbors, paths and evidence use the corresponding
`@codethread/contracts` request, including the returned snapshotId.
The server does not infer unknown symbol targets or merge unrelated project contexts.

## Verification boundaries

`pnpm check` verifies TypeScript, architecture and non-database regressions.
The dedicated PostgreSQL integration suite requires an isolated real database,
schema migration, a pinned local test Git repository, and an immutable source
round-trip. Hosted CI must pass on Ubuntu and Windows for ordinary checks and
on Ubuntu with PostgreSQL for persistence checks.

Known remaining gaps to review before production: full DB-01 equivalence,
operational grant scripts, repeatable migration upgrades, verified backup/restore,
retention/purge, multi-user authentication, multi-instance failover, operational
metrics, performance at maximum payload sizes and independent semantic labels.
The DB has no cloud source ingestion or general runtime execution.
