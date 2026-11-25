---
name: evidence-bound-ai
description:
  Design, implement, or review CodeThread's optional evidence-bound AI
  assistance, structured AI contracts, deterministic citation verification, and
  provider adapters without violating source-first invariants or study parity.
---

# Evidence-Bound AI

Follow [AGENTS.md](../../../AGENTS.md), [`product.yaml`](../../../product.yaml),
[`docs/architecture.md`](../../../docs/architecture.md),
[ADR-0010](../../../docs/decisions/0010-evidence-bound-optional-ai.md), and
`pnpm --silent req:context CT-AI-001` before changing AI behavior.

## Core Invariants

1. **Disabled by default:** Optional AI runs only when explicitly enabled by
   operator configuration (`CODETHREAD_AI_ENABLED=1`). Default CLI, backend,
   viewer, workspace, and `pnpm check` flows never make outbound network calls
   or require provider credentials.
2. **Bounded validated input only:** Build prompts strictly from a validated,
   snapshot-scoped packet (root symbol, bounded relations, verified excerpts,
   explicit diagnostics/unknowns, and coverage metadata). Never read arbitrary
   repository files, dirty working-tree files, or repository scripts, and
   enforce strict input byte/item limits.
3. **Structured JSON + Deterministic Post-Verifier (Citation-or-Silence):**
   - Require structured JSON conforming to `@codethread/contracts` AI schemas.
   - Verify every cited `symbolId`, `relationId`, `evidenceId`, and
     `diagnosticId` against the exact input packet for that single `snapshotId`.
   - Reject or downgrade claims that cite unknown IDs, contradict static
     resolution (e.g., claiming `exact_call` for `references`, `unresolved`,
     `ambiguous`, or `unsupported`), or assert runtime execution / test pass.
   - Preserve exact counts of verified vs. rejected claims in the result
     metadata; never silently fabricate missing citations.
4. **Provider isolation and secret hygiene:** Keep provider HTTP logic and API
   keys server-side inside `scripts/ai/`. Never expose credentials, raw provider
   error payloads containing secrets, or local repository locators to callers or
   browser surfaces. Enforce explicit request timeouts and response byte caps.
5. **Study and UI boundaries:**
   - Keep AI evaluations completely separate from `CT-EVAL-001` visualization
     comparisons (`AC-03`).
   - Any future UI integration must follow
     [codethread-ui-taste](../codethread-ui-taste/SKILL.md) and
     [DESIGN.md](../../../docs/design/DESIGN.md): no chat-first UI, no sparkle
     branding, no auto-run, and strict visual separation from verified facts.

## Verification Checklist

- Test every task kind (`explain_trace`, `explain_unknowns`,
  `suggest_next_steps`) with deterministic offline mock/replay providers.
- Include adversarial regressions: hallucinated `evidenceId`/`symbolId`,
  cross-snapshot IDs, upgrading `references` or `unresolved` to `exact_call`,
  runtime-execution wording, malformed/non-JSON output, oversized packets,
  disabled-by-default behavior, and provider timeout/HTTP error handling.
- Run `pnpm check` and verify `arch:check` enforces `scripts/ai/` layer
  isolation with zero new unapproved runtime dependencies.
