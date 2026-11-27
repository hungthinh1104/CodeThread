# ADR-0012: Full local Backend-to-Workspace BFF integration

Status: accepted for the local Investigation Workspace candidate on top of
ADR-0009, ADR-0010, and ADR-0011, 2026-11-28.

## Context

`packages/investigation-workspace` originally adapted only the ephemeral viewer
operations (`projects`, `catalog`, `files`, `follow-context`, `session`,
`symbols`, `neighbors` capped at depth 2 / 50 symbols, and `evidence`). Seven
persistent local backend endpoints in `scripts/backend/http.ts`
(`GET /v1/health`, `POST /v1/repositories`, `GET /v1/repositories/:id`,
`POST /v1/repositories/:id/scans`, `GET /v1/scans/:id`,
`POST /v1/scans/:id/cancel`, `GET /v1/scans/:id/projects`,
`GET /v1/scans/:id/files`) and deeper PostgreSQL graph projections
(`depth: 1..5`, `nodeLimit: 1..200`, `CONSTRUCTS` relations) required external
CLI calls during local single-developer investigations.

## Decision

Connect all 16 existing local backend routes through explicit, fixed Next.js
Route Handlers in `packages/investigation-workspace` while preserving every
confinement and contract invariant from ADR-0009:

1. **System & scan lifecycle routes (`src/server/scan-admin-bff.ts`):**
   - `GET /api/health` adapts `GET /v1/health` (including HTTP `503` degraded
     readiness payloads) and `GET /v1/ai/status`.
   - `GET / POST /api/repositories` and `GET /api/repositories/:id` adapt
     repository listing, registration beneath `CODETHREAD_ALLOWED_REPO_ROOT`,
     and single-repository refresh while sanitizing `locator` to a display label
     server-side so raw host paths never enter browser responses.
   - `POST /api/repositories/:id/scans`, `GET /api/scans/:id`,
     `POST /api/scans/:id/cancel`, `GET /api/scans/:id/projects`, and
     `GET /api/scans/:id/files` expose idempotent local scan submission, bounded
     status polling, cancellation, project readiness diagnostics, and committed
     Git file modes (`100644` / `100755`).
2. **Extended snapshot query routes (`src/server/workspace-bff.ts`):**
   - Default `Trace` queries (`depth = 2`, `nodeLimit = 50`,
     `calls`/`references`) continue using the ephemeral viewer `/api/neighbors`
     projection (retaining unowned `unknowns` observations).
   - Extended `Trace` queries (`depth: 1..5`, `nodeLimit: 50..200`, or
     `constructs`), directed symbol paths (`POST /api/workspace/paths`), direct
     source evidence fallback (`POST /api/workspace/evidence-direct`), and
     symbol search metadata (`POST /api/workspace/symbols-meta`) require a valid
     scan-scoped HttpOnly session cookie (`ct_workspace_session_<scanId>`) plus
     `X-CodeThread-Scan-Id` and validate every response with
     `parseGraphNeighborsResult`, `parseFindSymbolPathsResult`,
     `parseGetSourceEvidenceResult`, and `listSymbolsResponseSchema`.

## Consequences

- Every capability of the local PostgreSQL backend is reachable from the
  Investigation Workspace UI without weakening loopback origin checks, CSP,
  token confinement, or locator redaction.
- Scanlifecycle, snapshot coverage, relation resolution, and query truncation
  remain visually and semantically distinct in the Warm Graphite UI.
- Production deployment, multi-user tenancy, remote repository ingestion, and
  automated merges remain gated.
