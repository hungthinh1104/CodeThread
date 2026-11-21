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
view. When the workspace uses one column, selecting a symbol focuses the source
heading and brings the region into view. Trace uses the same selected
projection. Its keyboard-accessible relationship list keeps the identities and
evidence available while the diagram opens on demand. Returning to Source after
inspecting an occurrence requests the selected declaration's evidence. At
constrained widths an evidence action opens a modal drawer and focus returns to
the action on close. Color never carries relation kind, resolution, coverage, or
failure by itself.

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
Repository and project changes invalidate old requests and clear their
selections before starting new work. Project changes reset project symbol
pagination to the first page. The repository catalog and file inventory retain
their repository-scoped offsets. Project inventory repository/commit identity
must match the opened scan before it becomes visible. Catalog rows and
context-follow candidates must match a loaded ready project and its snapshot
before display.

Identical consecutive selections share one history entry. The workspace retains
at most 40 entries and drops forward entries when a new selection creates a
branch. Back and Forward validate the destination session and the bounded graph
before replacing the displayed context. A failed restore leaves the current
context and workspace cursor available for retry. The restored graph supplies
valid selection IDs, and missing evidence stays explicit. Unknown or evicted
browser entries leave the displayed context intact.

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
behind an unpredictable HttpOnly same-site cookie scoped by scan ID. Viewer
requests carry the expected scan in `X-CodeThread-Scan-Id`. The BFF checks the
selected cookie and its session's scan before forwarding. The tab remembers only
the scan ID in session storage to reload its own context. Only fixed `/api/*`
operations are forwarded to that validated port with exact Host/Origin and the
viewer token. The browser receives neither backend token, viewer token, local
repository locator nor viewer URL. The Next process uses a restrictive CSP,
nonced framework scripts and no external resource origins. There is no generic
proxy, direct database access, persisted source cache, or new semantic/query
logic. Sessions are ephemeral and expire with the existing viewer TTL or process
restart.

This is defense for a local single-developer candidate, not a sandbox against a
malicious local process or administrator. Backend API and ephemeral viewer
contracts remain authoritative; the BFF rejects responses that do not match
those schemas.

Next.js 16.4.6 vendors `picomatch` 4.0.1. The vendored code is outside the
lockfile dependency audit and falls in the affected range of
[GHSA-3v7f-55p6-f55p](https://github.com/advisories/GHSA-3v7f-55p6-f55p) and
[GHSA-c2c7-rcm5-vvqj](https://github.com/advisories/GHSA-c2c7-rcm5-vvqj). The
Workspace disables the unused image optimizer. Next returns 404 from
`/_next/image` before validating image parameters and entering the local or
remote image-pattern matchers. Proxy routing uses Next's compiled route regular
expression for the fixed application route pattern. The affected library remains
bundled and is used by framework build tooling. Keep the dependency open for
security-owner disposition and a verified upstream fix.

## Verification viewport and interactions

Exercise 1440, 1280, 768, and 390 CSS pixel widths, keyboard-only use, light and
dark themes, long Unicode paths, narrow inspector drawer behavior, and empty,
loading, partial, error, and selected-evidence states. The browser suite's 720
CSS pixel viewport checks reflow. For actual 200% tab zoom, run
`pnpm workspace:zoom:verify`. The bundled Chromium extension sets the tab zoom
to 2, checks a 1440 to 720 CSS pixel viewport change, and exercises the drawer
from the evidence action. The default output is
`artifacts/ct-workspace-001b/next-app/`.

The Ubuntu pull request job captures fixture evidence when the diff changes
Workspace sources, shared contracts, viewer sources, visual test helpers, the
lockfile or the workflow. The `workspace-visual-<pr-head-sha>` artifact contains
before and after PNGs, tab zoom measurements, and a comparison of geometry,
request counts and interaction timings. Both captures use the same runner and
fixture bytes. The artifact records the base SHA, PR head SHA and the exact CI
checkout used for the candidate. These timings describe the fixture run.

Browser regressions cover repository and context switching, catalog/file
pagination, symbol search, trace filters/direction, exact target following,
Back/Forward, session reload, stale success and error responses,
missing/ambiguous evidence, limits, typed failures, safe source rendering, and
proving that requests never leave loopback. Screenshot evidence must be
generated and retained as an inspectable artifact; merely defining screenshot
helpers is not evidence.

The slice remains a local investigation candidate. It does not claim full-file
source display, complete analyzer coverage, improved comprehension, production
security, or human approval.
