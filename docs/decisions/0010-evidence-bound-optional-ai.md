# ADR-0010: Evidence-bound optional AI foundation

Status: accepted for the CT-AI-001 foundation slice (contracts, grounded core,
deterministic post-verifier, and dual server-side provider adapters),
2026-11-26. Backend HTTP exposure, BFF routes, and Investigation Workspace UI
rendering remain gated to subsequent slices.

## Context

CodeThread already establishes immutable pinned-revision snapshots, exact static
`CALLS`/`REFERENCES` projections, explicit
`unresolved`/`ambiguous`/`unsupported` diagnostics, and hash-verified source
excerpts. Both `product.yaml` and `CT-EVAL-001` (`AC-03`) require any AI
capability to remain optional, disabled by default, and strictly separate from
the core visualization comprehension evaluation.

Conventional code-assistant integrations send unconstrained repository files to
an LLM behind a chat interface. That design violates CodeThread's core product
principles: it encourages ungrounded speculation, blurs verified compiler facts
with generated prose, leaks repository secrets or dirty working-tree code, and
pulls the UI away from Technical Editorial / Warm Graphite toward generic
chatbot chrome.

## Decision

Introduce a bounded, opt-in, **evidence-bound AI foundation** (`CT-AI-001`) with
three strict architectural layers and zero new runtime npm dependencies:

1. **Validated AI contracts in `@codethread/contracts`** (`ai-queries.ts` and
   `ai-results.ts`):
   - Define three narrow comprehension tasks rather than open-ended chat:
     - `explain_trace`: summarize a bounded static trace around a root symbol.
     - `explain_unknowns`: explain explicit
       `unresolved`/`ambiguous`/`unsupported` sites and concrete manual
       verification steps.
     - `suggest_next_steps`: rank bounded follow-up symbols drawn strictly from
       symbols already present in the snapshot packet.
   - Define a bounded, snapshot-scoped `AiContextPacket` carrying only validated
     root/symbol metadata, relations, verified excerpts (with explicit byte
     caps), diagnostics, and coverage/truncation metadata.
   - Define a strict structured output schema where every claim declares its
     `claimType` (`observed_fact`, `static_inference`, `uncertainty_note`),
     optional `assertedRelationKind`, and non-empty `evidenceIds` (plus optional
     `symbolIds`, `relationIds`, `diagnosticIds`).
2. **Deterministic post-verifier and packet builder in `scripts/ai/`**:
   - Build prompts solely from the validated `AiContextPacket` and compute a
     deterministic `packetHash` (SHA-256) for provenance and replayability.
   - Parse and verify every raw model response locally before returning:
     - Reject any claim citing an `evidenceId`, `symbolId`, `relationId`, or
       `diagnosticId` absent from the input packet.
     - Reject any claim asserting `exact_call` when the cited relation is
       `references` or has `resolution !== 'exact'`.
     - Reject any claim asserting runtime execution or passing tests (static
       evidence never proves runtime execution).
     - Reject any `suggest_next_steps` recommendation whose `symbolId` is not in
       the packet's symbol inventory or whose `supportingEvidenceIds` are not
       present in the packet.
     - Surface explicit `verification` accounting (`verifiedClaims`,
       `rejectedClaims`, `verifiedNextSteps`, `rejectedNextSteps`,
       `rejectedItems[]` with machine-readable reason codes) instead of silently
       fabricating or hiding dropped claims.
3. **Dual server-side provider adapters (disabled by default)**:
   - Support **Gemini API** (`generateContent` with JSON MIME type) and
     **OpenAI-compatible / Ollama** (`/chat/completions` with JSON response
     format) using Node 24's built-in `fetch` and `AbortSignal.timeout`.
   - Default configuration is disabled (`CODETHREAD_AI_ENABLED` unset or not
     `'1'`), failing closed with `AI_DISABLED` without performing network I/O.
   - Keep `scripts/ai/` isolated in `scripts/architecture.ts`: it may import
     `@codethread/contracts`, `@codethread/code-model`, Node built-ins, and
     sibling `scripts/ai/` modules, never backend persistence, Git acquisition,
     compiler internals, or browser code.
4. **Anti-AI-Slop UI guardrails codified up front**:
   - Strengthen `.agents/skills/codethread-ui-taste/SKILL.md` and add
     `.agents/skills/evidence-bound-ai/SKILL.md` so any future UI slice keeps
     Warm Graphite editorial styling, forbids chat/sparkle/gradient tropes,
     never auto-runs AI on selection, and visibly separates unverified synthesis
     from verified source excerpts.

## Consequences

- CodeThread gains a testable, deterministic, provider-agnostic AI grounding
  layer with zero added npm packages and zero impact on default offline tests.
- Hallucinated identifiers, cross-snapshot leaks, static-to-runtime overclaims,
  and misclassified relation kinds are caught deterministically by unit-tested
  code rather than prompt wording alone.
- Enabling live provider calls later requires explicit opt-in environment
  variables and separate authorization for backend HTTP, BFF, and Workspace UI
  wiring.

## Alternatives considered

- **Open-ended repository chat / raw-file RAG:** Rejected because it duplicates
  general AI coding platforms (an explicit non-goal in `product.yaml`), invites
  hallucination, and conflicts with CodeThread's evidence-first workflow.
- **Adding third-party AI SDK dependencies (`@google/genai`, `openai`):**
  Rejected for this foundation slice to keep the lockfile, supply-chain audit
  surface, and architecture boundaries minimal; both REST endpoints are narrow
  JSON calls well served by Node 24 `fetch`.
- **Prompt-only grounding without a deterministic post-verifier:** Rejected
  because LLMs routinely invent plausible UUIDs, line references, or runtime
  claims; deterministic local verification is mandatory for trustworthy
  provenance.
