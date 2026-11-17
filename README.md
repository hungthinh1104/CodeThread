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

The repository supplies Foundation validation/tooling, the DB-01 logical design,
a bounded in-memory TypeScript semantic proof, pinned Git adapters for selected
files and whole-repository `.ts` scope, independent project-context analysis,
and an opt-in local PostgreSQL backend candidate with a persisted viewer
adapter. A general persistent frontend and Gemini integration remain gated. See
`product.yaml` and `docs/architecture.md` for scope, ownership and gates.

## PostgreSQL backend candidate (DB-02)

The opt-in local backend and PostgreSQL persistence implementation is an
authorized review candidate. This is **not** a deployed service or production
approved database. It preserves the existing semantic engine, project-scoped
analysis and exact source evidence.

See [backend setup, API and verification boundaries](docs/backend.md). Use a
disposable PostgreSQL database and never commit credentials.

## Developer setup

Use Node **24.22.2** and pnpm **12.16.1**. The compiler is TypeScript **6.0.3**;
dependencies and the lockfile are pinned. Foundation checks need no database;
backend integration and backup/restore verification use a disposable PostgreSQL
17 database. Vitest uses Vite internally as test tooling; Vite is not the
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

The opt-in browser proof uses test-only Playwright. For a local browser test,
install Chromium with `pnpm exec playwright install chromium`, then run
`pnpm test:browser`. Hosted CI installs Chromium on Windows and Ubuntu. The
viewer itself uses Node's built-in HTTP server and browser-native HTML/CSS/SVG;
it adds no runtime dependency or persistent application service.

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

Run `pnpm --silent eval:external` after building to evaluate the pinned tinyexec
and todo subsets plus all regular `.ts` files from ufo and sourcemaps. The
repository revisions, license hashes, labels and their review status are in
`fixtures/external/README.md`. Label counts, unscored project occurrences and
total static observations are reported separately. Labels are not independently
reviewed, and these pinned repositories do not establish universal TypeScript
coverage.

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

Use the bounded CLI with an immutable manifest or the local Git adapter. A
manifest is UTF-8 JSON with exactly this shape:

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
`pnpm --silent investigate -- --manifest ./manifest.json`. To inspect selected
files from a local commit, provide the repository UUID and explicit literal
paths:

```sh
pnpm --silent investigate -- --repo ./my-repository \
  --repository-id 00000000-0000-4000-8000-000000000012 \
  --revision HEAD --file src/main.ts --file src/target.ts
```

For a bounded, read-only inventory before selecting files, replace the `--file`
arguments with `--browse`:

```sh
pnpm --silent investigate -- --repo ./my-repository \
  --repository-id 00000000-0000-4000-8000-000000000012 \
  --revision HEAD --browse
```

In the source prompt, use `files [directory-prefix] [offset]`,
`search <literal> [offset]`, `select <file-path>`, `select-module <directory>`,
`selected [offset]`, then `analyze`. The inventory traverses verified
commit/tree metadata only; it reads no source blobs until a selection is
analyzed. Pages contain at most 50 rows. The inventory is limited to 1,000
TypeScript paths, 128 unique trees, 4,096 tree-path visits, 10,000 tree entries,
64 path components, 1 MiB per metadata object, 4 MiB total metadata and a
10-second Git deadline. Path/tree/result limits and unsupported paths are shown
as incomplete; module selection is then rejected because its membership cannot
be proven complete. Metadata-size and deadline violations return typed errors.
Selection remains bounded by 20 files, 256 KiB per file and 2 MiB total. Run
`pnpm bench:source-discovery` to reproduce the generated-tree measurements in
`docs/architecture.md`.

Add `--view` to that command to open the same selected commit and files in the
visual investigation session.

For the repository-wide MVP path, analyze every regular committed `.ts` blob and
its bounded compiler/workspace metadata at one pinned revision:

```sh
pnpm --silent investigate -- --repo ./my-repository \
  --revision HEAD --scope repository --view
```

`--repository-id <uuid>` is optional in this mode; if omitted, the CLI creates
an invocation-local ID. The repository profile admits up to 1,000 `.ts` files,
32 MiB total source, 32 project contexts, one active worker, a 2 GiB V8 heap
ceiling and a 120-second session deadline. Excluded symlink/gitlink `.ts` paths,
source-analysis failures, project/configuration errors and source/context
completeness appear in the paged browser inventory and diagnostics. Compiler
context, source coverage, semantic coverage and query truncation are separate
states.

Repository browser mode searches symbols across project contexts. Select a
project before graph queries; following a declaration across contexts requires
matching source path, range and hash. If multiple contexts contain the same
anchor, choose the destination explicitly. Back and Forward restore project,
snapshot, root, filters, direction and selections still present in the returned
projection.

The adapter supports full commit IDs, `HEAD`, and fully qualified local branch
or tag refs. It resolves the revision once, reads only selected committed `.ts`
blobs, and ignores dirty working-tree changes. Direct-file mode accepts literal
paths only. Browse mode can select a complete directory-backed module set from
its pinned inventory, but does not expand globs or discover import dependencies.
The repository root must have a real `.git` directory; bare repositories, linked
worktrees, symlinked Git metadata, and alternate object stores are rejected. No
checkout, filter, hook, repository script or dependency installation is run. The
developer is responsible for trusting the local Git executable and repository
metadata. Git commit/blob identities are reported as provenance; the analyzer's
existing manifest-based semantic identity is unchanged. In either session, start
with `help`. Copy source selectors exactly as printed; they are JSON-quoted
tokens so unusual legal paths remain safe and reversible. Interactive command
errors leave the prompt available; piped sessions stop on error with a typed
diagnostic and nonzero exit status. The reproducible todo flow is:

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

## Local visual investigation

For the same pinned todo sources in a browser, run `pnpm --silent demo:visual`.
The CLI prints an ephemeral `127.0.0.1` URL; open it in a browser and press
Ctrl+C in the CLI to stop the viewer. The browser lets you search
source-anchored symbols, select CALLS or REFERENCES explicitly, and inspect
verified occurrence/declaration evidence. Click or keyboard-activate SVG edges
to select that exact occurrence and open its evidence; activate a node to
inspect its declaration and choose whether to follow it. Parallel occurrences
remain separate. Selection reuses the current graph result, while following a
symbol or changing filters runs a new bounded query. Back restores only
selections and evidence still present in the returned snapshot. The accessible
relationship list provides the same path if a browser or assistive technology
handles SVG controls differently. Unknowns, coverage and truncation remain
visible; an empty bounded result is not proof of absence.

For a caller-owned manifest, append `--view` to the existing input command, for
example `pnpm investigate -- --manifest ./manifest.json --view`. Add `--view` to
the repository-scope command above to inspect the full source catalog. The
viewer binds only to IPv4 loopback, uses a per-session token and same-origin
checks, persists no data, loads no external resources and stops with the CLI. It
is a local investigation proof, not a general frontend or API service. See
CT-VIEW-001 and ADR-0005 for the security boundary and exact limits.

## Offline study toolkit

Validate the source-pinned comprehension task bank and run a deterministic
scoring demonstration:

```sh
pnpm --silent study:validate
pnpm --silent study:demo
```

Run `pnpm build` first from a fresh checkout; these standalone commands use the
compiled public `code-model` package. The repository setup flow runs
`pnpm check`, which builds before validating the task bank.

`study:validate` checks task structure, unique definitions, pinned fixture
bytes/hashes, Git blob IDs where supplied, UTF-16 source anchors, relation
kinds, assignments, parity, and review status. `study:demo` prints
`SYNTHETIC DRY RUN — NOT EMPIRICAL DATA`; it creates no result file and does not
represent a participant. After any separately authorized data collection, score
a local result document with:

```sh
pnpm --silent study:score -- ./local-study-data/results.json
```

Freeze the exact scoring build for a dataset from a clean committed checkout
before collection:

```sh
pnpm --silent study:provenance
```

The returned provenance binds the validated task bank, scoring policy and full
Git commit. Scoring requires the same clean commit as the dataset. A new commit,
changed task bank, changed policy, or old/missing result provenance is rejected;
there is no automatic historical rescore. A `tool_failure` remains a counted
failure but is excluded from objective denominators and missed-answer counts,
including any captured partial claims. The original result file is not changed.

Result files belong under the ignored `local-study-data/` directory. The scorer
validates the strict pseudonymous format and emits aggregates by task and
condition, including exploratory usability-rating counts, while omitting
participant tokens and answer text. Usability ratings do not affect objective
correctness. The scorer never scores free-text comprehension or unsupported
claims; those remain `AWAITING_HUMAN_SCORING`. The toolkit does not recruit
participants, collect answers, or authorize a study. See
[`docs/evaluation/protocol.md`](docs/evaluation/protocol.md) for the task
rubric, privacy limits, prerequisites, and reproducible pinned-source workflow.

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
The current operation inventory is in
[`docs/api/inventory.md`](docs/api/inventory.md); the implementation and DB/API
readiness evidence is in
[`docs/reviews/architecture-api-db-readiness.md`](docs/reviews/architecture-api-db-readiness.md).

## Evidence and next gate

Model/contract tests verify schema invariants. The semantic corpus exercises a
small declared subset, with authored but not independently reviewed labels; it
cannot establish general extraction accuracy or comprehension effectiveness.
PostgreSQL integrity, migration, concurrency, performance and restore results
remain separate from hosted CI, independent semantic review and human-study
evidence. DB-02 implementation was explicitly authorized for a local PR
candidate on 2026-11-13; this did not authorize production credentials,
deployment or automated merge. Require final-SHA CI and human review before
recommending PR merge. Broader CT-INDEX-001 capabilities, including import
occurrence facts, general references and dynamic dispatch, remain separate work.
