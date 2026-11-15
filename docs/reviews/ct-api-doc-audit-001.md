# CT-API-DOC-AUDIT-001

- **Repository:** `hungthinh1104/CodeThread`
- **Scope:** PR #36, `feat/ct-mvp-release-001`
- **Fetched base:** `main` at `b61a0170811f5b0a6d037314bb76bccc354f3380`
- **Remote PR head at audit start:** `4b7d52e6fd98cca26277dfd7c2d303ee6693e6e6`
- **Implementation audited:** local candidate
  `02c7334029d18859c64341602391420be4ec1339` plus the route-list regression
  added for this audit.
- **Decision:** **BLOCKED / NO-GO for merge.** Keep PR #36 draft and unmerged.

## Scope and method

The audit compared route dispatch, schemas, persistence/query adapters,
documentation, requirements, architecture and existing HTTP/DB/browser tests.
The baseline was fetched before editing; work remains on the existing PR branch.
No new API capability or database migration was added. The local backend remains
a loopback candidate, not a released external API.

Route documentation is now checked against dispatcher source by
`tests/api-documentation.test.ts`: it extracts backend `is(method, path...)`
calls, viewer pathname comparisons and the static asset path list, then requires
every route to appear in the relevant documentation sections. It intentionally
does not prove request/response schema parity, handler behavior, DB effects, or
negative coverage.

## Complete route traceability

### Persistent backend

Dispatch is in `scripts/backend/http.ts`; the service owner is
`scripts/backend/service.ts`, query owner is `scripts/backend/query-service.ts`,
and persisted viewer creation is `scripts/backend/viewer-adapter.ts`.

| Method + path                                      | Handler and input → output contract                                                                                          | DB / side effect                                                                                                                                                     | Tests and documentation                                                                                                                       | Audit                    |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `GET /v1/health`                                   | `makeApi` health branch; no input schema; direct `{api,database,worker,ready}` projection; 200 ready / 503 unavailable.      | `SELECT 1`; checks `ScanService.workerReady`.                                                                                                                        | `backend-integration`, `backend-worker-readiness`, `backend-worker-probe`; inventory and backend guide.                                       | Implemented, documented. |
| `POST /v1/repositories`                            | `registerRepository` schema (`locator`); direct registration projection, no output Zod schema; success 200.                  | Validates local allowed root and inserts repository.                                                                                                                 | `backend-integration`; oversized and outside-root negatives; inventory and backend guide.                                                     | Implemented, documented. |
| `GET /v1/repositories`                             | No request schema; returns up to 50 rows, no output Zod schema; success 200.                                                 | Selects repository state rows.                                                                                                                                       | `backend-queue-limit` now asserts returned IDs and rejects missing bearer; inventory and backend guide.                                       | Implemented, documented. |
| `GET /v1/repositories/:id`                         | UUID path validation; direct row, no output Zod schema; missing row 404.                                                     | Selects one repository row.                                                                                                                                          | `backend-queue-limit` pages desired generation; inventory and backend guide.                                                                  | Implemented, documented. |
| `POST /v1/repositories/:id/scans`                  | UUID plus `requestScan` (`revision`, `idempotencyKey`); direct acceptance projection, no output Zod schema; success 200.     | Transaction locks repository, verifies idempotency/request hash and analyzer identity, serializes global queue admission at 32, advances generation and inserts job. | `backend-integration`, `backend-queue-limit`; duplicate, conflict, concurrency and full-queue assertions; inventory and backend guide.        | Implemented, documented. |
| `GET /v1/scans/:id`                                | UUID path; direct job row, no output Zod schema; missing row 404.                                                            | Selects scan job state and provenance.                                                                                                                               | `backend-integration`, `backend-queue-limit`, `backend-persistent-browser`; inventory and backend guide.                                      | Implemented, documented. |
| `POST /v1/scans/:id/viewer`                        | UUID path; body is not read; returns viewer URL/expiry, no output Zod schema; 200, 429 at capacity, 503 without adapter.     | Loads a persisted session under read locks and opens an in-memory viewer; max four active viewers, 30-minute TTL.                                                    | `backend-integration`, `backend-persistent-browser`; inventory and backend guide.                                                             | Implemented, documented. |
| `POST /v1/scans/:id/cancel`                        | UUID path; body is not read; direct cancellation projection, no output Zod schema; terminal/missing state conflicts are 409. | Atomic queued/running transition and worker cancellation signal.                                                                                                     | `backend-queue-limit` exercises HTTP cancellation and re-admission; worker race tests cover service transitions; inventory and backend guide. | Implemented, documented. |
| `GET /v1/scans/:id/projects`                       | UUID path; direct list, no output Zod schema; up to 32 rows.                                                                 | Confirms job, then selects project status, diagnostics and snapshot IDs.                                                                                             | `backend-integration`, `backend-persistent-browser`; inventory and backend guide.                                                             | Implemented, documented. |
| `GET /v1/scans/:id/files`                          | UUID and strict integer `offset` 0–1,256; direct page projection, no output Zod schema; 50 rows.                             | Confirms job, counts pinned inputs, selects deterministic path-ordered page.                                                                                         | `backend-integration` verifies committed input order/provenance; inventory and backend guide.                                                 | Implemented, documented. |
| `GET /v1/scans/:id/projects/:projectId/symbols`    | UUID/project path; `listSymbolsRequestSchema` and `parseListSymbolsResult`; query max 256, offset 0–20,000, page max 50.     | Requires completed ready snapshot; reads published symbol/coverage projections under a shared snapshot lock.                                                         | `backend-integration`, `backend-query-admission`, query-result tests; inventory and backend guide.                                            | Implemented, documented. |
| `POST /v1/scans/:id/projects/:projectId/neighbors` | `graphNeighborsRequestSchema` → request-aware `parseGraphNeighborsResult`.                                                   | Requires published snapshot; loads and verifies snapshot/source, then traces bounded neighbors.                                                                      | `backend-integration`, `backend-query-admission`, semantic trace/query-result tests; inventory and backend guide.                             | Implemented, documented. |
| `POST /v1/scans/:id/projects/:projectId/paths`     | `findSymbolPathsRequestSchema` → request-aware `parseFindSymbolPathsResult`.                                                 | Requires published snapshot; loads and verifies snapshot/source, then traces bounded paths.                                                                          | `backend-integration`, semantic trace/query-result tests; inventory and backend guide.                                                        | Implemented, documented. |
| `POST /v1/scans/:id/projects/:projectId/evidence`  | `getSourceEvidenceRequestSchema` → request-aware `parseGetSourceEvidenceResult`.                                             | Requires published snapshot; verifies evidence ownership, retained file hash, range and exact source bytes.                                                          | `backend-integration`, `backend-persistent-browser`, query-result tests; inventory and backend guide.                                         | Implemented, documented. |

For these routes the backend enforces exact loopback `Host`, optional exact
`Origin`, bearer authentication, 64 KiB JSON request and 1 MiB response caps,
plus bounded connections/timeouts. Control/list/health projections have no
dedicated output Zod schemas. Shared semantic query routes validate both request
and request-aware result. All successful routes currently return 200, including
repository creation and scan queue acceptance; there is no 201/202 response.
Backend method/path mismatch is 404.

### Ephemeral viewer API

The HTTP dispatcher/access gate is `scripts/viewer.ts`;
project/catalog/files/follow dispatch is in `scripts/viewer-api.ts`;
session/symbol/neighbor/evidence projection is in
`scripts/viewer-projection.ts`. The viewer operates on a dataset loaded in
memory; there is no database operation per API request. A persistent viewer
first loads its session from PostgreSQL through `PersistentViewerManager`.

| Method + path              | Handler and input → output contract                                                                                                                | DB / side effect                                                       | Tests and documentation                                                       | Audit                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------ |
| `POST /api/projects`       | Exact `{}` → dataset projection; no response Zod schema.                                                                                           | In-memory dataset read.                                                | `repository-viewer`; inventory.                                               | Implemented, documented. |
| `POST /api/catalog`        | Strict `{query?,offset?}`; query max 256, pre-cap offset 640,000 → catalog page; no response Zod schema.                                           | In-memory deterministic catalog search.                                | `repository-viewer`; inventory.                                               | Implemented, documented. |
| `POST /api/files`          | Strict `{offset?}`; offset 0–2,000 → 50-row inventory page; no response Zod schema.                                                                | In-memory inventory read.                                              | `repository-viewer`; inventory.                                               | Implemented, documented. |
| `POST /api/follow-context` | Strict snapshot/symbol IDs; repository mode wraps `{projectId,request}`; no response Zod schema.                                                   | In-memory ownership lookup and destination evidence/hash check.        | `repository-viewer` verifies context swaps and destination choice; inventory. | Implemented, documented. |
| `POST /api/session`        | Exact `{}`; repository wrapper where applicable; `sessionResponseSchema`.                                                                          | In-memory immutable snapshot projection.                               | `viewer.test`, browser and `repository-viewer`; inventory.                    | Implemented, documented. |
| `POST /api/symbols`        | Local symbol request/response schemas; query max 256, 50 rows; effective offset max 2,000 for selected snapshot and 20,000 for repository profile. | In-memory stable path/position/key search.                             | `viewer.test`, browser and `repository-viewer`; inventory.                    | Implemented, documented. |
| `POST /api/neighbors`      | Shared `graphNeighborsRequestSchema` → viewer graph response schema, validated against request; repository wrapper where applicable.               | In-memory bounded trace; depth 2, 50 graph nodes and 50 unknown rows.  | `viewer.test`, browser, `repository-viewer`, query-result tests; inventory.   | Implemented, documented. |
| `POST /api/evidence`       | Shared evidence request/response schemas; 1–100 unique IDs and bounded excerpts.                                                                   | In-memory verified retained source evidence; response capped at 1 MiB. | `viewer.test`, browser and query-result tests; inventory.                     | Implemented, documented. |

Dynamic viewer APIs require exact loopback Host and peer, same-origin Origin and
the random 32-byte session token. Requests are capped at 64 KiB; responses at 1
MiB. Malformed JSON/media, wrong method and unknown route behavior differs from
backend: viewer uses 400 `INVALID_REQUEST`, 415 `UNSUPPORTED_MEDIA_TYPE`, 405
for an API method mismatch, and 404 for an unknown API path. Exact error parity
is not claimed.

### Static viewer routes

All assets are loaded into memory at viewer startup by `scripts/viewer.ts`; each
GET requires exact loopback Host/peer, but no Origin or API token. They have no
DB effects.

| Method + path                      | Handler/output                                   | Tests and documentation                     |
| ---------------------------------- | ------------------------------------------------ | ------------------------------------------- |
| `GET /`                            | In-memory `viewer.html`, `text/html`.            | `viewer.test`, `viewer-browser`; inventory. |
| `GET /viewer.js`                   | Browser entry, `text/javascript`.                | `viewer-browser`; inventory.                |
| `GET /viewer.css`                  | Stylesheet, `text/css`.                          | `viewer-browser`; inventory.                |
| `GET /viewer-client/dom.js`        | DOM projection module, `text/javascript`.        | `viewer-browser`; inventory.                |
| `GET /viewer-client/projection.js` | Semantic projection module, `text/javascript`.   | `viewer-browser`; inventory.                |
| `GET /viewer-client/history.js`    | History module, `text/javascript`.               | `viewer-browser`; inventory.                |
| `GET /viewer-client/repository.js` | Repository navigation module, `text/javascript`. | `viewer-browser`; inventory.                |

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

| Severity         | Confirmed finding and root cause                                                                                                                                                                                                                                                                       | Fix/evidence                                                                                                                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2 documentation | The prior inventory documented only four of eight dynamic viewer APIs: `/api/projects`, `/api/catalog`, `/api/files` and `/api/follow-context` were missing. It also omitted the seven static asset routes. The implementation had grown beyond the older abbreviated route list.                      | Added the missing four route rows and a separate seven-asset table. The AST route-coverage test requires every current route in both inventory/setup docs.                                                                                              |
| P2 documentation | The inventory attributed all viewer route schemas to `scripts/viewer.ts`; actual route shapes/dispatch are split between `viewer-api.ts` and `viewer-projection.ts`. The existing symbol offset description also treated 2,000 as the universal limit, although repository-profile mode allows 20,000. | Corrected ownership and effective offset bounds; source is `viewer-api.ts` and `viewer-projection.ts`.                                                                                                                                                  |
| P2 documentation | Backend inventory combined repository collection and item routes; omitted the absence of output Zod schemas on control/list endpoints and did not state current success statuses. It referenced nonexistent requirement `CT-BE-DB-RELEASE-001`.                                                        | Split collection/item rows; documented schema boundary and HTTP 200/503 behavior; removed the stale ID and states that no dedicated backend-release requirement exists.                                                                                 |
| Testability      | Backend route checks were not all expressed in a form the AST inventory check could enumerate.                                                                                                                                                                                                         | Converted equivalent method/path conditions in `scripts/backend/http.ts` to the existing `is(method,...path)` matcher. Branch behavior is unchanged; route detection can now enumerate literal route patterns. Added `tests/api-documentation.test.ts`. |
| Runtime          | No reproducible API runtime defect was confirmed in the inspected scope.                                                                                                                                                                                                                               | No runtime API behavior or DB schema was changed. The PostgreSQL/browser suite is evidence for tested behavior, not proof of every request permutation.                                                                                                 |

`tests/backend-queue-limit.test.ts` now also verifies the HTTP repository
collection route returns both registered repository IDs and rejects an
unauthenticated request. That closes a previously untested positive route in the
existing real-PostgreSQL suite.

## Test integrity and verification evidence

Environment: Windows, pinned Node 24.22.2 / pnpm 12.16.1, disposable
PostgreSQL 17. No production database or credentials were used. A first parallel
PostgreSQL-suite invocation with two workers failed because independent files
contend on the shared worker advisory lock; rerunning with `--maxWorkers=1`,
matching hosted CI isolation, passed. A disposable restart DB was recreated with
a fixed loopback port after Docker changed its host port on restart; the restart
test then passed.

| Command / suite                                                      | Observed result                                                                                                               | Evidence boundary                                                                                                                                              |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check` (without DB URL)                                        | Exit 0; 45 files passed, 17 skipped; 498 tests passed, 55 skipped.                                                            | PostgreSQL-dependent tests skipped in this invocation.                                                                                                         |
| `pnpm eval:semantic`                                                 | Exit 0; gate passed; 13 exact matches, zero incorrect exact, zero missed exact; corpus labels are not independently reviewed. | Authored semantic corpus only; not independent ground truth.                                                                                                   |
| `pnpm eval:external`                                                 | Exit 0; pinned repository gates passed.                                                                                       | Some contexts/labels are incomplete or not independently reviewed; no human study claim.                                                                       |
| `pnpm test:browser`                                                  | Exit 0; 6/6 browser tasks completed.                                                                                          | Scripted browser tasks, not a human usability study.                                                                                                           |
| `pnpm security:check`                                                | Exit 0; no known vulnerabilities reported by the advisory service.                                                            | Advisory service result at execution time.                                                                                                                     |
| Real PostgreSQL backend integration suite, serial (`--maxWorkers=1`) | 15 files passed, 1 skipped; 47 tests passed, 5 skipped.                                                                       | One POSIX-only shutdown test is skipped on Windows; includes HTTP, persistence, worker/readiness, query, migration/provenance and persistent-browser coverage. |
| Dedicated PostgreSQL restart suite                                   | 1 file, 3 tests passed.                                                                                                       | Disposable PostgreSQL 17 container on fixed loopback port.                                                                                                     |
| `backend:migrate`, `backend:roles` twice, backup/restore verifier    | Migrations reached v7; roles applied twice; restore verifier passed with 29 snapshots and 929 files.                          | Fresh disposable DBs; no destructive operation on external data.                                                                                               |
| `tests/api-documentation.test.ts`                                    | 2 tests passed.                                                                                                               | Confirms route presence in docs, not schema/error parity.                                                                                                      |
| `tests/backend-queue-limit.test.ts --maxWorkers=1`                   | 1 test passed after adding repository-list assertions.                                                                        | Real PostgreSQL 17; the disposable database is created and removed by the test.                                                                                |

The values above are the observed local run before the final audit-report
commit; the final candidate SHA must be checked again after the report and all
implementation changes are committed. Hosted CI URLs and the exact final SHA
belong in the PR #36 description and handoff, and must not be inferred from this
earlier run.

## Acceptance matrix

| Acceptance gate                                                                                     | Result                                                                  | Evidence / limitation                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every implemented HTTP and static route is inventoried and linked to code, test and docs locations. | PASS for route enumeration.                                             | 14 backend routes, 8 viewer APIs and 7 static assets are listed; AST test enforces route presence. The per-route handler/schema/DB/test mapping above was manually audited.                                                                                                                                            |
| Contract-only operations are distinguished from implemented and internal operations.                | PASS.                                                                   | Shared operation table distinguishes contract-only test/diagnostic operations and query error schema from implemented query paths.                                                                                                                                                                                     |
| Every route has positive and negative contract tests for actual request/response behavior.          | NOT VERIFIED.                                                           | Existing real-HTTP and browser tests cover positive routes and multiple negative cases, but they are not a complete per-route/per-contract matrix. The new AST gate checks documentation presence only. Control/list routes also lack dedicated response Zod schemas, so full output-schema parity is not established. |
| No confirmed unresolved P0/P1 API defect.                                                           | PASS in reviewed scope.                                                 | No runtime P0/P1 was reproduced; this does not waive the contract-test gate.                                                                                                                                                                                                                                           |
| Real PostgreSQL, restart, worker, persistent-browser and local verification.                        | PASS on the observed implementation candidate; final SHA rerun pending. | Results above. Five platform-specific tests were skipped on Windows as stated.                                                                                                                                                                                                                                         |
| Hosted Ubuntu, Windows and PostgreSQL CI on exact final SHA.                                        | NOT VERIFIED yet.                                                       | Must inspect GitHub checks after pushing the final commit; old PR checks are stale for the audit candidate.                                                                                                                                                                                                            |
| Human review/approval and merge authorization.                                                      | NOT VERIFIED.                                                           | PR #36 remains draft; this task does not authorize merging.                                                                                                                                                                                                                                                            |

## Residual risks and merge recommendation

- The strict 100% positive/negative route contract-test acceptance gate is not
  met or proven. Closing it requires a route-by-route adversarial HTTP matrix
  with schema and error assertions, plus appropriate response validators or
  explicit schema tests for control/list projections.
- The route AST guard only verifies method/path presence. It does not derive
  OpenAPI, validate response payloads, or detect every possible dynamic route
  construction.
- Control/list endpoints return raw application/database projections without
  dedicated Zod response schemas. This is documented, but drift is less
  constrained.
- External evaluation labels are not independently reviewed; no human study or
  production behavior is claimed.
- No stable public API compatibility promise or OpenAPI description exists.

**Decision: BLOCKED / NO-GO for merge.** Documentation defects are corrected and
no runtime P0/P1 was confirmed, but the explicit every-route positive/negative
contract test gate is not satisfied, and final-SHA hosted CI must still be
observed. Keep PR #36 draft and unmerged until these gates are closed and human
review/approval is present.
