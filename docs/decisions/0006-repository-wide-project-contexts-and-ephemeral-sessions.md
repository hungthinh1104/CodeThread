# ADR-0006: Repository-wide TypeScript project contexts and ephemeral sessions

Status: accepted for the bounded local MVP, 2026-11-11.

## Decision

Add a repository-scope investigation path over one resolved local Git commit. It
admits every regular `.ts` blob within the declared limit of 1,000 files and 32
MiB total source, and reads only bounded, hash-verified compiler and workspace
metadata from that commit. The default session repository ID is created for the
invocation and is not durable. Working-tree source, repository scripts, package
installation and ambient machine types are excluded.

Build each TypeScript project context over a virtual filesystem containing only
the admitted source, metadata and pinned compiler-library closure. Use the
pinned TypeScript compiler to interpret supported config options, relative
`extends`, project references, aliases and workspace package metadata. A
workspace specifier resolves only when the compiler and supplied metadata
establish a source path. Do not infer a `dist` to `src` mapping. Keep invalid
configurations, missing inputs, ambiguous workspace names and reference cycles
as diagnostics or failed project contexts.

Give every project context a separate snapshot. Hash its source, config,
metadata, roots, reference graph and workspace-resolution inputs as part of the
analysis identity. Run no more than 32 contexts and one worker at a time under
the shared repository limits. A file assigned to multiple projects appears in
each context; unassigned source enters a labeled default context. Continue
independent valid projects after one project fails.

Expose source inventory, per-file analysis, project success, compiler/type
context completeness, semantic coverage and query truncation as separate
statuses. The repository browser searches symbols across contexts but binds each
graph to one snapshot. Cross-context follow requires an exact declaration anchor
and matching source hash; multiple candidates require a user choice. History
includes project/snapshot/root/filter/direction/selection state, and stale
responses are discarded.

Keep the session and source bytes in process memory only. PostgreSQL, persistent
repository registration, durable analysis history and coordinated source cache
remain behind DB-02 and its separate approval/evidence gate. Closing the CLI
ends the session and loopback viewer.

## Alternatives considered

- **Merge facts from every tsconfig into one graph:** rejected because compiler
  options and module resolution can change a target at the same source
  occurrence. A merged graph would hide that context difference.
- **Use ambient types or installed workspace dependencies:** rejected because
  they are not pinned to the requested Git revision and would add host-specific
  or repository-controlled inputs.
- **Rewrite missing package outputs to source paths:** rejected unless the
  pinned TypeScript context proves a project source redirect.
- **Persist repository sessions immediately:** deferred. This MVP proves the
  repository-to-browser workflow without starting DB-02 or claiming durable
  provenance.
- **Analyze `.tsx`, JavaScript and dynamic dispatch:** deferred because this
  scope does not yet have pinned acceptance expectations for those semantics.

## Limits and evidence boundary

The repository source profile is 1,000 `.ts` files/32 MiB, at most 32 project
contexts, one active worker, a 2 GiB V8 heap ceiling and a 120-second session
deadline. Metadata, memberships, compiler facts, IPC and query output have
additional finite caps in `docs/architecture.md` and the shared resource
profile. The heap ceiling does not bound total RSS. An incomplete source set,
compiler context, semantic capability or query is not promoted to a complete
state by another passing status.

The synthetic 1,000-file/32-MiB profile benchmark measures this implementation
and reports its measurement scope; it is not evidence of performance on
arbitrary repositories. The whole-repository semantic corpora pin ufo and
sourcemaps commits and report source labels separately from unscored project
occurrences. Only labels fixed before predictions contribute to acceptance
counts. Post-prediction corrections remain visible in the report for audit and
are excluded from scored cases, exact denominators and closed-owner checks.
Their labels are Codex-authored and have not received independent human review.
The browser workflow tasks were written after analyzer predictions were
observed; they are usability checks, not a blind semantic gold set. No benchmark
or static graph proves runtime execution or improved comprehension.

The repository-scope mode uses the existing trusted-local-Git boundary in
ADR-0004. It does not defend against malicious Git metadata or a compromised
local Git executable. Unsupported tree layouts, unsafe paths and resource limits
fail closed. PostgreSQL and study claims remain unimplemented and unverified by
this decision.
