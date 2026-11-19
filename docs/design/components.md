# CodeThread component composition contract

This file is a **forward contract**, not evidence that React components exist.
First implement the narrowest source-backed investigation slice, then promote
stable components.

## Layering

**Screen → Feature → Domain → Primitive → Tokens.**

- **Screen** owns repositoryId, scanJobId, projectId, snapshotId, deep links and
  screen layout.
- **Feature** owns query/filter/selection, request sequence, retry and loading;
  consumes typed feature adapters.
- **Domain** receives a validated read model, and renders
  identities/status/evidence. No fetch, DB or source parsing.
- **Primitive** owns style, basic keyboard semantics, aria and local disclosure;
  no graph/scan knowledge.
- **Token** provides visual values only.

Presentation imports must not reach backend, SQL, compiler AST internals or
other feature private state. Never display untrusted source through innerHTML.

## Strict composition rules

1. **Single owner per state.** Do not mirror URL/snapshot state inside multiple
   sibling components.
2. **Explicit layout slots.** InvestigationShell has `explorer`, `toolbar`,
   `main`, `inspector`; Pane has `heading`, `actions`, `body`, `footer`. No
   universal Card for unrelated semantic content.
3. **Separate semantic types.** ScanStatus =
   queued/running/succeeded/failed/cancelled; ResolutionStatus =
   exact/unresolved/ambiguous/unsupported; CoverageSummary = per-capability
   coverage; TruncationNotice = query truncation metadata. Never accept one
   general `status: string`.
4. **No color-only truth.** Text distinguishes relation kind, resolution,
   completeness, failure, focus and selection. CALLS/REFERENCES must not be
   inferred from CSS.
5. **No fabricated nodes.** TraceCanvas draws only returned graph
   endpoints/relations. An unknown target is unknown; no invented target node or
   execution path.
6. **Async isolation.** Every response must match context identity and latest
   request sequence; stale successes _and errors_ are discarded. Cancellation is
   insufficient on its own.
7. **Bounded and accessible.** Graph has list alternative. Pagination and
   truncation messages remain explicit. Use native button/inputs; do not hide
   focus.
8. **Controlled slots, not boolean explosion.** Prefer narrow variants and typed
   callbacks. Split components if props encode unrelated screen roles.
9. **State matrix.** Each feature handles idle, loading, success, empty,
   partial, unsupported, error, retry, expired. Missing evidence never silently
   substitutes worktree source.
10. **Shared promotion.** Two real call sites or one stable platform primitive.
    Identical appearance does not imply identical business semantics.
11. **Failure tests.** Verify wrong snapshot, stale response, missing evidence,
    source hash mismatch, empty/partial graph, long paths and keyboard/focus
    behavior.

## Initial component inventory (planned, not all to implement now)

- Primitives: Button, IconButton, Pane, Tabs, Badge, Tooltip, Skeleton, Notice,
  Dialog.
- Domain: ScanStatus, ResolutionStatus, CoverageSummary, TruncationNotice,
  SourceLocation, EvidenceAnchor, RelationRow, SymbolRow.
- Feature: RepositoryExplorer, ScanDetail, TraceCanvas, RelationshipList,
  EvidenceInspector.
- Screen: Repository, Scan, Investigation.

**First vertical slice:** Investigation, real pinned snapshot → select symbol →
view returned relation → inspect verified source evidence. Do not introduce
Next.js, a BFF or a general application shell in this design-only gate. Review
visual hierarchy and semantic states before reuse.
