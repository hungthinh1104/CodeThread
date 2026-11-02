# ADR-0005: Ephemeral loopback visual investigation

Status: accepted for CT-VIEW-001 only, 2026-11-03.

## Decision

The explicitly authorized CT-VIEW-001 proof uses an opt-in, in-process HTTP
viewer bound to `127.0.0.1` on an ephemeral port. The existing CLI performs
source acquisition and `analyzeManifest`; the viewer calls the existing
`createInvestigation` methods and serves only contract-validated symbol,
neighbor and evidence projections. The browser performs layout and selection
only. This does not authorize a general frontend, backend service, public API,
database, persistence, or AI phase.

The page and its static assets share the loopback origin. The server validates
the exact Host and Origin, checks a random per-session token supplied from the
URL fragment in a request header, sends no CORS allowance, and applies a strict
Content Security Policy. API request bodies are capped at 64 KiB, responses at 1
MiB, symbol search returns at most 50 rows, and a visual graph admits at most 50
symbols and the existing 1,000 relationship ceiling. Truncation is displayed
from the validated query result. Closing the CLI stops the server; there is no
browser storage, source export, telemetry, or external resource loading.

## Considered options

- **Self-contained HTML report — rejected.** A file can be opened without a
  server and has no listening process, but interactive root changes require
  precomputing many graph projections or adding a second graph engine in the
  browser. Precomputation duplicates bounded results and can create a large
  source-bearing artifact; this work avoids writing such a persistent report.
- **Ephemeral loopback viewer — selected.** It works from `file:` restrictions
  by using a single loopback origin, obtains each new root from the existing
  trace engine, and keeps source bytes in process memory. Its additional HTTP
  attack surface and process lifecycle are bounded by loopback-only binding,
  host/origin/token checks, strict content policy, body/response limits and
  explicit shutdown.

The test-only Playwright dependency exists to verify actual browser interaction
and does not enter the runtime. The viewer uses browser-native HTML, CSS and SVG
without a frontend framework. These choices work on Windows and Linux through
Node's built-in HTTP server and installed Chromium test binaries.
