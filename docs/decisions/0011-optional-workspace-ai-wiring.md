# ADR-0011: Optional backend, BFF, and editorial workspace wiring for CT-AI-001

Status: accepted for the CT-AI-001 opt-in local backend, BFF, and Investigation
Workspace slice, 2026-11-26. The ephemeral viewer (`ADR-0005`), default
study/visualization parity (`CT-EVAL-001`), multiuser service, and production
deployment remain unchanged and gated.

## Context

`ADR-0010` introduced the `CT-AI-001` contracts, packet builder, secret
redaction, deterministic post-verifier, and offline-tested Gemini and
OpenAI-compatible/Ollama adapters. `ADR-0009` restricts the Investigation
Workspace BFF to allowlisted backend/viewer operations, while `ADR-0005`
excludes AI from the in-memory ephemeral viewer. Exposing optional AI notes in
the Workspace therefore requires explicit route, capacity, disclosure, and
visual-separation boundaries.

## Decision

1. **Backend-owned packet construction (`scripts/backend/ai-service.ts`)**:
   - Add `GET /v1/ai/status` returning `{enabled: false}` when off, or
     `{enabled: true, provider, locality, model}` without credentials or URLs.
   - Add `POST /v1/scans/:id/projects/:projectId/ai/synthesize` accepting only
     `{task, neighbors, maxClaims, maxNextSteps}` (4 KiB request limit, 64 KiB
     response limit). Clients never upload packets or source text; the backend
     hydrates the verified snapshot once via `BackendQueryService.aiProjection`,
     redacts secret-like substrings, and **releases the heavy-query database
     slot before invoking any AI provider**.
   - Enforce a dedicated concurrency limit of 2 active AI requests
     (`429 AI_CAPACITY_EXCEEDED`) and an in-memory LRU cache keyed by
     `packetHash`, task, provider, model, prompt version, and limits.
   - Default `CODETHREAD_AI_PROVIDER` when `CODETHREAD_AI_ENABLED=1` to local
     loopback `openai_compatible` (Ollama) and require explicit
     `CODETHREAD_AI_ALLOW_REMOTE=1` before permitting any non-loopback provider.
2. **Same-origin BFF adaptation (`packages/investigation-workspace`)**:
   - Add `GET /api/ai/status` and scan-cookie-authenticated
     `POST /api/workspace/ai` (`30s` upstream timeout, `64 KiB` response cap,
     strict snapshot/symbol/task correspondence check).
   - Keep `CODETHREAD_API_TOKEN` and provider keys strictly server-side.
3. **Editorial Workspace presentation (conditional `Notes` tab)**:
   - When `GET /api/ai/status` reports `{enabled: false}` (the default), render
     nothing so the default Investigation Workspace DOM and behavior remain
     identical to `ADR-0009`.
   - When enabled, render a conditional `Notes` tab
     (`Source | Trace | Paths | Notes`) inside the main workbench region using
     Warm Graphite tokens only—no chat input, no sparkle icons, no auto-run on
     selection, explicit remote/local disclosure, real relation kind/resolution
     badges derived from verified facts, and clickable `path:line` evidence
     buttons that open verified `SHA-256` excerpts side-by-side in the Evidence
     dock without leaving Notes.

## Consequences

- Default `CODETHREAD_AI_ENABLED` unset/off behavior has zero UI, DOM, network,
  or study-baseline impact.
- Long-running LLM calls cannot starve the four snapshot heavy-query slots.
- Remote source-excerpt egress requires dual opt-in (`CODETHREAD_AI_ENABLED=1`
  and `CODETHREAD_AI_ALLOW_REMOTE=1`) plus visible locality disclosure in UI.
