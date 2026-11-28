# CodeThread operation and API inventory

This inventory distinguishes shared semantic contracts, TypeScript/CLI
operations, the ephemeral viewer routes and the persistent loopback backend
routes. A schema is not an HTTP endpoint. The persistent backend remains a local
review candidate; there is no dedicated backend-release requirement ID in
`requirements/`.

## Sources of truth and status

- **Domain facts and static semantics:** `@codethread/code-model` public root
  exports.
- **Shared query requests, projections and request-aware result validation:**
  `@codethread/contracts` root exports (`packages/contracts/src/schemas.ts`,
  `results.ts`). Query schemas own reusable shape/bounds; request-aware parsers
  check response facts that need the original request.
- **Extraction:** `@codethread/symbol-indexer`; `analyzeManifest` is in
  `packages/symbol-indexer/src/index.ts`, and semantic extraction is in
  `packages/symbol-indexer/src/extract.ts`. It owns manifest validation, bounded
  compiler work, fact extraction and retained source.
- **Query behavior:** `@codethread/trace-engine`; `createInvestigation` and its
  `neighbors`, `paths` and `sourceEvidence` operations are in
  `packages/trace-engine/src/index.ts`. It owns in-memory graph expansion and
  source evidence retrieval.
- **CLI and ephemeral viewer mapping:** `scripts/investigate.ts`,
  `scripts/viewer.ts`, `scripts/viewer-api.ts` and
  `scripts/viewer-projection.ts`. Viewer-local shapes are transport/presentation
  contracts and do not replace shared semantic contracts.
- **Persistent local API mapping:** `scripts/backend/http.ts` is transport;
  `scripts/backend/http-contracts.ts` projects and validates public response
  DTOs; `scripts/backend/query-service.ts` validates snapshot scope and
  delegates to persistence/trace-engine; `docs/backend.md` is the route/setup
  source.
- **Requirements:** stable IDs and acceptance live in `requirements/*.yaml`.
  Their `accepted` lifecycle means agreed requirement, not shipped or verified
  implementation.
- **This inventory:** `tests/api-documentation.test.ts` compares implemented
  route paths with documentation, runtime response-schema maps and executable
  positive/negative route-case matrices. PostgreSQL route cases run in the
  dedicated PostgreSQL 17 CI job; viewer asset tests compare exact bytes and
  access policy. This gate does not replace independent semantic review of
  stored evidence or establish production readiness.

The local packages are private `0.0.0` workspace packages with explicit root
exports; no released external API compatibility policy exists. Until
release/versioning is authorized, repository-local changes update consumers,
schemas, fixtures and docs together.

## Shared semantic query contracts

Every query is snapshot-scoped. Shared successful query projections include
`snapshotId`, `evidenceBasis: static`, aggregate and per-capability coverage,
applied limits and truncation metadata. Uncertainty and truncation are separate.
These contracts describe intended query behavior even where no executor exists.
For every operation in this table, request/response schemas are owned by
`@codethread/contracts` in `packages/contracts/src/schemas.ts`, and
request-aware result parsers are in `packages/contracts/src/results.ts`. The
operation row names the executor and exposure when one exists; contract-only
rows have no query executor or route.

| Operation ID                  | Purpose and requirement                                                                                         | Exposure and implementation                                                                                                                                        | Request → response                                                                                                                        | Validation and scope                                                                                                                                                                                                                        | Bounds, paging, errors and tests                                                                                                                                                                                                                                                                                          |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listTests`                   | Enumerate optional extracted tests. `CT-DB-012`, `CT-TRACE-001`                                                 | **Contract only**; no test indexer, query implementation or HTTP route.                                                                                            | `listTestsRequestSchema` → `listTestsResponseSchema`; exported `ListTestsRequest` / `ListTestsResponse`.                                  | Shared schema and `parseListTestsResult`; response rows are scoped to request snapshot and test filters.                                                                                                                                    | Page default 50, max 200; snapshot/filter/order-bound cursor. Planned typed `queryErrorSchema`; `tests/contracts.test.ts`, `tests/query-results.test.ts`. No runtime result is produced today.                                                                                                                            |
| `getTestTrace`                | Return one bounded semantic test projection. `CT-DB-008`, `CT-DB-012`, `CT-TRACE-001`                           | **Contract only**; no test extractor/query handler or HTTP route.                                                                                                  | `getTestTraceRequestSchema` → `getTestTraceResponseSchema`; exported request type is `GetTestTraceRequest`, response type is `TestTrace`. | `parseGetTestTraceResult` needs the original test/snapshot selection. Static assertions and syntax-ordered steps do not imply a test passed or ran in that order.                                                                           | Request defaults: 500 steps, 200 symbols, 1,000 relations; response supports bounded evidence/diagnostics and explicit truncation. Typed shared errors are only schema. Contract/result tests above.                                                                                                                      |
| `getRelatedProductionSymbols` | Find exact production symbols linked from a test. `CT-DB-012`, `CT-TRACE-001`                                   | **Contract only**; no handler or HTTP route.                                                                                                                       | `relatedProductionSymbolsRequestSchema` → `relatedProductionSymbolsResponseSchema`; exported request/response types.                      | `parseRelatedProductionSymbolsResult` validates selected test, supporting steps/evidence and source ownership. Exact links only.                                                                                                            | Page default 50, max 200; cursor bound to selected test and snapshot; occurrence support bounded. Typed shared errors are only schema. `tests/query-results.test.ts`.                                                                                                                                                     |
| `findTestsForSymbol`          | Reverse lookup optional tests for a production symbol. `CT-DB-012`, `CT-TRACE-001`                              | **Contract only**; no test extractor/query handler or HTTP route.                                                                                                  | `findTestsForSymbolRequestSchema` → `findTestsForSymbolResponseSchema`; exported request/response types.                                  | `parseFindTestsForSymbolResult` validates selected symbol, snapshot, owning test/step and evidence context.                                                                                                                                 | Page default 50, max 200; cursor bound to symbol/snapshot; preserves distinct occurrences. Typed shared errors are only schema. `tests/query-results.test.ts`.                                                                                                                                                            |
| `getSourceEvidence`           | Retrieve exact source evidence by ID. `CT-DB-007`, `CT-DB-011`, `CT-DB-012`                                     | Implemented in-memory by `createInvestigation().sourceEvidence`; exposed by CLI, ephemeral viewer and persistent backend.                                          | `getSourceEvidenceRequestSchema` → `getSourceEvidenceResponseSchema`; exported request/response types.                                    | Request and result parsed by shared contracts; the persistent adapter verifies snapshot/evidence/file/hash/range/text against retained source objects. Callers do not supply a path as identity.                                            | 1–100 unique IDs in request order; excerpts capped at 65,536 UTF-16 units. Missing/too-large/unavailable content is a typed per-item result. Backend uses a sanitized HTTP error envelope. Tests: `tests/query-results.test.ts`, `tests/semantic-trace.test.ts`, `tests/backend-integration.test.ts`.                     |
| `listSymbols`                 | Search declarations in a persisted project. `CT-DB-012`                                                         | Implemented by the persistent backend; the ephemeral viewer retains its separate presentation-local search.                                                        | `listSymbolsRequestSchema` → `listSymbolsResponseSchema`; request is internally scoped to the selected scan/project snapshot.             | `parseListSymbolsResult` checks snapshot, filter correspondence, deterministic ordering, requested/applied page size, `nextOffset` and truncation metadata. The backend reads immutable `symbol_json` projections.                          | Case-insensitive literal query up to 256 characters; 50 rows/page; offset at most 20,000. Exact results must remain snapshot-scoped. Tests: `tests/query-results.test.ts`, `tests/backend-integration.test.ts`.                                                                                                           |
| `getDiagnostics`              | Filter and page snapshot diagnostics. `CT-DB-012`                                                               | **Contract only** as a standalone query; diagnostics are also attached to semantic facts and bounded graph projections. No standalone engine method or HTTP route. | `getDiagnosticsRequestSchema` → `getDiagnosticsResponseSchema`; exported request/response types.                                          | `parseGetDiagnosticsResult` checks request, snapshot, ordering and continuation.                                                                                                                                                            | Page default 50, max 200; optional severity/code/file filters; source-free diagnostics have explicit empty-path/zero-offset sort position. Typed shared errors are schema only. `tests/query-results.test.ts`.                                                                                                            |
| `graphNeighbors`              | Explore bounded incoming/outgoing/bidirectional neighbors of a symbol. `CT-DB-012`, `CT-INV-001`, `CT-VIEW-001` | Implemented by `createInvestigation().neighbors`; exposed by CLI, ephemeral viewer and persistent backend.                                                         | `graphNeighborsRequestSchema` → `graphNeighborsResponseSchema`; exported request/response types.                                          | Request and response parsed by trace engine; both HTTP adapters validate the returned projection. Every returned edge must satisfy requested kinds/direction and root reachability. Persistent routes are scoped to completed scan/project. | Defaults: outgoing, `calls`, depth 2, 200 nodes; maximum depth 5/nodes 200; up to 1,000 relations, 5,000 evidence refs, 200 diagnostics, 10,000 examined relations. Explicit truncation. Backend loads and verifies persisted snapshot facts/source. Tests: query-result, semantic-trace, viewer and backend integration. |
| `findSymbolPaths`             | Find bounded directed simple paths between selected symbols. `CT-DB-012`                                        | Implemented by `createInvestigation().paths`; exposed by the persistent backend, not by the CLI or ephemeral viewer.                                               | `findSymbolPathsRequestSchema` → `findSymbolPathsResponseSchema`; exported request/response types.                                        | Trace engine validates request and request-aware path projection. Only exact outgoing selected-kind relations form a path; persistent route scopes queries to the selected project snapshot.                                                | Defaults: `calls`, depth 2, 200 nodes, 20 paths; max depth 5 and 10,000 examined relations. Backend loads/validates snapshot before querying. Tests: `tests/query-results.test.ts`, `tests/semantic-trace.test.ts`, `tests/backend-integration.test.ts`.                                                                  |

`queryErrorSchema` is a flat `{code,message}` schema for future shared query
failures: `INVALID_REQUEST`, `INVALID_CURSOR`, `SNAPSHOT_NOT_FOUND`,
`SNAPSHOT_NOT_PUBLISHED`, `ENTITY_NOT_FOUND`, `SOURCE_UNAVAILABLE`,
`HASH_MISMATCH`, `RESOURCE_LIMIT`, `QUERY_TIMEOUT`. It is not currently wired to
a persistent service.

## Public TypeScript, CLI and in-memory application operations

| Operation                                                                                                       | Owner and exposure                                                                                                | Inputs/outputs and validation                                                                                                                                                                           | Security, bounds and verification                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `analyzeManifest(input)`                                                                                        | `@codethread/symbol-indexer`; public TypeScript function, called by the CLI.                                      | Caller-supplied immutable `AnalysisInput` → async immutable `AnalysisSnapshot`; validates UUID, POSIX paths, copied bytes, SHA-256, UTF-8, compiler options and extracted facts.                        | Restricted compiler worker and pinned TypeScript libraries; 20 files, 256 KiB/file, 2 MiB total, 2,000 declarations, 5,000 call sites; process deadline/heap boundary. No repository scripts or dependencies run. Tests include `tests/semantic-manifest.test.ts`, `tests/semantic-extraction.test.ts`, `tests/semantic-trace.test.ts`. |
| `createInvestigation(facts, sourceReader)`                                                                      | `@codethread/trace-engine`; public TypeScript in-memory application operation.                                    | Validated facts plus verified source reader → `neighbors`, `paths`, `sourceEvidence`.                                                                                                                   | Clones and validates facts at construction; no TypeScript compiler, database or filesystem access. Uses shared parsers and explicit traversal/evidence limits. No server is started.                                                                                                                                                    |
| `acquireGitSources(request)`                                                                                    | `scripts/git-source.ts`; internal application module used by `pnpm investigate`.                                  | Repository path, caller-supplied repository UUID, pinned revision selector and explicit file paths → `AnalysisInput` plus Git commit/blob provenance.                                                   | Native trusted Git executable, object-ID reads, no shell, no working-tree fallback, all-or-error admission. This module owns acquisition only; it does not extract or traverse. Tests: `tests/investigate-cli.test.ts`, `tests/git-source-process.test.ts`.                                                                             |
| `pnpm investigate`                                                                                              | CLI (`scripts/investigate.ts`).                                                                                   | Accepts a JSON manifest, explicit `--repo/--repository-id/--revision/--file` selection or pinned demo. Runs acquisition if requested, `analyzeManifest`, then an in-memory textual session or `--view`. | Bounded source/session/output; typed nonzero errors; terminal text is escaped. Textual commands expose file/symbol selection, inspect, follow and evidence. Tests: `tests/investigate-cli.test.ts`.                                                                                                                                     |
| `pnpm study:validate`, `pnpm study:provenance`, `pnpm study:score -- <file>`, `pnpm study:demo`                 | Offline evaluation scripts in `scripts/study.ts`, `study-tasks.ts` and `study-results.ts`; not service endpoints. | Validate pinned tasks; emit collection provenance from a clean committed scorer build; score schema-v3 local results against objective answer components; or run an in-memory synthetic dry run.        | No collection or persistence. Provenance binds task bank, rubric and exact Git commit. Tool failures are excluded from objective denominators. Result input is bounded and strict; aggregates omit participant tokens and answer text. Free-text comprehension remains awaiting human scoring. Tests: `tests/study-toolkit.test.ts`.    |
| `pnpm demo:semantic`, `pnpm demo:investigation`, `pnpm demo:visual`, `pnpm eval:semantic`, `pnpm eval:external` | Repository scripts for demonstration/evaluation, not service endpoints.                                           | Use pinned fixtures/corpora and call existing analyzer/trace functions.                                                                                                                                 | Do not install or execute evaluated repository code. Evaluations are corpus-specific; authored external labels are not independently reviewed.                                                                                                                                                                                          |

The command targets above are `scripts/demo-semantic.ts`;
`scripts/investigate.ts` (`--demo todo`, with optional `--view`);
`scripts/eval-semantic.ts`; `scripts/eval-external-semantic.ts`; and the offline
study commands in `scripts/study.ts`.

There is no repository registration service, scan-job worker, snapshot
persistence adapter, durable content cache, publication/activation service,
database query executor or migration.

## Actual ephemeral viewer HTTP routes

Only `scripts/viewer.ts:createViewer` and `createRepositoryViewer` create this
server. It binds `127.0.0.1` to an ephemeral port, serves one in-memory
snapshot/session, and closes when the CLI stops. These are local proof routes;
they are not an externally released application API.
`scripts/viewer.ts::handleRequest` enforces HTTP access and dispatches requests.
`/api/projects`, `/api/catalog`, `/api/files` and `/api/follow-context` are
implemented in `scripts/viewer-api.ts`; session, symbol, neighbor and evidence
projections are implemented in `scripts/viewer-projection.ts` and reuse
trace-engine/shared contracts where stated.

| Operation ID           | Purpose and requirement                                                                               | Method/path                | Request → response                                                                                                                                                                                   | Bounds and access                                                                                                                                                                      | Tests and limitations                                                                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `viewerProjects`       | List project contexts and analysis status. `CT-VIEW-001`                                              | `POST /api/projects`       | Exact empty object → strict `viewerApiResponseSchemas['/api/projects']` projection `{mode, initialProjectId, repositoryId, commitId, source, items}`.                                                | Dynamic API Host/peer/Origin/token gate; request 64 KiB, response 1 MiB; diagnostics capped at 10 per context.                                                                         | `tests/viewer-api-contract.test.ts`; single-snapshot mode uses project ID `selected`.                                                                                              |
| `viewerCatalog`        | Search declarations across repository contexts. `CT-VIEW-001`                                         | `POST /api/catalog`        | `{query?, offset?}` (`query` max 256; offset max 640,000) → strict catalog page response with validated continuation.                                                                                | 50 rows/page; stable UTF-8 path/position/project/key order; case-insensitive name/path matching.                                                                                       | `tests/viewer-api-contract.test.ts`; separate from snapshot-scoped semantic symbol search.                                                                                         |
| `viewerFiles`          | Page source inventory and per-file status. `CT-VIEW-001`                                              | `POST /api/files`          | `{offset?}` (default 0, max 2,000) → strict file page response; regular repository source blobs may include Git `blobId`.                                                                            | 50 rows/page; stable UTF-8 path order; analyzed, not-analyzed and excluded TypeScript entries.                                                                                         | `tests/viewer-api-contract.test.ts`; excluded entries have null hash/length and no blob ID.                                                                                        |
| `viewerFollowContext`  | Follow a declaration to verified project context(s). `CT-VIEW-001`                                    | `POST /api/follow-context` | Selected: `{snapshotId, symbolId}`; repository: `{projectId, request:{snapshotId, symbolId}}` → strict `{projectId, snapshotId, symbolId, requiresChoice, candidates}` response.                     | Validates context/snapshot ownership and compares destination declaration evidence and content hash; candidates are non-empty and `requiresChoice` matches whether there are multiple. | `tests/viewer-api-contract.test.ts`; multiple exact destinations require explicit choice; missing entities map 404 and unavailable source maps 400.                                |
| `viewerSession`        | Return snapshot identity, counts and coverage. `CT-VIEW-001`                                          | `POST /api/session`        | Selected: exact `{}`; repository: `{projectId, request:{}}` → strict session response, wrapped as `{projectId, result}` in repository mode.                                                          | Dynamic API Host/peer/Origin/token gate; response schema enforced before serialization.                                                                                                | `tests/viewer-api-contract.test.ts`, `tests/viewer.test.ts`, browser tests; no shared semantic operation equivalent.                                                               |
| `viewerSearchSymbols`  | Select declarations by case-insensitive name/path substring. `CT-VIEW-001`, `CT-INV-001`              | `POST /api/symbols`        | Local request (`query` max 256; effective offset max 2,000 selected / 20,000 repository) → strict symbol page response, wrapped in repository mode; continuation must match total and returned rows. | 50 rows/page; stable source path/position/key order; dynamic API Host/peer/Origin/token gate.                                                                                          | `tests/viewer-api-contract.test.ts`, `tests/viewer.test.ts`, browser tests; offset paging is presentation-local.                                                                   |
| `viewerGraphNeighbors` | Query bounded neighbors and root-owned unknown observations. `CT-VIEW-001`, `CT-INV-001`, `CT-DB-012` | `POST /api/neighbors`      | `graphNeighborsRequestSchema` → strict `{graph, unknowns}` response, wrapped as `{projectId, result}` in repository mode.                                                                            | Reuses trace-engine neighbors; depth 2, graph nodes 50 and unknown rows 50; only `calls`/`references`; validates against request.                                                      | Zod failures 400; `RESOURCE_LIMIT` 413; missing snapshot/entity 404; other trace errors 400; sanitized failures 500. `tests/viewer-api-contract.test.ts` and existing query tests. |
| `viewerSourceEvidence` | Retrieve evidence selected from a current projection. `CT-VIEW-001`, `CT-DB-007`, `CT-DB-012`         | `POST /api/evidence`       | `getSourceEvidenceRequestSchema` → strict `getSourceEvidenceResponseSchema`, wrapped in repository mode.                                                                                             | 1–100 unique IDs; excerpts max 65,536 UTF-16 units; exact retained evidence; response max 1 MiB.                                                                                       | Missing/unavailable evidence is a typed per-item result; malformed input 400, oversized result 413. `tests/viewer-api-contract.test.ts` and existing evidence tests.               |

For `POST /api/files`, source provenance is status-sensitive: excluded rows have
null SHA-256 and byte length and omit the Git blob ID; analyzed and not-analyzed
rows retain a verified SHA-256 and byte length.

### Static viewer assets

The same loopback server serves these in-memory build assets. Each route is
`GET`; it requires the exact `Host` and loopback peer address but no API token
or `Origin` header. These routes do not read or publish analysis data.

| Method/path                        | Handler and response                                        | Verification                                      |
| ---------------------------------- | ----------------------------------------------------------- | ------------------------------------------------- |
| `GET /`                            | `scripts/viewer.ts` serves `viewer.html` as `text/html`.    | `tests/viewer.test.ts`; `tests/viewer-browser.ts` |
| `GET /viewer.js`                   | Serves the browser entry bundle as `text/javascript`.       | `tests/viewer-browser.ts`                         |
| `GET /viewer.css`                  | Serves the viewer stylesheet as `text/css`.                 | `tests/viewer-browser.ts`                         |
| `GET /viewer-client/dom.js`        | Serves the DOM projection module as `text/javascript`.      | `tests/viewer-browser.ts`                         |
| `GET /viewer-client/projection.js` | Serves the semantic projection module as `text/javascript`. | `tests/viewer-browser.ts`                         |
| `GET /viewer-client/history.js`    | Serves browser history handling as `text/javascript`.       | `tests/viewer-browser.ts`                         |
| `GET /viewer-client/repository.js` | Serves repository navigation as `text/javascript`.          | `tests/viewer-browser.ts`                         |
| `GET /viewer-client/evidence.js`   | Serves verified evidence rendering as `text/javascript`.    | `tests/viewer-browser.ts`                         |
| `GET /viewer-client/workspace.js`  | Serves workspace control bindings as `text/javascript`.     | `tests/viewer-browser.ts`                         |

`tests/viewer-api-contract.test.ts` also fetches every static asset without API
credentials, compares exact bytes and content type with the bundled file, and
verifies that a non-loopback `Host` is rejected for every asset.

## Persistent local backend API candidate

The separate backend binds to `127.0.0.1:8765`, requires a bearer token and
checks exact Host/Origin. Its request and response bounds are independent of the
ephemeral viewer above. Detailed setup and route behavior live in
[`docs/backend.md`](../backend.md).

| Method and route                                   | Request/response behavior                                                                                                                                                                                                    |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/health`                                   | No body; returns `{api,database,worker,ready}` and HTTP 503 when database or worker is unavailable.                                                                                                                          |
| `POST /v1/repositories`                            | `registerRepository` (`locator`, max 4,096); returns repository ID and canonical allowed locator.                                                                                                                            |
| `GET /v1/repositories`                             | Lists up to 50 repository state rows.                                                                                                                                                                                        |
| `GET /v1/repositories/:id`                         | Returns one repository state row; missing ID is 404.                                                                                                                                                                         |
| `GET /v1/repositories/:id/scans`                   | Lists up to 25 recent scan jobs for one repository in newest-first order; missing repository ID is 404.                                                                                                                      |
| `POST /v1/repositories/:id/scans`                  | `requestScan` (`revision` max 1,024; `idempotencyKey` max 128); idempotent queue acceptance; global 32-job admission returns 429 `SCAN_QUEUE_FULL`.                                                                          |
| `GET /v1/scans/:id`                                | Returns scan state, attempt, pinned commit/tree, activation result and terminal error fields; missing ID is 404.                                                                                                             |
| `POST /v1/scans/:id/cancel`                        | Requires an empty body; queued/running jobs become cancelled; missing or terminal jobs return 409.                                                                                                                           |
| `POST /v1/scans/:id/viewer`                        | Requires an empty body; opens a succeeded, pinned scan with a separate short-lived token; missing scan is 404, non-ready scan is 409 `VIEWER_NOT_READY`, full capacity is 429 `VIEWER_CAPACITY`, and missing adapter is 503. |
| `GET /v1/scans/:id/projects`                       | Lists up to 32 project readiness rows, diagnostics and snapshot IDs.                                                                                                                                                         |
| `GET /v1/scans/:id/files?offset=0`                 | 50-row page of pinned input provenance; integer offset 0–1,256; UTF-8 byte order.                                                                                                                                            |
| `GET /v1/scans/:id/projects/:projectId/symbols`    | `listSymbolsRequestSchema`/`listSymbolsResponseSchema` and `parseListSymbolsResult`; query max 256; 50 rows; offset 0–20,000.                                                                                                |
| `POST /v1/scans/:id/projects/:projectId/neighbors` | `graphNeighborsRequestSchema` → request-aware shared graph result, scoped to the completed project snapshot.                                                                                                                 |
| `POST /v1/scans/:id/projects/:projectId/paths`     | `findSymbolPathsRequestSchema` → request-aware shared path result, scoped to the completed project snapshot.                                                                                                                 |
| `POST /v1/scans/:id/projects/:projectId/evidence`  | `getSourceEvidenceRequestSchema` → request-aware shared evidence result; retained source hashes and ranges are verified.                                                                                                     |

All 15 backend success routes are projected and validated by the route-keyed
schemas in `scripts/backend/http-contracts.ts`. Repository and scan rows become
explicit JSON DTOs with decimal generation strings and ISO timestamps. Viewer
responses are validated beside the viewer API mapping before serialization. The
route census, response-schema maps, and positive/negative route matrices must
match in CI.

Successful persistent-backend routes currently return HTTP 200, including
repository registration and scan queue acceptance; the adapter does not use 201
or 202. `GET /v1/health` also returns 200 when ready and 503 when unavailable.

This candidate does not expose the contract-only test/diagnostic operations or
provide a general persistent frontend. The graph and evidence endpoints
currently hydrate the complete verified snapshot. Symbol search scans bounded
immutable names and paths for non-empty queries and reads the matching page.
Symbol, neighbor, path and evidence queries share a limit of four active
requests per API instance; excess requests receive HTTP 429
`QUERY_CAPACITY_EXCEEDED`. Local implementation is not production approval.

Viewer access checks in `scripts/viewer.ts:createViewer/handleRequest` require
the exact loopback Host and remote address; API calls also require exact
same-origin Origin and a random 32-byte session token supplied in a header. It
sends no CORS allowance and applies CSP, `no-store`, `nosniff`, no-referrer and
same-origin resource policy. Request/headers/keep-alive timeouts are 5 seconds
and `maxConnections` is 20. The token is a local-session barrier, not user
identity or authorization for a multi-user service. There is no rate-limit or
durable-session layer. The browser loads no external resources and renders
source as text. All viewer API inputs use JSON bodies; URL query parameters are
rejected.

The seven static viewer assets listed above are bundled local files and are not
semantic query operations. No GET route creates analysis, and neither HTTP
surface exposes the contract-only test/diagnostics operations. `findSymbolPaths`
is implemented by the persistent backend but not the ephemeral viewer. The
viewer's unknown-observation list carries `total` plus up to 50 items but no
separate truncation-reason field; `total > items.length` signals omission. Graph
`meta.truncated` describes the graph projection, not this presentation-only
list.

### Error and compatibility boundary

Shared query errors are flat and have a 1,024-character message bound. Both HTTP
surfaces use JSON error envelopes `{error:{code,message}}` for request failures;
`GET /v1/health` is the exception and returns its readiness object with
status 503. The viewer caps error messages at 256 characters. It maps Zod
failures to 400, access failures to 403, unknown routes/entities/snapshots to
404, method mismatch to 405, request/resource/response bounds to 413,
unsupported media to 415 and sanitized unknown failures to 500. The backend maps
malformed input to 400, missing/invalid bearer to 401, Host/Origin rejection to
403, missing routes or entities to 404, state/idempotency conflicts to 409,
request/response bounds to 413, unsupported media to 415, queue/query/viewer
capacity to 429, internal errors to sanitized 500, and unavailable health,
unavailable viewer adapter or analyzer mismatch to 503. Unexpected or repeated
backend query parameters and viewer URL query parameters return 400
`INVALID_REQUEST`; backend offsets must be unsigned base-10 integers. Backend
method/path mismatches currently fall through to 404. A valid evidence lookup
may return typed per-item unavailability with HTTP 200. Error codes also differ
by adapter: viewer malformed JSON/media use `INVALID_REQUEST` /
`UNSUPPORTED_MEDIA_TYPE`, while backend uses `INVALID_JSON` /
`INVALID_MEDIA_TYPE`; viewer access failures are 403, while missing backend
bearer auth is 401. These local adapter semantics do not establish shared HTTP
error parity.

No OpenAPI document exists. The ephemeral viewer has eight tokenized POST API
routes and seven loopback-only static GET assets; the separate persistent
backend candidate has the routes listed above. Neither is an external stable
API. A machine-readable document would add a second hand-maintained
representation; current CI checks implemented route/documentation parity,
response-schema maps and positive/negative test-matrix coverage. It does not
establish complete shared error parity between the two local adapters. If
adopted, derive or validate route/request/response/error metadata against
runtime Zod contracts, describe only implemented routes, and test the
generated/validated description in CI. Do not invent scan, repository or
persistence endpoints.

## Change governance

For any future operation or route, update together: stable operation ID and
requirement, contract owner, runtime owner/function, transport method/path if
any, compatibility impact, bounds/error semantics, focused positive and negative
tests, and this inventory. Use these delivery states without conflating them
with requirement lifecycle:

`Planned → Contracted → Implemented → Verified → Released`

Internal verification does not mean externally released. Route/schema/test
matrix parity does not establish production approval or independent semantic
review.

## References

- [OpenAPI Specification 3.1.2](https://spec.openapis.org/oas/v3.1.2.html)
- [OWASP API1:2023 Broken Object Level Authorization](https://api-security.owasp.org/editions/2023/en/0xa1-broken-object-level-authorization/)
- [OWASP API4:2023 Unrestricted Resource Consumption](https://api-security.owasp.org/editions/2023/en/0xa4-unrestricted-resource-consumption/)
- [RFC 9110: HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110.html)
- [Node.js `child_process` API](https://nodejs.org/api/child_process.html)
