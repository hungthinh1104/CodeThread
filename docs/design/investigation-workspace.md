# CT-WORKSPACE-001B Investigation Workspace

Status: implementation candidate on top of PR #38. This document authorizes one
bounded local workspace; it does not authorize a general frontend, repository
administration, public service, AI feature, or deployment.

## User journey

1. Choose a repository with an available successful scan.
2. Choose a ready compiler project context within that pinned scan.
3. Search the repository catalog or browse its paged file inventory.
4. Inspect a source-backed declaration and its returned CALLS or REFERENCES.
5. Open verified evidence and follow an exact declaration anchor. When several
   contexts contain the same anchor, choose the destination context.
6. Use Back and Forward to restore the earlier scan, context, root, filters,
   direction, and selections that still exist in the returned projection.

The workspace reports scan state, per-file analysis, project status, semantic
coverage, relation resolution, query truncation, and evidence availability as
separate dimensions. It never treats a failed context, unsupported relation,
omitted page, truncated graph, or missing excerpt as proof of absence. Source
panels say “verified excerpt”; no API currently returns a complete source file.

## Screen composition

```text
InvestigationScreen
├── ScanContextHeader (repository, revision, scan state, change context)
├── WorkspaceShell
│   ├── ExplorerRegion
│   │   ├── ProjectContextPicker
│   │   ├── SymbolSearch + CatalogPager
│   │   ├── FileInventory + FilePager
│   │   └── PerFileAnalysisStatus
│   ├── MainRegion
│   │   ├── SourceTraceTabs
│   │   ├── VerifiedSourceExcerpt
│   │   ├── RelationshipFilters
│   │   ├── TraceProjection + RelationshipList
│   │   └── CoverageAndTruncationNotices
│   └── EvidenceInspector (desktop region, narrow-screen drawer)
│       ├── EvidenceLocation + Hash
│       ├── VerifiedExcerpt / UnavailableReason
│       └── FollowContextChoice
└── KeyboardHistoryControls
```

The explorer and inspector use explicit region slots. Source is the initial main
view; Trace is a tab over the same selected projection. The graph is optional
because the keyboard-accessible relationship list carries the same identities
and evidence. At constrained widths the inspector becomes a keyboard-operated
drawer. Color never carries relation kind, resolution, coverage, or failure by
itself.

## State ownership and async identity

The screen owns the selected scan and project context. The investigation feature
owns query text, page offsets, root, relation-kind filters, direction, selected
relation/evidence, navigation history, and request generations. Domain
components render validated API DTOs and have no fetch, database, compiler, or
source-parsing behavior. Primitives own only presentation and local keyboard
interaction.

Each async request captures
`(scanId, projectId, snapshotId, generation, requestKey)`. Both success and
error responses are discarded unless that tuple still matches current state.
Context changes synchronously increment the generation and clear selections
before starting new work. AbortController is a resource optimization; identity
checks enforce correctness. Back/Forward issues the bounded query for the
restored context and restores selections only when those IDs occur in that
response. Project inventory repository/commit identity must match the opened
scan before it becomes visible; catalog rows and context-follow candidates must
match a loaded ready project and its snapshot before display.

| Feature             | Idle             | Loading                  | Success                             | Empty / partial                                                  | Unsupported                                          | Error / expired                            |
| ------------------- | ---------------- | ------------------------ | ----------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------ |
| Repository and scan | Prompt to choose | Scan state visible       | Pinned revision shown               | No ready scan is explicit                                        | Failed/cancelled scan retains reason                 | Typed backend error and retry              |
| Project context     | Prompt to choose | Selection is pending     | Snapshot identity shown             | Invalid/failed/not-analyzed contexts remain listed               | Solution/unsupported context is disabled with reason | Expired session can be reopened            |
| Catalog and files   | No context       | Page request pending     | Stable ordered page                 | Empty, next page, inventory incompleteness and file status shown | Excluded/unanalysed files keep their status          | Typed error; stale pages ignored           |
| Source and trace    | No symbol        | Evidence/query pending   | Exact returned facts                | No relations differs from truncation or partial coverage         | Unknown targets remain non-followable                | Typed failure; retry is bounded            |
| Evidence inspector  | No selection     | Evidence request pending | Path, location, SHA-256 and excerpt | Typed unavailable evidence                                       | No inferred source substitution                      | Typed error; stale selection cleared       |
| History             | One state        | Restored query pending   | Valid selections restored           | Missing IDs are omitted with explanation                         | Invalid context cannot be selected                   | Failed restore leaves current state intact |

## Local BFF security boundary

The Next.js app is a loopback-only, same-origin presentation process. Its Route
Handlers are a fixed adapter, not an application backend: they accept only the
existing repository-list, scan-status, viewer-open, and viewer API operations;
reject arbitrary URLs, paths, query parameters and redirects; cap JSON requests
at 64 KiB and responses at 1 MiB; validate viewer responses with the public
`@codethread/contracts` schemas; and return `Cache-Control: no-store` with typed
errors. The server binds only to `127.0.0.1` and checks the configured exact
Host and same Origin on state-changing requests.

`CODETHREAD_API_TOKEN` is read only by server code. The BFF opens the existing
per-scan ephemeral viewer using the backend API, validates that its returned
address is IPv4 loopback, and keeps the viewer fragment token in process memory
behind an unpredictable HttpOnly same-site cookie. Only fixed `/api/*`
operations are forwarded to that validated port with exact Host/Origin and the
viewer token. The browser receives neither backend token, viewer token, local
repository locator nor viewer URL. The Next process uses a restrictive CSP,
nonced framework scripts, no external resource origins, and no client storage.
There is no generic proxy, direct database access, persisted source cache, or
new semantic/query logic. Sessions are ephemeral and expire with the existing
viewer TTL or process restart.

This is defense for a local single-developer candidate, not a sandbox against a
malicious local process or administrator. Backend API and ephemeral viewer
contracts remain authoritative; the BFF rejects responses that do not match
those schemas.

## Verification viewport and interactions

Exercise 1440, 1280, and 768 CSS pixel widths, keyboard-only use, light/dark
themes, long Unicode paths, narrow inspector drawer behavior, and
empty/loading/partial/error/selected-evidence states. A retained 720 CSS pixel
viewport is used as the reflow equivalent of 200% zoom on a 1440 CSS pixel
display; Playwright does not change browser chrome zoom. Browser regressions
cover repository and context switching, catalog/file pagination, symbol search,
trace filters/direction, exact target following, Back/Forward, session reload,
stale success and error responses, missing/ambiguous evidence, limits, typed
failures, safe source rendering, and proving that requests never leave loopback.
Screenshot evidence must be generated by the test and retained as an inspectable
artifact; merely defining screenshot helpers is not evidence.

The slice remains a local investigation candidate. It does not claim full-file
source display, complete analyzer coverage, improved comprehension, production
security, or human approval.
