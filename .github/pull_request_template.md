## Problem, scope and ownership

Describe the user-visible or developer-visible problem, the intended behavior,
the affected CT requirement(s) and the owning module. Link a real Issue/epic
when one exists. State the deliberate non-goals.

## Changes and risks

Summarize substantive code/contract/architecture changes and why this approach
was chosen. Note breaking changes, security boundaries, performance tradeoffs,
uncertainty, and deferred work; write `none identified` only after review.

## Verification (actual evidence only)

| Check                                              | Result                      | Evidence / tested SHA |
| -------------------------------------------------- | --------------------------- | --------------------- |
| `pnpm check`                                       | Not run / pass / fail       |                       |
| Focused regressions and negative cases             | Not run / pass / fail       |                       |
| Semantic or other domain evaluation, if applicable | Not run / pass / fail / N/A |                       |
| Dependency security audit, if applicable           | Not run / pass / fail / N/A |                       |
| Hosted CI (Ubuntu + Windows)                       | Pending / pass / fail       |                       |

Record exact failing-before/passing-after reproduction for defect fixes when
available. Do not report fixture accuracy as independent validation unless
review provenance establishes it. Link logs or runs for the **PR head SHA**.

## Git delivery and review checklist

- [ ] Branch is scoped and based on the intended revision; base/head SHAs are
      recorded.
- [ ] Diff/staged changes inspected; no unrelated files, secrets, credentials or
      local artifacts.
- [ ] Commits use meaningful scoped messages; no direct push to `main` or force
      push.
- [ ] Feature branch pushed; remote head matches the reviewed/tested commit.
- [ ] Relevant tests and limitations are stated truthfully (including
      unavailable evidence).
- [ ] Required CI and human review are complete **before merge** (or explicitly
      pending for a draft).

## Gate and handoff

**PR state:** Draft / Ready for review

**Base SHA:** `<sha>` **Head SHA:** `<sha>` **Go / No-Go:** Pending / Go / No-Go

State remaining blockers, the reviewer decision needed, and the next smallest
milestone. This PR must not be automatically merged or used to bypass product
phase gates.
