# CodeThread operation and API inventory

The shared-contract and ephemeral-viewer inventory was reviewed against
`origin/main` on 2026-11-03 and revalidated on 2026-11-04 for CT-ARCH-001. This
update adds the separate local persistent backend API candidate, implemented
under CT-BE-DB-RELEASE-001 on 2026-11-13. It distinguishes semantic contracts,
TypeScript/CLI operations, the ephemeral viewer routes and the persistent
loopback backend routes. A schema is not an HTTP endpoint.

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
- **CLI and ephemeral viewer mapping:** `scripts/investigate.ts` and
  `scripts/viewer.ts`. Viewer-local shapes are transport/presentation contracts
  and do not replace shared semantic contracts.
- **Persistent local API mapping:** `scripts/backend/http.ts` is transport;
  `scripts/backend/query-service.ts` validates snapshot scope and delegates to
  persistence/trace-engine; `docs/backend.md` is the route/setup source.
- **Requirements:** stable IDs and acceptance live in `requirements/*.yaml`.
  Their `accepted` lifecycle means agreed requirement, not shipped or verified
  implementation.
- **This inventory:** manually maintained documentation. CI does not currently
  check route/schema parity or inventory completeness.

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
| `listSymbols`                 | Search declarations in a persisted project. `CT-DB-012`, `CT-BE-DB-RELEASE-001`                                 | Implemented by the persistent backend; the ephemeral viewer retains its separate presentation-local search.                                                        | `listSymbolsRequestSchema` → `listSymbolsResponseSchema`; request is internally scoped to the selected scan/project snapshot.             | `parseListSymbolsResult` checks snapshot, filter correspondence, deterministic ordering, requested/applied page size, `nextOffset` and truncation metadata. The backend reads immutable `symbol_json` projections.                          | Case-insensitive literal query up to 256 characters; 50 rows/page; offset at most 20,000. Exact results must remain snapshot-scoped. Tests: `tests/query-results.test.ts`, `tests/backend-integration.test.ts`.                                                                                                           |
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

Only `scripts/viewer.ts:createViewer` creates a server. It binds `127.0.0.1` to
an ephemeral port, serves one in-memory snapshot, and closes when the CLI stops.
These are local proof routes; they are not an externally released application
API. Every route row is handled by `scripts/viewer.ts::handleRequest`, and its
transport schemas are declared in `scripts/viewer.ts`; graph/evidence rows hand
off to the trace-engine operations identified above.

| Operation ID           | Purpose and requirement                                                                                                         | Method/path           | Request → response schema                                                                                                                                                                             | Validation, access control and limits                                                                                                                                                                                                                                                           | Errors, tests and limitations                                                                                                                                                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `viewerSession`        | Return current snapshot identity, counts and coverage. `CT-VIEW-001`                                                            | `POST /api/session`   | Exact empty JSON object → local `sessionResponseSchema`.                                                                                                                                              | Shared local host/Origin/token gate; request JSON limit 64 KiB; schema revalidates session result.                                                                                                                                                                                              | Viewer `{error:{code,message}}`; HTTP 400/403/413/500 as applicable. `tests/viewer.test.ts`, `tests/viewer-browser.ts`. No shared semantic operation equivalent.                                                                                                                                                      |
| `viewerSearchSymbols`  | Select declarations by case-insensitive name/path substring. `CT-VIEW-001`, `CT-INV-001`                                        | `POST /api/symbols`   | Local `symbolSearchRequestSchema` (`query` default `""`, max 256 chars; `offset` default 0, max 2000) → local `symbolSearchResponseSchema` (snapshot, total, offset, `nextOffset`, up to 50 symbols). | Shared local host/Origin/token gate; stable source path/position/key ordering; 50 rows/page.                                                                                                                                                                                                    | Viewer error envelope. Offset-based pagination is intentionally presentation-local and does not substitute for a shared cursor contract. Tests: `tests/viewer.test.ts`, `tests/viewer-browser.ts`.                                                                                                                    |
| `viewerGraphNeighbors` | Query and display bounded selected-kind neighbors and root-owned unknown observations. `CT-VIEW-001`, `CT-INV-001`, `CT-DB-012` | `POST /api/neighbors` | Shared `graphNeighborsRequestSchema` → `{graph: graphNeighborsResponseSchema, unknowns: ...}` via local `viewerGraphResponseSchema`.                                                                  | Shared local host/Origin/token gate; reuses `createInvestigation().neighbors`, not duplicate traversal. Visual profile caps depth 2, nodes 50, unknown rows 50; relation kinds are explicitly restricted to supported `calls`/`references`. Returned projection is checked against the request. | Invalid Zod input maps to 400 `INVALID_REQUEST`; trace `RESOURCE_LIMIT` maps 413; missing snapshot/entity maps 404; other trace failures map 400; unexpected failures map sanitized 500. The engine result is parsed again at transport boundary as defense. Tests: viewer unit/browser tests and query-result tests. |
| `viewerSourceEvidence` | Retrieve evidence selected from a current projection. `CT-VIEW-001`, `CT-DB-007`, `CT-DB-012`                                   | `POST /api/evidence`  | Shared `getSourceEvidenceRequestSchema` → shared `getSourceEvidenceResponseSchema`.                                                                                                                   | Shared local host/Origin/token gate; trace engine reads exact retained evidence; request IDs are unique and bounded 1–100, excerpts max 65,536 UTF-16 units; full response capped at 1 MiB.                                                                                                     | Available/missing/unavailable evidence is represented by the shared per-item result; malformed input maps 400, oversize result 413, internal error sanitized as 500. Tests: `tests/viewer.test.ts`, `tests/viewer-browser.ts`.                                                                                        |

## Persistent local backend API candidate

The separate backend binds to `127.0.0.1:8765`, requires a bearer token and
checks exact Host/Origin. Its request and response bounds are independent of the
ephemeral viewer above. Detailed setup and route behavior live in
[`docs/backend.md`](../backend.md).

| Method and route                                          | Request/response behavior                                                                                                                                |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/health`                                          | Returns API, database and worker readiness; non-ready state returns 503.                                                                                 |
| `POST /v1/repositories`; `GET /v1/repositories[/:id]`     | Validated local repository registration and listing.                                                                                                     |
| `POST /v1/repositories/:id/scans`; `GET /v1/scans/:id`    | Idempotent scan acceptance and pinned job/provenance state; 429 `SCAN_QUEUE_FULL` at 32 queued/running jobs globally, with no generation advance.        |
| `POST /v1/scans/:id/cancel`; `GET /v1/scans/:id/projects` | Cancellation and project readiness.                                                                                                                      |
| `GET /v1/scans/:id/files?offset=0`                        | Bounded page of committed input provenance.                                                                                                              |
| `GET /v1/scans/:id/projects/:projectId/symbols`           | Snapshot-scoped symbol list; response uses `listSymbolsResponseSchema` and `parseListSymbolsResult`.                                                     |
| `POST /v1/scans/:id/projects/:projectId/neighbors`        | Shared graph-neighbor contract, request/result parsed by the query application service.                                                                  |
| `POST /v1/scans/:id/projects/:projectId/paths`            | Shared symbol-path contract, scoped to the selected completed project.                                                                                   |
| `POST /v1/scans/:id/projects/:projectId/evidence`         | Shared evidence contract; source bytes are hash-verified from PostgreSQL.                                                                                |
| `POST /v1/scans/:id/viewer`                               | Opens the existing viewer from persisted state. It receives a separate short-lived local token; the backend bearer is not exposed to browser JavaScript. |

This candidate does not expose the contract-only test/diagnostic operations or
provide a general persistent frontend. The graph and evidence endpoints
currently hydrate the complete verified snapshot; symbol search reads only its
bounded immutable symbol page. Neighbor, path and evidence queries share a limit
of four active requests per API instance; excess requests receive HTTP 429
`QUERY_CAPACITY_EXCEEDED`. Local implementation is not production approval.

Viewer access checks in `scripts/viewer.ts:createViewer/handleRequest` require
the exact loopback Host and remote address; API calls also require exact
same-origin Origin and a random 32-byte session token supplied in a header. It
sends no CORS allowance and applies CSP, `no-store`, `nosniff`, no-referrer and
same-origin resource policy. Request/headers/keep-alive timeouts are 5 seconds
and `maxConnections` is 20. The token is a local-session barrier, not user
identity or authorization for a multi-user service. There is no rate-limit or
durable-session layer. The browser loads no external resources and renders
source as text.

Static `GET /`, `GET /viewer.js` and `GET /viewer.css` serve bundled assets;
they are not semantic query operations. No `GET` route creates analysis, and the
ephemeral viewer has no route for the contract-only test/diagnostics operations
or `findSymbolPaths`. The persistent backend does expose `findSymbolPaths` but
not test/diagnostic queries. The viewer's additional unknown-observation list
carries `total` plus up to 50 items but no separate truncation-reason field;
`total > items.length` signals omission. Graph `meta.truncated` describes the
graph projection, not this presentation-only list.

### Error and compatibility boundary

Shared query errors are flat and have a 1,024-character message bound. The
viewer deliberately wraps transport errors as `{error:{code,message}}` with a
256-character message bound and HTTP status. The current viewer maps Zod
failures to 400, access failures to 403, unknown route/entity/snapshot to 404,
method mismatch to 405, payload/resource/response bounds to 413, unsupported
media to 415 and sanitized unknown failures to 500. A valid evidence lookup may
return typed per-item unavailability with HTTP 200. This is an intentional local
adapter difference; it is not evidence of shared HTTP error parity.

No OpenAPI document exists. OpenAPI 3.1.2 defines a language-agnostic HTTP
interface description. The ephemeral viewer has four tokenized UI routes; the
separate persistent backend candidate has the routes listed above. Neither is an
external stable API. A machine-readable document would add a second
hand-maintained representation without route/schema parity CI. If adopted,
derive or validate route/request/response/error metadata against the runtime Zod
contracts, describe only implemented routes, and test the generated/validated
description in CI. Do not invent scan, repository or persistence endpoints.

## Change governance

For any future operation or route, update together: stable operation ID and
requirement, contract owner, runtime owner/function, transport method/path if
any, compatibility impact, bounds/error semantics, focused positive and negative
tests, and this inventory. Use these delivery states without conflating them
with requirement lifecycle:

`Planned → Contracted → Implemented → Verified → Released`

Internal verification does not mean externally released. No automatic
contract/runtime parity is claimed until CI enforces it.

## References

- [OpenAPI Specification 3.1.2](https://spec.openapis.org/oas/v3.1.2.html)
- [OWASP API1:2023 Broken Object Level Authorization](https://api-security.owasp.org/editions/2023/en/0xa1-broken-object-level-authorization/)
- [OWASP API4:2023 Unrestricted Resource Consumption](https://api-security.owasp.org/editions/2023/en/0xa4-unrestricted-resource-consumption/)
- [RFC 9110: HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110.html)
- [Node.js `child_process` API](https://nodejs.org/api/child_process.html)
