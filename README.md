# CodeThread

CodeThread is a source-code and software-system comprehension tool.
Investigations can begin at a source file, module, symbol or supported entry
point, then follow supported relationships across files to exact declarations
and source evidence. Test behavior is optional supporting information, not a
prerequisite.

The official academic thesis title remains **Code Comprehension Enhancement
using Visual Test Trace**. V0 targets local committed TypeScript revisions and
static evidence. Jest/NestJS extensions remain optional; core graph facts do not
depend on those frameworks. Static syntax is not proof of runtime execution or
passing tests.

The repository supplies Foundation validation/tooling, the proposed DB-01
logical design, and a bounded in-memory TypeScript semantic proof. It contains
no database implementation, Git crawler, API, UI or Gemini integration. See
`product.yaml` and `docs/architecture.md` for scope, ownership and gates.

## Developer setup

Use Node **24.22.2** and pnpm **12.16.1**. The compiler is TypeScript **6.0.3**;
dependencies and the lockfile are pinned. No database or Docker engine is needed
for this batch. Vitest uses Vite internally as test tooling; Vite is not the
application framework.

With the pinned tools on PATH:

```sh
pnpm install --frozen-lockfile
pnpm check
```

On Windows x64 without Node or pnpm, use the optional portable bootstrap:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pnpm.ps1 install --frozen-lockfile
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pnpm.ps1 check
```

The bootstrap verifies the official Node archive SHA-256 and installs pinned
pnpm under ignored `.tooling`. It changes no system installation or persistent
execution policy. It requires network access to Node's distribution site and the
npm registry. Linux/macOS users install the same pinned tools through their
usual tool manager. For example, after installing Node 24.22.2,
`npm install --global pnpm@12.16.1` installs the pinned package manager.

`pnpm check` runs formatting, lint, requirement validation, package boundaries,
build, typecheck and focused tests. Individual commands are `format:check`,
`lint`, `req:validate`, `arch:check`, `build`, `typecheck` and `test`. Run
`pnpm build` before standalone tests: tests import the packages' public compiled
entry points. Use `pnpm format` when intentionally formatting changes.

Run `pnpm security:check` separately with network access. It uses the pinned
pnpm's native audit, including the project document of the multi-document
lockfile, and fails on reported vulnerabilities. Advisory-service/network errors
also fail the command and must be reported as unavailable audit evidence, not a
vulnerability finding or a clean audit. CI runs this as a separate step on both
platforms; `pnpm check` needs no advisory service.

Three exact parent-scoped overrides pin minimatch 11.0.1 for ESLint 10.14.0,
config-array 0.23.5 and typescript-estree 8.72.1. They address
[GHSA-g3hv-75wg-m249](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249).
The parents request version 10, so this major-version override carries a
compatibility risk. Focused tests exercise their actual glob, ignore, lint and
project-service consumers; strict engine/peer checks remain enabled. Remove the
overrides when compatible parent releases admit a patched dependency. This
development-tool finding does not demonstrate application exploitability.

The 0.0.0 contract remediation adds explicit primary symbol/step evidence IDs,
nullable diagnostic source paths and versioned per-capability coverage, and
normalizes UUIDs. Repository consumers and fixtures change together. Use the
request-aware `parse*Result` exports when request context is available;
standalone schemas cannot verify selection, traversal direction or continuation
position by guessing missing context. See the architecture document for exact
guarantees and the separation between structural checks and future source-byte
verification.

## Try the semantic proof

After `pnpm build`, run `pnpm --silent demo:semantic` for a JSON trace through
three source-pinned files, or `pnpm --silent eval:semantic` for the
independently authored fixture labels, measured denominators and separately
reported input rejections. The annotations were authored by Codex and have not
been independently reviewed. A passing sample does not establish general
TypeScript accuracy or comprehension improvement.

Run `pnpm --silent eval:external` after building to evaluate two small,
source-pinned public repository subsets and inspect bounded investigation
results. Their source selection, licenses, pre-prediction annotations and
investigation questions are in `fixtures/external/README.md`. The labels are not
independently reviewed, and subset coverage is not repository coverage.

Programmatic consumers provide a repository UUID, the exported
`COMPILER_PROFILE`, and files containing POSIX paths, raw UTF-8 bytes and
SHA-256 hashes to `analyzeManifest` from `@codethread/symbol-indexer`. The
returned immutable facts and verified source reader are passed to
`createInvestigation` from `@codethread/trace-engine`. Select a symbol from the
facts, then call `neighbors`, `paths` and `sourceEvidence` with their existing
snapshot-scoped contracts. `readFile` returns a defensive byte copy.

This slice recognizes named function declarations with bodies and direct
identifier calls, including local calls, named relative import aliases and
recursion. It also emits narrowly scoped `REFERENCES` facts when a noncomputed
method property is passed directly as a call argument and the compiler selects
one source method declaration. These facts carry exact source evidence and do
not claim a call, successful handler registration or runtime execution. Computed
access, accessors, overloads, ambiguous or unavailable targets, and unsupported
owners remain explicit unknowns. Path and neighbor queries include `CALLS` by
default; callers must select relation kinds to traverse references. Limits, the
compiler profile, ownership rules and error behavior are documented in the
architecture; no source or repository script is executed.

## Textual investigation

Use the bounded CLI to inspect one immutable manifest without reading source
paths from the analyzed repository or running its code. A manifest is UTF-8 JSON
with exactly this shape:

```json
{
  "version": 1,
  "repositoryId": "00000000-0000-4000-8000-000000000012",
  "files": [
    {
      "path": "src/example.ts",
      "sha256": "<lowercase SHA-256 of the original bytes>",
      "contentBase64": "<base64 of the original bytes>"
    }
  ]
}
```

Paths are source identities, not disk paths. Include each required source file's
original bytes; hashes are checked by the analyzer. The CLI accepts up to 20
files, 256 KiB per file, 2 MiB total source, and a 3 MiB manifest. It enforces
strict UTF-8, unique JSON keys, canonical base64 and safe POSIX paths, then uses
the fixed compiler profile. Invalid manifests fail with a typed error.

Run a prepared, byte-pinned example with `pnpm --silent demo:investigation`, or
provide your own manifest with
`pnpm --silent investigate -- --manifest ./manifest.json`. In either session,
start with `help`. Copy source selectors exactly as printed; they are
JSON-quoted tokens so unusual legal paths remain safe and reversible.
Interactive command errors leave the prompt available; piped sessions stop on
error with a typed diagnostic and nonzero exit status. The reproducible todo
flow is:

```text
symbols controllers/todo.controller.ts
inspect routes/todo.router.ts@4:1 references outgoing
follow controllers/todo.controller.ts@10:3 references incoming
evidence symbol controllers/todo.controller.ts@10:3
quit
```

`inspect` defaults to `calls`; include `references` explicitly to see method
references. Results label each relation kind, show verified occurrence and
declaration excerpts with source hashes, and retain typed unknowns and query
truncation. `follow` is limited to an exact target shown by the previous
inspection and reuses the in-memory analysis. Select symbols by
`path@line:column`; `name:<name>` works only when the name is unique. Static
references do not assert execution, registration success or runtime dispatch.
The session is bounded to 100 commands and 64 KiB of text per response.

For repeated source positioning, own one immutable
`createSourcePositionIndex(source)` per file and reuse its `positionAt` and
`validateRange` methods. The convenience `positionAt(source, offset)` and
`validateSourceRange(source, range)` interfaces remain available. Opt in to
`pnpm bench:positions` after building to compare bulk lookup and range
validation with index construction included. The JSON records three samples,
synthetic dataset hashes, tool/CPU information and Git state. Timings are local
evidence, not CI assertions or analyzer scalability claims.

## Requirements

Each YAML file is one requirement. `requirements/schema.json` owns its shape.
Lifecycle (`proposed`, `accepted`, `deprecated`) describes product agreement,
not implementation completion. Priority (`must`, `should`, `could`) describes
product criticality, not Issue scheduling. Optional test references must point
to real tests; their existence does not establish successful execution.

```sh
pnpm req:validate
pnpm req:list
pnpm req:show CT-DB-014
pnpm --silent req:context CT-DB-014
```

All commands return JSON. Use `--silent` for agent consumption through pnpm. The
context command includes the selected requirement, dependency records, module
and canonical references; it caps dependency depth at two, records at twenty,
and total UTF-8 output at 65,536 bytes including the newline. Omissions are
explicit. It fails if the selected record and mandatory envelope cannot fit.
Errors go to stderr as JSON; invalid content or unknown IDs exit 1, usage errors
exit 2.

## Work tracking and review

The repository is
[hungthinh1104/CodeThread](https://github.com/hungthinh1104/CodeThread). Use
GitHub Issues/Projects as the execution-tracking source of truth. A Project uses
**Backlog → Ready → In Progress → Review → Done**, plus Blocked and Cancelled,
and add priority, module, dependency and parent-epic fields. Use the provided
Epic, Task and Bug forms; link stable requirement IDs, blockers and PRs. Keep
lifecycle in YAML and task status in GitHub. Definition of Done includes
acceptance evidence, applicable checks, documented limitations and review.
Prepared Actions workflows must be run on the remote before claiming hosted CI
success.

The authoring sources are this README, `product.yaml`, requirement YAML/schema,
`docs/architecture.md`, significant decisions and `AGENTS.md`. Keep execution
reports in review/Issue discussions; do not add competing progress documents.

## Evidence and next gate

Model/contract tests verify schema invariants. The semantic corpus exercises a
small declared subset, with authored but not independently reviewed labels; it
cannot establish general extraction accuracy or comprehension effectiveness.
PostgreSQL integrity, migration, concurrency, performance and restore evidence,
independent semantic review and a human study remain separate milestones.

After reviewing Foundation + DB-01, explicitly approve DB-02 before creating the
database package, PostgreSQL Compose service, Drizzle schema or any migration.
The bounded semantic slice is allowed before database implementation by
ADR-0003. Broader CT-INDEX-001 capabilities, including import and reference
occurrence facts, remain separate work.
