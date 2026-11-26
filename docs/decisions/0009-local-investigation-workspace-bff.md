# ADR-0009: Bounded local Investigation Workspace and BFF

Status: accepted for the CT-WORKSPACE-001B implementation candidate only,
2026-11-18.

## Context

The accepted CT-VIEW-001 browser proof already exposes persisted snapshot
projections through a local backend API and a per-scan ephemeral viewer. The
design foundation in PR #38 defines a source-first Investigation Workspace, but
does not implement a product frontend. The existing API supplies repository
identity, scan state, project contexts, repository-wide symbol and file pages,
bounded trace projections, and verified source excerpts. It does not return a
complete source file.

## Decision

Implement only the local Investigation Workspace described in
`docs/design/investigation-workspace.md` as a Next.js/TypeScript package. Bind
its server to IPv4 loopback. Add same-origin Route Handlers as a thin BFF that
keeps backend API and viewer tokens server-side and forwards only the existing
allowlisted operations after runtime response validation. Keep graph/query
semantics, persistence, scan orchestration, evidence verification, and source
provenance in their existing owners. Display verified evidence excerpts and
state explicitly that full-file source is unavailable.

The BFF owns only local session adaptation, allowlisting, transport limits,
origin checks, CSP, and response contract enforcement (including forwarding
allowlisted viewer `/api/*` operations and scan-scoped backend symbol-path
queries via `POST /api/workspace/paths` validated with
`parseFindSymbolPathsResult`, plus opt-in AI routes governed by ADR-0011). It is
not a general API, does not read PostgreSQL, and cannot proxy arbitrary URLs. A
scan-scoped HttpOnly cookie selects the server-side session for the tab's
expected scan ID. Session credentials are process-local and expire no later than
the existing ephemeral viewer.

## Consequences

- The product has a bounded local workspace over existing scan snapshots; this
  does not open the general frontend, scan-management, multiuser, or deployment
  gates.
- Next.js and React become runtime dependencies for this one package; their
  build, typecheck, browser and security checks are part of its gate.
- UI uses public API contracts rather than private script modules or database
  rows. Changes to the viewer wire contract are validated at the BFF boundary.
- Full-file source navigation remains unavailable until an authorized API
  capability exists; the UI cannot substitute mutable worktree files.
- Local loopback, CSP, same-origin checks and secret confinement reduce browser
  exposure but do not constitute a production security assessment.

## Alternatives considered

- Extending the in-process HTML viewer would retain a small dependency surface,
  but it does not provide the requested Next.js application boundary and would
  keep product state inside the old viewer. It remains the CT-VIEW proof.
- A generic web API or direct database adapter would duplicate domain and
  persistence ownership, so it is rejected.
- A full source endpoint or source cache is out of scope; verified evidence
  excerpts are the supported behavior.
