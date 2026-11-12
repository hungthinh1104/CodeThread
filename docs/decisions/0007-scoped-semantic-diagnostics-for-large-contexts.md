# ADR-0007: Scope semantic compiler diagnostics in large project contexts

Status: accepted for the bounded local MVP, 2026-11-13.

Collect full per-file semantic compiler diagnostics for contexts with at most 64
source files. In larger project contexts, query diagnostics only for source
files that can produce supported relationship candidates and their resolved
declarations; emit `SEMANTIC_DIAGNOSTICS_SCOPED` and keep compiler/type-context
completeness false when files are skipped. Exact relationships still require
diagnostics for both their source occurrence and target declaration. This bounds
work under the shared repository deadline without implying that an incomplete
diagnostic set is complete.

Running full diagnostics over the 334-file Zod context took 18.5 seconds per
context while 28 files contained relevant relationship sources or targets.
Keeping exhaustive diagnostics exceeded the 120-second repository deadline.
Skipping semantic checks globally was rejected because a compiler error at a
call site or declaration header could turn a false exact edge into an apparent
exact relationship.
