# CT-REALWORLD-001 source-pinned engineering evaluation

## Purpose and boundary

This protocol evaluates CodeThread's bounded repository-to-browser workflow on
three external TypeScript repositories at immutable commits. It measures task
completion and source-grounded static relationships separately. It does not
measure runtime behavior, passing tests in the analyzed repositories, human
comprehension, developer productivity, or general TypeScript accuracy.

The external task bank has 15 prompts and 28 pre-prediction labels. Two
supplementary CodeThread self-repository workflows exercise monorepo project
contexts and are excluded from the external semantic score. The labels were
authored by AI after reading pinned Git blobs and are awaiting independent human
review. They are not suitable as independently reviewed research gold.

The 2026-11-12 result record is [run-2026-11-12.md](./run-2026-11-12.md), tied
to code candidate `ab41baa42b755b845b744445d0089b70635df08c`.

## Pinned corpus and source handling

`repositories.json` records repository URLs, discovery refs, exact commit and
tree IDs, regular committed `.ts` inventories and byte totals, license evidence,
all package and TypeScript project metadata blob IDs, and source file SHA-1 and
SHA-256 anchors. Each external repository is below the repository-mode limits of
1,000 files and 32 MiB. `.tsx`, JavaScript, generated files, and ambient machine
types are outside this corpus.

Resolve the requested revision once and analyze only regular blobs from that
commit. Read project configuration and workspace metadata only from their pinned
Git blobs. Do not substitute working-tree contents. Do not run scripts, tests,
package managers, or dependency installation in the analyzed repositories.
CodeThread's own pinned checkout and installed CodeThread dependencies are
separate from the analyzed repositories.

The CodeThread supplementary case uses commit
`0fd2fc9169d091afa1c8e0bdb4697d13c22c9a05`, the merge of PR #31. It is a
self-repository integration check, not an independent external benchmark.

## Freeze before prediction

1. Validate `repositories.json` and `tasks.json` structurally and verify each
   referenced blob, source line, and task label against its pinned commit.
2. Commit this complete packet before running CodeThread on Hono, Zod, or Pinia.
   Record the gold commit SHA and SHA-256 of both JSON files in the run record.
3. Do not alter prompts or labels after observing predictions. If a source
   transcription error is found, stop scoring, record the correction and reason
   in a new version, then freeze that version before restarting predictions.
4. Record the exact analyzed SHA and project/context selection for each run.

## Task execution

Use the repository-scope CLI with an explicit local Git repository and exact
commit for each external task unit:

```text
pnpm investigate -- --repo <local-git-repository> --revision <pinned-commit> --scope repository --view
```

Complete the prompt through the browser viewer where the task specifies browser
workflow steps. Record symbol search, context selection, graph traversal,
declaration opening, evidence inspection, and navigation completion separately.
Use the selected package/project context shown by CodeThread; never combine
separate contexts to manufacture a path. Record failures and incomplete scope as
such. A failed or truncated inventory is not a completed repository task.

For the CodeThread supplementary case, execute the two fixed-anchor workflows in
`tests/realworld-self-browser.ts` against its pinned commit. They locate
`analyzeManifest` and its implementation, package export and focused test, then
select the symbol-indexer project context and follow `analyzeProject` to
`planRepositoryProjects`. The runner opens and hashes declaration and call-site
evidence, and checks export/test locations against pinned Git blobs. Keep these
as integration workflow observations outside external accuracy denominators.

## Reproducible local runners

Run the frozen external prompt workflows through the actual repository CLI and
browser viewer with:

```text
pnpm exec node tests/realworld-browser.ts
```

By default the runner reads local Git repositories from
`.tooling/ct-realworld-sources/<key>`. Set `CT_REALWORLD_SOURCE_ROOT` to use a
different parent directory. `CT_REALWORLD_REPOSITORIES=hono,zod,pinia` can
select a subset for diagnosis; only an unfiltered run covers all 15 tasks.
`CT_REALWORLD_OUTPUT_PATH` writes the sanitized JSON result to a local file. The
runner verifies each pinned commit, selects the documented project context, uses
the UI for symbol search, relationship filtering, occurrence evidence and
declaration evidence, and checks evidence hashes against `repositories.json`. It
exits nonzero for incomplete task workflows or wrong-exact output. It is a
scripted single-operator workflow, not an independent human study or gold
review.

Run the supplementary CodeThread self-repository browser workflows separately:

```text
pnpm exec node tests/realworld-self-browser.ts
```

This runner analyzes only the regular `.ts` blobs at CodeThread commit
`0fd2fc9169d091afa1c8e0bdb4697d13c22c9a05`, selects
`packages/symbol-indexer/tsconfig.json`, and reports two scripted browser tasks.
Its output records the tested product SHA and worktree state separately from the
pinned analyzed SHA. These tasks do not alter `tasks.json` or the external
15-task/28-label score.

Collect all-project-context observation counts and available acquisition, phase,
Git operation and memory metrics with:

```text
pnpm exec node tests/realworld-analysis-profile.ts
```

This profiling runner calls CodeThread's repository analysis service directly on
the same pinned Git objects; it does not launch scripts or dependencies from the
analyzed repositories. Observation totals count each project-context membership
separately. Profiling and browser workflow timings are reported as separate
measurements.

The terminal-navigation comparator is:

```text
pnpm exec node tests/realworld-navigation-baseline.ts
```

It uses only `git grep` and `git show` against the same pinned commits, then
checks retrieved source lines against the frozen label anchors. Its timings
cover scripted Git command and validation latency, not human reading or
comprehension. Treat it as a reproducible terminal lookup baseline; it is not an
independent answer-generation benchmark or a human productivity comparison.

## Scoring and denominators

For every task, capture the immutable output and record the following counts
separately:

- **Tasks completed:** completed prompts divided by 15 external prompts; report
  the two supplementary CodeThread workflows separately.
- **Gold labels:** the number of exact and non-exact source-occurrence labels
  frozen in `tasks.json` (28 for this version).
- **Analyzer observations:** the number of relationship observations emitted by
  CodeThread for the analyzed source/context, including unresolved, ambiguous,
  unsupported, or owner-unavailable outcomes. Do not substitute the gold-label
  count for this total.
- **Wrong-exact:** an exact target with a wrong source owner, target, relation
  kind, occurrence, file, or source evidence; also any exact relationship at a
  label marked non-exact/no-exact.
- **Supported miss:** a frozen exact label with no corresponding exact
  observation at the pinned occurrence.
- **Non-exact preservation:** whether expected non-exact sites stay unresolved,
  ambiguous, unsupported, or without an owned relation instead of being promoted
  to an exact edge.
- **Workflow completion:** whether each requested search, context choice,
  declaration/evidence view, and navigation action completed. Workflow success
  does not imply semantic correctness.

Match by pinned file path, occurrence range, relation family, and symbol
declarations, not by symbol name alone. Repeated occurrences remain separate. Do
not count a static CALLS or REFERENCES edge as proof of execution, registration,
test success, or actual runtime dispatch.

## Operational evidence

For each repo, record the task-run start/end time and CLI exit code; inventory
completeness and truncation; selected project contexts; source bytes; Git
operation counts; phase timings; and observed parent/worker RSS where the
existing CLI exposes them. State measurement boundaries and unavailable fields
explicitly. Do not estimate a missing measurement from source size or CI time.

Run an equivalent conventional source-navigation baseline on the same frozen
prompts and source SHAs. This is a single-operator engineering comparison, not a
participant study or independent human result. Report navigation completion
separately from CodeThread semantic labels.

## Reporting limits

Report results per repository, exact task/label/observation denominators, source
SHA, gold SHA, commands and exit codes, before/after artifacts, evidence gaps,
unsupported syntax, incomplete or failed workflows, and local versus hosted
checks. Any implementation fix requires a focused regression and rerun of the
unchanged frozen task bank at a new candidate SHA.

No participant recruitment or human-scored comprehension study is authorized by
this evaluation. Do not claim human benefit, independent gold review, universal
TypeScript support, execution semantics, or research effectiveness. The
appropriate outcome can remain blocked when the task bank is not independently
reviewed or when a required workflow, correctness, resource, or security gate
lacks evidence.
