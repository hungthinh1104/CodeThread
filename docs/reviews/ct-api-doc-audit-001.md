# CT-API-DOC-AUDIT-001

- **Repository:** `hungthinh1104/CodeThread`
- **Scope:** PR #36, `feat/ct-mvp-release-001`
- **Fetched base:** `main` at `b61a0170811f5b0a6d037314bb76bccc354f3380`
- **Remote PR head at audit start:** `4b7d52e6fd98cca26277dfd7c2d303ee6693e6e6`
- **Implementation audited:** `02c7334029d18859c64341602391420be4ec1339` plus
  the route-list regression in candidate
  `32dad922602070e88fb499b52310c0f9e54c87f9`.
- **Follow-up baseline:** `2237e699b3b37047379bad607b43674511db956b`; this SHA
  is the baseline for the additional contract and pagination fixes below. The
  final candidate SHA and its checks are recorded after the final commit.
- **Decision:** **BLOCKED / NO-GO for merge.** Keep PR #36 draft and unmerged.

## Scope and method

The audit compared route dispatch, schemas, persistence/query adapters,
documentation, requirements, architecture and existing HTTP/DB/browser tests.
The baseline was fetched before editing; work remains on the existing PR branch.
No new API capability or database migration was added. The local backend remains
a loopback candidate, not a released external API.

`tests/api-documentation.test.ts` checks literal dispatcher/documentation
parity, backend and viewer response-schema map parity, and presence of positive
and negative route cases for repository and selected viewer modes. Dedicated
HTTP suites validate the behavior, responses and errors against those schemas.
The census does not derive OpenAPI or prove every possible request permutation.
Route status cells below describe implementation and focused local-candidate
tests; exact final-SHA and hosted status is tracked separately in the final
handoff.

## Complete route traceability

### Persistent backend

Dispatch is in `scripts/backend/http.ts`; service state lives in
`scripts/backend/service.ts`, query behavior in
`scripts/backend/query-service.ts`, and output DTOs in
`scripts/backend/http-contracts.ts`. Each success and error response is
validated before serialization. The real HTTP matrix uses disposable PostgreSQL;
`tests/api-documentation.test.ts` checks literal dispatcher, schema-map,
test-matrix and documentation parity.

| Method + path                                      | Handler                        | Input schema / limits                                                          | Success response schema                                       | DB operations                                                               | Tests                                                                                            | Documentation                              | Status                             |
| -------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------ | ---------------------------------- |
| `GET /v1/health`                                   | health branch                  | No body or query.                                                              | Strict readiness object with state consistency.               | `SELECT 1`; worker readiness is in memory.                                  | `backend-api-contract`, worker readiness/probe tests; ready and stopped-worker 503.              | `docs/api/inventory.md`, `docs/backend.md` | Implemented; local candidate PASS. |
| `POST /v1/repositories`                            | `service.register`             | `registerRepository`: required locator, 1–4,096 chars.                         | Strict `{id, locator}` DTO.                                   | Allowed-root validation and repository insert.                              | `backend-api-contract`: readback, missing/null/extra/overlong cases.                             | `docs/api/inventory.md`, `docs/backend.md` | Implemented; local candidate PASS. |
| `GET /v1/repositories`                             | `service.repositories`         | No body or query.                                                              | Strict array of at most 50 repository DTOs.                   | Repository table read.                                                      | `backend-api-contract`: list contains persisted fixture.                                         | `docs/api/inventory.md`, `docs/backend.md` | Implemented; local candidate PASS. |
| `GET /v1/repositories/:id`                         | `service.repository`           | UUID path parameter; no body/query.                                            | Strict repository DTO; generation normalized to decimal text. | Repository row read.                                                        | `backend-api-contract`: existing, malformed and missing IDs.                                     | `docs/api/inventory.md`, `docs/backend.md` | Implemented; local candidate PASS. |
| `POST /v1/repositories/:id/scans`                  | `service.accept`               | UUID plus strict `requestScan` (`revision` 1–1,024; idempotency key 1–128).    | Strict queued-scan acceptance DTO.                            | Idempotent scan-job insert and repository generation update in transaction. | `backend-api-contract`, `backend-integration`: replay, concurrency, conflict rollback, inputs.   | `docs/api/inventory.md`, `docs/backend.md` | Implemented; local candidate PASS. |
| `GET /v1/scans/:id`                                | `service.job`                  | UUID path parameter; no body/query.                                            | Strict scan row; generation and timestamps normalized.        | Scan-job row read.                                                          | `backend-api-contract`: persisted state/provenance and malformed/missing IDs.                    | `docs/api/inventory.md`, `docs/backend.md` | Implemented; local candidate PASS. |
| `POST /v1/scans/:id/viewer`                        | `viewers.open`                 | UUID path parameter; body must be empty.                                       | Strict URL/expiry DTO.                                        | Reads pinned scan/project/snapshot/source rows at viewer startup; no write. | `backend-api-contract`, `backend-persistent-browser`: persisted viewer, 404/409, body rejection. | `docs/api/inventory.md`, `docs/backend.md` | Implemented; local candidate PASS. |
| `POST /v1/scans/:id/cancel`                        | `service.cancel`               | UUID path parameter; body must be empty.                                       | Strict `{id,state:'cancelled'}` DTO.                          | Conditional scan-job state transition.                                      | `backend-api-contract`, `backend-integration`: persisted cancellation and terminal conflict.     | `docs/api/inventory.md`, `docs/backend.md` | Implemented; local candidate PASS. |
| `GET /v1/scans/:id/projects`                       | `service.projects`             | UUID path parameter; no body/query.                                            | Strict project rows, at most 32.                              | Scan existence and project rows read.                                       | `backend-api-contract`: status, diagnostics, snapshot IDs and missing scan.                      | `docs/api/inventory.md`, `docs/backend.md` | Implemented; local candidate PASS. |
| `GET /v1/scans/:id/files`                          | `service.files`                | UUID plus strict optional `offset` (default 0, range 0–1,256).                 | Strict 50-row pinned-input page.                              | Input-file count and ordered page read.                                     | `backend-api-contract`: default paging, order, SHA/blob provenance and invalid bounds.           | `docs/api/inventory.md`, `docs/backend.md` | Implemented; local candidate PASS. |
| `GET /v1/scans/:id/projects/:projectId/symbols`    | `queries.symbols`              | UUID, project ID, optional query (max 256) and offset (default 0, max 20,000). | Shared strict list-symbols response.                          | Published snapshot and bounded symbol-page reads.                           | `backend-api-contract`, `query-results`: snapshot scope, paging and malformed/missing context.   | `docs/api/inventory.md`, `docs/backend.md` | Implemented; local candidate PASS. |
| `POST /v1/scans/:id/projects/:projectId/neighbors` | `queries.project('neighbors')` | UUID/project plus strict `graphNeighborsRequestSchema`.                        | Shared strict graph response; request-aware parse.            | Published snapshot/source evidence reads in a bounded query transaction.    | `backend-api-contract`, query tests: deterministic graph, bounds and snapshot ownership.         | `docs/api/inventory.md`, `docs/backend.md` | Implemented; local candidate PASS. |
| `POST /v1/scans/:id/projects/:projectId/paths`     | `queries.project('paths')`     | UUID/project plus strict `findSymbolPathsRequestSchema`.                       | Shared strict path response; request-aware parse.             | Published snapshot/source evidence reads in a bounded query transaction.    | `backend-api-contract`, query tests: exact relation/path identity and request bounds.            | `docs/api/inventory.md`, `docs/backend.md` | Implemented; local candidate PASS. |
| `POST /v1/scans/:id/projects/:projectId/evidence`  | `queries.project('evidence')`  | UUID/project plus strict `getSourceEvidenceRequestSchema` (1–100 unique IDs).  | Shared strict evidence response; request-aware parse.         | Published source evidence reads under the owning snapshot.                  | `backend-api-contract`, query tests: bytes/hash/range and invalid ID collections.                | `docs/api/inventory.md`, `docs/backend.md` | Implemented; local candidate PASS. |

Backend access requires exact loopback Host, optional exact Origin and bearer
token. JSON bodies and responses are capped at 64 KiB and 1 MiB. Bodyless POST
routes reject non-empty bodies. Errors use a strict sanitized
`{error:{code,message}}` envelope; malformed UTF-8 returns 400 `INVALID_JSON`,
malformed percent-encoded path segments return 400 `INVALID_REQUEST`, and
method/path mismatch remains 404.

### Ephemeral viewer API

The access gate is `scripts/viewer.ts`; route projections are in
`scripts/viewer-api.ts` and `scripts/viewer-projection.ts`. `queryViewer`
validates strict success responses before serialization. Repository and
selected-snapshot modes are both covered by real HTTP tests through the shared
response-schema map. A persistent viewer loads its state from PostgreSQL once;
each viewer API request reads its in-memory dataset.

| Method + path              | Handler                            | Input schema / limits                                                                           | Success response schema                                                       | DB operations                                                       | Tests                                                                                        | Documentation           | Status                             |
| -------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------- | ---------------------------------- |
| `POST /api/projects`       | `queryViewer` → `dataset.projects` | Exact `{}`.                                                                                     | Strict project-list response.                                                 | None per request; repository session loaded once at viewer startup. | `viewer-api-contract`, `viewer-selected-api-contract`.                                       | `docs/api/inventory.md` | Implemented; local candidate PASS. |
| `POST /api/catalog`        | `queryViewer` → `dataset.search`   | Strict `{query?,offset?}`; query max 256, offset max 640,000.                                   | Strict 50-row page and continuation invariant.                                | None per request; searches in-memory snapshot catalog.              | Both viewer contract suites: defaults, ordering, null/extra and bounds.                      | `docs/api/inventory.md` | Implemented; local candidate PASS. |
| `POST /api/files`          | `queryViewer` → `dataset.files`    | Strict `{offset?}`; offset max 2,000.                                                           | Strict 50-row page; excluded entries require null SHA/length and no blob ID.  | None per request; pages in-memory source inventory.                 | Both viewer contract suites; response negative control checks excluded provenance.           | `docs/api/inventory.md` | Implemented; local candidate PASS. |
| `POST /api/follow-context` | `queryViewer` → `dataset.follow`   | Strict selected `{snapshotId,symbolId}` or repository `{projectId,request}` wrapper.            | Strict context; non-empty candidates and choice flag matches candidate count. | None per request; verifies retained in-memory source evidence/hash. | Both viewer suites; stale snapshot and response-schema choice negative controls.             | `docs/api/inventory.md` | Implemented; local candidate PASS. |
| `POST /api/session`        | `queryViewer` → `querySnapshot`    | Exact selected `{}` or repository wrapper with exact empty request.                             | Strict session response, wrapped only in repository mode.                     | None per request; reads in-memory published snapshot.               | Both viewer contract suites; snapshot identity/counters and invalid envelope inputs.         | `docs/api/inventory.md` | Implemented; local candidate PASS. |
| `POST /api/symbols`        | `queryViewer` → `querySnapshot`    | Strict query/offset request with mode-specific offset cap; repository wrapper where applicable. | Strict symbol page with continuation invariant; wrapped in repository mode.   | None per request; searches in-memory published snapshot.            | Both viewer suites, response negative controls and query tests.                              | `docs/api/inventory.md` | Implemented; local candidate PASS. |
| `POST /api/neighbors`      | `queryViewer` → `querySnapshot`    | Shared strict `graphNeighborsRequestSchema`; repository wrapper where applicable.               | Strict graph/unknowns response, wrapped only in repository mode.              | None per request; bounded trace over in-memory snapshot/source.     | Both viewer contract suites and query tests: bounds, ownership and actual graph response.    | `docs/api/inventory.md` | Implemented; local candidate PASS. |
| `POST /api/evidence`       | `queryViewer` → `querySnapshot`    | Shared strict `getSourceEvidenceRequestSchema`; repository wrapper where applicable.            | Strict source-evidence response, wrapped only in repository mode.             | None per request; reads retained in-memory source evidence.         | Both viewer contract suites and query tests: verified bytes/hash and invalid ID collections. | `docs/api/inventory.md` | Implemented; local candidate PASS. |

`tests/viewer-api-contract.test.ts` checks all eight repository-profile routes
and seven assets. `tests/viewer-selected-api-contract.test.ts` checks all eight
selected-snapshot routes. Each asset is fetched byte-for-byte without an API
token and separately tested against a non-loopback Host. Both HTTP surfaces cap
bodies at 64 KiB and responses at 1 MiB. Viewer API access requires loopback
Host/peer, same-origin Origin and a random token; static assets do not require
the API token. Error status/code mappings intentionally differ from the backend.

### Static viewer routes

All assets are loaded into memory at viewer startup by `scripts/viewer.ts`; each
GET requires exact loopback Host/peer, but no Origin or API token. They have no
DB effects.

| Method + path                      | Handler/output                                   | Input / limits               | Response schema/output         | DB operations | Tests                                        | Documentation           | Status                             |
| ---------------------------------- | ------------------------------------------------ | ---------------------------- | ------------------------------ | ------------- | -------------------------------------------- | ----------------------- | ---------------------------------- |
| `GET /`                            | In-memory `viewer.html`, `text/html`.            | No body; loopback Host/peer. | Exact bundled bytes, no-store. | None.         | `viewer-api-contract`: exact bytes and Host. | `docs/api/inventory.md` | Implemented; local candidate PASS. |
| `GET /viewer.js`                   | Browser entry, `text/javascript`.                | No body; loopback Host/peer. | Exact bundled bytes, no-store. | None.         | `viewer-api-contract`: exact bytes and Host. | `docs/api/inventory.md` | Implemented; local candidate PASS. |
| `GET /viewer.css`                  | Stylesheet, `text/css`.                          | No body; loopback Host/peer. | Exact bundled bytes, no-store. | None.         | `viewer-api-contract`: exact bytes and Host. | `docs/api/inventory.md` | Implemented; local candidate PASS. |
| `GET /viewer-client/dom.js`        | DOM projection module, `text/javascript`.        | No body; loopback Host/peer. | Exact bundled bytes, no-store. | None.         | `viewer-api-contract`: exact bytes and Host. | `docs/api/inventory.md` | Implemented; local candidate PASS. |
| `GET /viewer-client/projection.js` | Semantic projection module, `text/javascript`.   | No body; loopback Host/peer. | Exact bundled bytes, no-store. | None.         | `viewer-api-contract`: exact bytes and Host. | `docs/api/inventory.md` | Implemented; local candidate PASS. |
| `GET /viewer-client/history.js`    | History module, `text/javascript`.               | No body; loopback Host/peer. | Exact bundled bytes, no-store. | None.         | `viewer-api-contract`: exact bytes and Host. | `docs/api/inventory.md` | Implemented; local candidate PASS. |
| `GET /viewer-client/repository.js` | Repository navigation module, `text/javascript`. | No body; loopback Host/peer. | Exact bundled bytes, no-store. | None.         | `viewer-api-contract`: exact bytes and Host. | `docs/api/inventory.md` | Implemented; local candidate PASS. |

`tests/viewer-api-contract.test.ts` fetches each asset over HTTP, checks exact
bytes and content type without a token, and verifies every path rejects a
non-loopback Host.

### Shared semantic operations and non-routes

| Operation                                                                                          | Status/exposure                                                                       |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `getSourceEvidence`                                                                                | Implemented in memory by trace engine; CLI, viewer and persistent backend.            |
| `graphNeighbors`                                                                                   | Implemented in memory; CLI, viewer and persistent backend.                            |
| `findSymbolPaths`                                                                                  | Implemented in memory and persistent backend; not exposed by CLI or ephemeral viewer. |
| `listSymbols`                                                                                      | Persistent backend query; viewer search is a separate presentation-local contract.    |
| `listTests`, `getTestTrace`, `getRelatedProductionSymbols`, `findTestsForSymbol`, `getDiagnostics` | Shared schema/result contracts only; no standalone executor or HTTP route.            |
| `queryErrorSchema`                                                                                 | Contract only; not wired as a common backend/viewer error transport.                  |

No `/tests` or standalone diagnostics route is implemented. These distinctions
are recorded in `docs/api/inventory.md`; contract presence is not presented as
runtime capability.

## Findings and changes

| Finding                                                                                                                        | Root cause                                                                                                                                      | Resolution and regression evidence                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The earlier API inventory omitted four viewer APIs and seven static assets.                                                    | Route docs lagged implementation.                                                                                                               | Inventory/setup docs now list all 14 backend routes, eight dynamic viewer APIs and seven assets; route census test checks parity.                                                   |
| Backend and viewer control/list responses had no runtime output validators.                                                    | Existing checks covered request schemas and semantic query results, but several control projections were serialized directly.                   | Added strict backend route-keyed schemas and strict viewer response schemas; successful responses validate before serialization. The docs test checks route/schema/test map parity. |
| Viewer file response schema accepted an excluded entry with source hash, Git blob ID and length.                               | File rows were individually strict, but excluded status was not related to provenance fields.                                                   | Added a cross-field invariant requiring excluded content fields to remain null/absent; `tests/viewer-api-response-contract.test.ts` rejects the forged projection.                  |
| Viewer catalog/files/symbol pages could claim more or fewer rows than `total - offset`, or advertise a false continuation.     | Response schemas validated field ranges but not the shared page-count invariant.                                                                | Added one shared page consistency rule in `scripts/viewer-page-contract.ts`; negative controls reject overfull pages and wrong continuations for all three schemas.                 |
| Follow-context could omit a required choice for multiple candidates or return no candidate.                                    | The response schema validated fields but not candidate-count consistency.                                                                       | Added a non-empty candidate requirement and `requiresChoice` refinement in `scripts/viewer-api.ts`; response negative controls reject both contradictions.                          |
| Backend and viewer handlers ignored undocumented or repeated URL query parameters.                                             | Dispatch read only known parameters and did not enforce a route allowlist.                                                                      | Backend routes now allow only documented unique keys and decimal offsets; viewer APIs reject URL queries. HTTP regressions cover unknown, repeated and malformed query values.      |
| Selected-mode stale-snapshot negative case could pass without reaching the stale-snapshot branch.                              | Negative request objects captured fixture IDs while module-loading, before setup; the stale case sent an empty symbol ID and only proved a 400. | Inputs are now built inside each route test after fixture setup; non-empty case assertion and stale-snapshot 404 regression are in `tests/viewer-selected-api-contract.test.ts`.    |
| Persistent viewer requests for missing or non-ready scans surfaced as generic 500 errors.                                      | Session load used one generic error for missing, unpinned and non-succeeded rows.                                                               | Added typed not-found/not-ready state mapping to 404/409; PostgreSQL route test verifies both states.                                                                               |
| Bodyless viewer/cancel POST routes were documented as not reading the body although the route contract must reject body bytes. | Inventory and backend guide did not describe the enforced empty-body rule.                                                                      | `scripts/backend/http.ts` rejects non-empty bodies within the existing 64 KiB bound; both API documents and HTTP negative tests now state and verify the rule.                      |
| Direct Node 24 worker processes could not load a TypeScript constructor parameter property in the new error class.             | Node's strip-only TypeScript loader does not support parameter properties.                                                                      | Replaced it with an explicit field assignment. `backend-http-restart.test.ts` now includes bounded child stderr in startup failures; process restart passes.                        |
| Route-presence checks did not prove per-route request/response behavior.                                                       | AST coverage only asserted documentation presence.                                                                                              | Added real HTTP positive and route-specific negative matrices for all backend and viewer routes in both modes, malformed UTF-8/path tests, and seven static-asset byte/Host checks. |

### Additional follow-up findings

The viewer file response also now rejects `analyzed` and `not_analyzed` rows
without a SHA-256 and byte length. Producer file rows carry both values for all
included committed sources; response-schema negative controls cover both
statuses and prevent missing source provenance from passing validation.

Key implementation and regression locations: `scripts/backend/http.ts:80` (route
validation, query allowlists and bodyless POSTs), `scripts/backend/http.ts:325`
(response-size fallback), `scripts/backend/http-contracts.ts:149` (backend
response-schema map), `scripts/viewer-api.ts:95` (catalog snapshot identity),
`scripts/viewer-api.ts:145` (included/excluded file provenance),
`scripts/viewer-projection.ts:62` (page consistency) and `:73` (symbol snapshot
identity), `scripts/viewer-page-contract.ts:9` (shared pagination invariant),
`tests/api-documentation.test.ts:221` (route/schema/test/doc parity),
`tests/backend-api-contract.test.ts:414` (real HTTP response-cap assertion), and
`tests/viewer-pagination-contract.test.ts:48` (HTTP page-boundary tests).

| Finding                                                                                                                | Root cause                                                                                              | Resolution and regression evidence                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Catalog and symbol-page response schemas did not compare nested symbol snapshot IDs with their enclosing snapshot IDs. | Field schemas validated each UUID independently, so cross-snapshot rows could pass response validation. | `scripts/viewer-api.ts` and `scripts/viewer-projection.ts` now enforce equality; `tests/viewer-api-response-contract.test.ts` rejects forged catalog and symbol pages.                                                           |
| Viewer pagination fixtures stayed below 50 rows, and backend symbol HTTP pagination had only one-row coverage.         | No request exercised a non-null continuation or second-page ordering.                                   | `tests/viewer-pagination-contract.test.ts` and `tests/backend-api-contract.test.ts` now request rows 1–50 and 51, checking order and `nextOffset`; backend files over 50 remain covered by `tests/backend-release-gate.test.ts`. |
| The backend 1 MiB response limit had no negative HTTP test.                                                            | Existing size checks exercised request limits and viewer response limits only.                          | `tests/backend-api-contract.test.ts` creates a separate disposable PostgreSQL database, seeds a valid running job/project row, and observes sanitized HTTP 413 `RESPONSE_TOO_LARGE`; it does not mutate published rows.          |
| Two backend integration callers sent `{}` to routes requiring a truly empty body.                                      | The old test helper represented “no body” as a JSON empty object.                                       | `tests/backend-queue-limit.test.ts` and `tests/backend-persistent-browser.test.ts` now issue POST with no body and pass their real-PostgreSQL regressions.                                                                       |

No database migration or product route was added. The additional viewer matrix
covers selected-snapshot mode, which shares the viewer schemas but had not been
checked through every route before this follow-up.

## Test integrity and verification evidence

Environment: Windows, pinned Node 24.22.2 / pnpm 12.16.1, and disposable
PostgreSQL 17 containers. No production database or credentials were used. The
first broad run exposed an unsupported TypeScript parameter property when Node
started the backend child process; that syntax was replaced and the failing
process-restart, partial-session and persistent-browser tests passed
individually.

The first table below is historical evidence from earlier candidate trees. The
implementation commit evidence in the following table supersedes it for this API
audit follow-up.

| Command / suite                                                                                                                                                                               | Observed result                                                         | Evidence boundary                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm exec vitest run tests/api-documentation.test.ts tests/viewer-api-contract.test.ts tests/viewer-api-response-contract.test.ts tests/viewer-selected-api-contract.test.ts --maxWorkers=1` | 4 files, 53 tests passed.                                               | Actual viewer HTTP responses for all eight routes in both modes; all seven asset bytes/content types and per-asset Host rejection; route/schema/test parity; pagination, candidate-choice and excluded-file negative controls. |
| `pnpm exec vitest run tests/backend-api-contract.test.ts --maxWorkers=1 --reporter=verbose`                                                                                                   | 1 file, 31 tests passed.                                                | Real HTTP server and disposable PostgreSQL; latest run includes malformed UTF-8 and encoded-path rejection.                                                                                                                    |
| Ordered backend PostgreSQL suite (`--maxWorkers=1`)                                                                                                                                           | Historical candidate: 16 files passed, 1 skipped; 77 passed, 5 skipped. | Real PostgreSQL 17. This earlier run is not final-SHA evidence; the full ordered suite is required after commit.                                                                                                               |
| `tests/backend-database-restart.test.ts --maxWorkers=1`                                                                                                                                       | 1 file, 3 tests passed.                                                 | Dedicated disposable PostgreSQL 17 container; verifies rollback/recovery across input, publication and activation stages.                                                                                                      |
| `pnpm check` on the dirty candidate                                                                                                                                                           | Exit 1; 46 files passed, 1 failed, 18 skipped; 546 passed, 86 skipped.  | The two failures in `tests/study-toolkit.test.ts` are its intentional `SCORER_WORKTREE_DIRTY` guard; the scorer requires a clean committed checkout. No assertion was changed.                                                 |
| Clean final-SHA `pnpm check`, semantic/external evaluation, browser tasks and security audit                                                                                                  | NOT RUN yet.                                                            | Required after committing the complete candidate; the dirty-tree result above is not a substitute.                                                                                                                             |
| Hosted Ubuntu, Windows and PostgreSQL Actions                                                                                                                                                 | NOT RUN on this diff.                                                   | PR head `2237e699b3b37047379bad607b43674511db956b` has historical run #175; exact changed-SHA checks remain required after push.                                                                                               |

### Follow-up verification on the current candidate tree

These results include the additional response identity, pagination,
response-size, and empty-body caller regressions above. They were run before the
final commit; the final-SHA `pnpm check`, evaluations, browser run, security
audit and hosted CI are tracked separately below.

| Command / suite                                                                                                                                                      | Observed result                                                        | Evidence boundary                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Focused API/doc suite: `api-documentation`, `backend-api-contract`, repository/selected viewer contracts, response controls and viewer pagination (`--maxWorkers=1`) | 6 files, 87 tests passed.                                              | Real HTTP; backend contracts use disposable PostgreSQL 17. Includes 22 route matrices, seven assets, pagination pages, response-schema negative controls, malformed UTF-8/path and response cap.                                                             |
| `tests/backend-queue-limit.test.ts` and `tests/backend-persistent-browser.test.ts --maxWorkers=1`                                                                    | 2 files, 2 tests passed.                                               | Actual PostgreSQL cancellation, bodyless requests and persisted viewer restart.                                                                                                                                                                              |
| Ordered backend PostgreSQL suite (`--maxWorkers=1`)                                                                                                                  | 16 files passed, 1 skipped; 80 passed, 5 skipped.                      | Fresh disposable PostgreSQL 17 database. The five skipped cases are POSIX signal-shutdown cases skipped on Windows; all other listed worker, migration, mutation, HTTP, admission, browser and recovery suites passed.                                       |
| `tests/backend-database-restart.test.ts --maxWorkers=1`                                                                                                              | 1 file, 3 tests passed.                                                | Dedicated restart-only PostgreSQL 17 container; exercises input, publication and activation rollback/recovery.                                                                                                                                               |
| `pnpm format:check`, `pnpm lint`, `pnpm typecheck`                                                                                                                   | PASS.                                                                  | Pinned Windows Node 24.22.2 / pnpm 12.16.1 on the candidate tree.                                                                                                                                                                                            |
| First ordered backend attempt on the previously used task database                                                                                                   | 2 tests failed; corrected targeted rerun passed.                       | `backend-persistent-browser` and `backend-queue-limit` sent `{}` to bodyless routes. The server correctly returned 400; callers were fixed to omit body bytes. Fresh-database ordered suite then passed with only the five platform skips above.             |
| First response-cap negative-control design                                                                                                                           | Rejected by PostgreSQL immutability trigger before the HTTP assertion. | The attempt to rewrite a published project's diagnostics failed with `scan project provenance is immutable`. The test now uses a separate disposable database and an insert-valid running-job/project row; it never disables guards or edits published data. |

### Verification on the API implementation commit

Implementation commit: `5b7f576ceb2a9102db583fd6610fbfc832e91ca9`. The following
checks were run against the complete committed implementation on this SHA. The
final handoff records any subsequent report-only commit and its exact
current-head CI state; no hosted result from an earlier SHA is reused.

| Command / suite                                         | Observed result                                                                                            | Evidence boundary                                                                                                                                                                                |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm check`                                            | Exit 0; 49 files passed, 18 skipped; 550 tests passed, 88 skipped.                                         | Clean committed worktree. Format, lint, requirements, architecture, build, study validation and typecheck passed. Database suites skip here because this command had no PostgreSQL URL.          |
| `pnpm eval:semantic`                                    | Exit 0; 13/13 eligible exact, 0 incorrect, 17/30 supported.                                                | Gold labels are Codex-authored and not independently reviewed; support coverage is 56.7%, exact coverage 43.3%.                                                                                  |
| `pnpm eval:external`                                    | Exit 0; all emitted evaluation gates passed.                                                               | External labels are not independently reviewed; some contexts are incomplete. Output is static evidence and not a runtime or repository-wide accuracy claim.                                     |
| `pnpm test:browser`                                     | Exit 0; pinned Git discovery and repository navigation passed; ufo 5/5 and sourcemaps 6/6 tasks completed. | Workflow labels are not independently reviewed and do not establish comprehension improvement.                                                                                                   |
| `pnpm security:check`                                   | Exit 0; no known vulnerabilities found.                                                                    | Native pinned pnpm advisory audit.                                                                                                                                                               |
| Focused API/doc suite (`--maxWorkers=1`)                | 6 files, 87 tests passed.                                                                                  | Real HTTP contract matrix; backend routes use disposable PostgreSQL 17. Includes response schemas, negative controls, pagination, response cap and route/docs parity.                            |
| Ordered backend PostgreSQL suite (`--maxWorkers=1`)     | 16 files passed, 1 skipped; 80 passed, 5 skipped.                                                          | Fresh disposable PostgreSQL 17 container. Five Windows skips are POSIX signal-shutdown cases; no other listed integration suite skipped.                                                         |
| `tests/backend-database-restart.test.ts --maxWorkers=1` | 1 file, 3 tests passed.                                                                                    | Dedicated disposable PostgreSQL 17 restart-only container; input, publication and activation rollback/recovery.                                                                                  |
| Hosted Ubuntu, Windows and PostgreSQL CI                | PASS on candidate `a5811fa079390ddeee19f50efc3d22ebd342d512`.                                              | [Run #177](https://github.com/hungthinh1104/CodeThread/actions/runs/43761291528) passed Ubuntu, Windows and PostgreSQL on that exact SHA; the current report-only update is verified separately. |

### Latest full verification snapshot on the API report candidate

Candidate: `bc5079d4892bfd9bbea2cbe8e60735208baacdaa` on
`feat/ct-mvp-release-001`. This candidate contains the API implementation from
`5b7f576ceb2a9102db583fd6610fbfc832e91ca9` and its review report update. The
following local checks and hosted run were observed on this exact candidate SHA:

| Command / suite                                     | Observed result                                                                    | Evidence boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`                                        | Exit 0; 49 files passed, 18 skipped; 550 tests passed, 88 skipped.                 | Format, lint, requirements, architecture, build, study validation, typecheck and Vitest passed. PostgreSQL suites skip without a database URL.                                                                                                                                                                                                                                                                                                                                              |
| `pnpm eval:semantic`                                | Exit 0; 13/13 eligible exact, 0 incorrect, 17/30 supported.                        | Gold labels are Codex-authored and not independently reviewed; support coverage is 56.7%, exact coverage 43.3%.                                                                                                                                                                                                                                                                                                                                                                             |
| `pnpm eval:external`                                | Exit 0; emitted gates passed.                                                      | External labels are not independently reviewed and some contexts are incomplete; this is not a runtime or repository-wide accuracy claim.                                                                                                                                                                                                                                                                                                                                                   |
| `pnpm test:browser`                                 | Exit 0; browser investigations passed; ufo 5/5 and sourcemaps 6/6 tasks completed. | Workflow labels are not independently reviewed and do not establish human benefit.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `pnpm security:check`                               | Exit 0; no known vulnerabilities found.                                            | Native pinned pnpm advisory audit.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Focused API/doc suite (`--maxWorkers=1`)            | 6 files, 87 tests passed.                                                          | Real HTTP; backend routes use disposable PostgreSQL 17; includes route/docs parity and negative controls.                                                                                                                                                                                                                                                                                                                                                                                   |
| Ordered PostgreSQL backend suite (`--maxWorkers=1`) | 16 files passed, 1 skipped; 80 passed, 5 skipped.                                  | Disposable PostgreSQL 17. Five Windows skips are POSIX signal-shutdown cases.                                                                                                                                                                                                                                                                                                                                                                                                               |
| Dedicated PostgreSQL restart suite                  | 1 file, 3 tests passed.                                                            | Task-owned, labeled restart-only PostgreSQL 17 container.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Hosted Ubuntu, Windows and PostgreSQL               | PASS.                                                                              | [Run #179](https://github.com/hungthinh1104/CodeThread/actions/runs/43763541149): [Ubuntu](https://github.com/hungthinh1104/CodeThread/actions/runs/43763541149/job/132963443524), [Windows](https://github.com/hungthinh1104/CodeThread/actions/runs/43763541149/job/132963443626), [PostgreSQL](https://github.com/hungthinh1104/CodeThread/actions/runs/43763541149/job/132963443311) all succeeded on this exact candidate. PostgreSQL CI includes restart and isolated backup/restore. |

This is the latest full verification snapshot before the current report-only
revision. Run #179 covers `bc5079d4892bfd9bbea2cbe8e60735208baacdaa`; the
current PR description records the exact current head and its own validation.

## Acceptance matrix

| Gate                                                                                               | Result                             | Evidence / limitation                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every implemented backend/viewer/static route is inventoried and documented.                       | PASS                               | 14 backend routes, eight viewer APIs and seven static assets; route census checks docs and source.                                                                                     |
| Every dynamic API has a positive and applicable negative real HTTP contract case.                  | PASS on candidate `bc5079d`.       | 14 backend routes use disposable PostgreSQL; all eight viewer routes run in repository and selected modes. Static asset tests fetch exact bytes and check Host rejection per asset.    |
| Success projections are validated by strict response schemas before serialization.                 | PASS on candidate `bc5079d`.       | Route-keyed backend schemas, viewer schemas, schema-map parity, page/snapshot/source identity and malformed-response controls.                                                         |
| Retry/idempotency, concurrency, cancellation, provenance, persistence and recovery remain correct. | PASS on candidate `bc5079d`.       | Focused contract matrix, ordered backend PostgreSQL suite and dedicated restart suite passed using disposable PostgreSQL 17 only.                                                      |
| Zero unresolved P0/P1 defect in the inspected API contract scope.                                  | PASS in reviewed scope.            | Confirmed contract gaps were corrected and retested; final spec and standards re-reviews found no remaining contract gap or hard standards violation. Human approval remains separate. |
| Latest completed local and hosted verification on one exact SHA.                                   | PASS on candidate `bc5079d`.       | Full local and hosted results are recorded above and were run on the exact SHA `bc5079d4892bfd9bbea2cbe8e60735208baacdaa`.                                                             |
| Human review/approval and merge authorization.                                                     | NOT VERIFIED; merge remains NO-GO. | PR #36 stays draft and unmerged. This implementation task does not request merge or bypass protection.                                                                                 |

## Residual risks and merge recommendation

- The route census is source-based and guards literal route/schema/test parity;
  it does not generate OpenAPI or prove every possible request permutation.
- Backend and viewer error status/code mappings intentionally differ; this is
  documented and remains a local adapter contract, not cross-adapter parity.
- There is no stable external API compatibility promise or OpenAPI document.
- Semantic labels and external evaluation remain outside this API contract gate;
  no human study or production behavior is claimed.
- Candidate `bc5079d4892bfd9bbea2cbe8e60735208baacdaa` passed the exact-SHA
  local and hosted gates recorded above. Run #179 does not cover this newer
  report-only revision; consult the current PR description for its checks.
- Human review/approval remains a separate merge prerequisite; the user has not
  authorized a merge or a branch-protection bypass.

**Decision: GO for the scoped API-contract gate; BLOCKED / NO-GO for merge.**
Candidate `bc5079d4892bfd9bbea2cbe8e60735208baacdaa` passed local, real-
PostgreSQL and hosted Ubuntu/Windows/PostgreSQL verification. Human review and
approval remain outstanding; keep PR #36 draft and unmerged.
