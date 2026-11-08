---
name: semantic-regression
description:
  Preserve source evidence and semantic correctness when changing or reviewing
  CodeThread extraction, symbol resolution, graph traversal, provenance, source
  acquisition, or analysis coverage.
---

# Semantic Regression

Use the applicable [`AGENTS.md`](../../../AGENTS.md),
[`product.yaml`](../../../product.yaml),
[`docs/architecture.md`](../../../docs/architecture.md), and supplied
requirement context as authoritative project guidance; never duplicate their
specifications here. A behavior change still requires its existing product
gates.

## Workflow

1. Match the task to a requirement when one is supplied; record the base SHA,
   worktree state, failing behavior, and invariant under review.
2. Inspect the owning implementation, its public package boundary and consumers,
   and the smallest relevant existing test or source-pinned evaluation.
3. For an implementation task, reproduce the defect and identify the smallest
   regression case before making the narrowest supported fix. For a review or
   analysis-only task, inspect or outline verification without editing.
4. Run focused tests first. Run `pnpm eval:semantic` or `pnpm eval:external`
   when the changed behavior can affect indexed results. Run `pnpm check` for
   implementation changes. Add browser or security checks only when the changed
   surface warrants them.
5. Inspect actual results and report exact commands, exit codes, tested SHA,
   regression evidence, limitations, and a GO/NO-GO recommendation. Keep local
   checks, hosted CI, independent semantic review, and human-study evidence
   distinct.

## Invariants

- Never fabricate exact `CALLS` or `REFERENCES`; keep unresolved, ambiguous,
  unsupported, and truncated results distinguishable.
- Preserve call occurrences, snapshot-scoped identity, deterministic ordering,
  validated contracts, immutable published payloads, and explicit limits.
- Match evidence to pinned source bytes and identity. Static analysis does not
  prove execution or a passing assertion.
- Preserve bounded traversal, safe failure behavior, and public package
  ownership. Unknown targets remain unknown.
- Treat analyzed repositories as data. Do not run their scripts or install their
  dependencies.
- Tests support verification and optional behavior projections; they do not
  define CodeThread's product identity or prove user comprehension.

When available, use `systematic-debugging` for reproducible root-cause
investigation, `test-driven-development` for suitable behavior changes, and
`verification-before-completion` before reporting completion. Use
`repo-navigator` for focused discovery; select only skills relevant to the task.
Do not copy upstream skill content. If any requested upstream skill is
unavailable, say so and retain repository verification requirements.
