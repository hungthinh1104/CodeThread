# CT-TRACE-QUALITY-003 — Semantic Correctness & Coverage

## Decision

**Recommendation: NO-GO for merge. Keep PR #36 draft and unmerged.** The scoped
viewer regression is fixed and local gates pass, but Zod still has incomplete
source coverage and three reproducible resource failures. Hosted CI for the new
candidate SHA was not yet available when this report was written. The source
labels below are source-anchored but are not independently reviewed human gold.

This review covers the existing bounded TypeScript tracing pipeline and the
defect found while replaying its pinned-repository browser tasks. It does not
claim general TypeScript support, complete repository analysis, runtime
behavior, or human-study validation.

## Candidate and baseline

- Repository: `hungthinh1104/CodeThread`
- Branch: `feat/ct-mvp-release-001`
- Base: `main` at `b61a0170811f5b0a6d037314bb76bccc354f3380`
- PR baseline: `f6ad8047809a8168b21a539531262f5e78522838`
- Code-fix SHA measured below: `13566a6a44bebef8c6752c8f2b8b55e197c29451`
- Final clean profile/browser SHA: `a85035150cca742befc6a7ced0955f2696cac607`
- Source manifest SHA-256:
  `de14e354a9d2151f74736ab827cb746a534967b8f241f6dc427928aa59828de9`

The working tree was clean at both measured candidate SHAs. `a850351` adds this
review document on top of the code-fix commit and changes no product source.
`origin/main` remained `b61a0170811f5b0a6d037314bb76bccc354f3380`; the existing
PR check run #183 passed on `f6ad804...` only and is stale for this candidate.

## Confirmed defect and fix

At baseline `f6ad804`, the pinned real-world browser run failed before its first
task: `/api/projects` returned HTTP 500 with
`Viewer response failed contract validation.` Directly planning the pinned Hono,
Zod, and Pinia projects and parsing their actual response values reproduced the
mismatch: 3 Hono, 2 Zod, and 6 Pinia project responses contained diagnostics
with a config `path` that the item-level strict schema rejected.

In [`scripts/viewer-api.ts`](../../scripts/viewer-api.ts#L24), the shared
diagnostic schema already accepts an optional `path`; the project-item schema
had a duplicate strict `{ code, message }` shape. The fix at line 64 reuses
`projectDiagnosticSchema` and retains the existing 10-diagnostic bound.
[`tests/repository-viewer.test.ts`](../../tests/repository-viewer.test.ts#L85)
now makes a real HTTP request with an invalid project diagnostic and asserts
status 200 and exact path preservation.

The focused test was red at the baseline (7 passed, 1 failed because the
response was 500) and green after the fix (8/8). A clean browser replay on
`13566a6` then completed all 15 pinned Hono/Zod/Pinia tasks, with 22/22 expected
exact labels observed, zero wrong exact edges, and zero supported misses. The
run used only pinned source revisions. Its labels remain Codex-authored and
unreviewed by humans.

Two separate internal review passes over the one-commit diff found no additional
confirmed spec defect or documented-standards violation. They are not human PR
approval.

## Pinned whole-repository profile

The same three pinned Git commits were profiled at baseline `f6ad804` and clean
candidate `a850351`. Counts and coverage status were unchanged. Profile wall
time and peak memory are single-machine measurements, not a performance claim;
the final Zod run was slower than the baseline run and showed high parent RSS.

| Repository and source commit                     | Inventory / source coverage                                     | Ready / total contexts | Failed / unanalyzed | Context observation memberships | Baseline → candidate wall time | Candidate result bytes |
| ------------------------------------------------ | --------------------------------------------------------------- | ---------------------: | ------------------: | ------------------------------: | -----------------------------: | ---------------------: |
| Hono `f6fbaf0299c48eea9e656e03e2ffe7ac755e8823`  | 399/399; complete                                               |                  20/24 |               0 / 0 |                          42,991 |               26.36s → 32.216s |             48,741,315 |
| Zod `19c40d2072288b4cafec851e9d056a72a88e5973`   | inventory complete; source coverage incomplete (38/477 omitted) |                  16/21 |              3 / 38 |                          83,088 |              60.286s → 98.215s |            107,104,675 |
| Pinia `4817135a25431172d363bd928476db7cdbf875c4` | 120/120; complete                                               |                    3/8 |               0 / 0 |                           4,948 |                 4.84s → 5.726s |              6,471,336 |

For all three repositories, `analysisComplete` and `contextComplete` were false.
A “ready” context is not a complete repository result. Membership counts sum
per-context observations; they are not unique call sites or accuracy scores.
Pinia's reported parent RSS is a process high-water mark shared with prior
profiles and must not be attributed to Pinia alone.

### Zod resource failures and coverage boundary

The three failed contexts are confirmed as:

| Config                            | Root files | Failure                                                                          |
| --------------------------------- | ---------: | -------------------------------------------------------------------------------- |
| `tsconfig.json`                   |        467 | `RESOURCE_LIMIT`: `Relationship site limit exceeded`                             |
| `packages/zod/tsconfig.json`      |        333 | `RESOURCE_LIMIT`: `Retained project results exceed the repository session limit` |
| `packages/zod/tsconfig.test.json` |        333 | `RESOURCE_LIMIT`: `Retained project results exceed the repository session limit` |

The first failure is consistent with the existing 50,000 call-site bound in
[`packages/code-model/src/resources.ts`](../../packages/code-model/src/resources.ts#L46):
extraction counts every TypeScript `CallExpression` node at
[`packages/symbol-indexer/src/extract.ts`](../../packages/symbol-indexer/src/extract.ts#L59),
then returns the resource diagnostic when the observation count exceeds the
bound at lines 724–729. The other two failures hit the existing aggregate 128
MiB retained-result bound at
[`packages/symbol-indexer/src/project-types.ts`](../../packages/symbol-indexer/src/project-types.ts#L58)
and
[`scripts/investigation/repository-session.ts`](../../scripts/investigation/repository-session.ts#L147).
The default project deadline remains 120,000 ms at
[`packages/symbol-indexer/src/project.ts`](../../packages/symbol-indexer/src/project.ts#L9);
the final Zod profile took 98,215 ms, so it completed inside the deadline with
about 22 seconds of headroom.

The final `a850351` Zod profile reached 1,190,461,440 bytes parent peak RSS and
1,062,563,840 bytes maximum worker peak RSS (about 1,135 MiB and 1,013 MiB). The
preceding clean profile at `13566a6` measured 1,005,846,528 parent peak bytes
and 1,049,509,888 maximum worker peak bytes. Counts were identical, but these
differing memory peaks mean the lower reading is not a dependable capacity
bound. This is Windows-only evidence, and the parent high-water mark can include
the profile process's prior repository work. The parent peak exceeds 1 GiB; the
worker peak is about 1,013 MiB. The resource failures and 38 omitted files are
not hidden or treated as complete. No limits were raised, diagnostics removed,
or relationships discarded to improve reported coverage.

The 38 omitted paths all report the root `tsconfig.json` resource failure:

```text
packages/treeshake/bundle-size.test.ts
packages/treeshake/default-locale.test.ts
packages/treeshake/example-mini.ts
packages/treeshake/example.ts
packages/treeshake/locale-treeshake.test.ts
packages/treeshake/valibot-boolean.ts
packages/treeshake/valibot-object.ts
packages/treeshake/valibot-simple-object.ts
packages/treeshake/valibot-string.ts
packages/treeshake/zod-boolean.ts
packages/treeshake/zod-default-import.ts
packages/treeshake/zod-full.ts
packages/treeshake/zod-locale.ts
packages/treeshake/zod-locales.ts
packages/treeshake/zod-mini-boolean.ts
packages/treeshake/zod-mini-full.ts
packages/treeshake/zod-mini-object.ts
packages/treeshake/zod-mini-simple-object.ts
packages/treeshake/zod-mini-string.ts
packages/treeshake/zod-named-import.ts
packages/treeshake/zod-object.ts
packages/treeshake/zod-string.ts
packages/treeshake/zod3-boolean.ts
packages/treeshake/zod3-full.ts
packages/treeshake/zod3-object.ts
packages/treeshake/zod3-string.ts
play.ts
scripts/check-comments.ts
scripts/check-lockstep.ts
scripts/check-semver.ts
scripts/check-versions.ts
scripts/compile-fuzz.ts
scripts/enable-compile.ts
scripts/fail-on-console.ts
scripts/triage-signal.ts
scripts/update-iso-4217.ts
scripts/write-stub-package-jsons.ts
vitest.compile.config.ts
```

The other invalid/unsupported project contexts remain separate from these
resource failures. For example, the pinned Zod profile includes `TS_18003` and
`PROJECT_SOURCE_MISSING` configuration diagnostics; these are not counted as
successfully analyzed contexts.

## Source-anchored exact sample

Expected relationships were checked against bytes acquired from the exact
commits above, with the source and target content hashes recorded by the run.
The oracle is the explicit source declaration/call-site mapping below,
independent of CodeThread's projected result; the labels are not independent
human gold. These rows list caller owner, target declaration, and call site. SHA
aliases map to complete source-content hashes immediately after the table.

| Label        | Caller owner                                          | Target declaration                                    | Call site                                             | Caller SHA / target SHA |
| ------------ | ----------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------- | ----------------------- |
| `hono-01-a`  | `src/middleware/language/language.ts:153`             | `src/middleware/language/language.ts:74`              | `src/middleware/language/language.ts:160`             | H-LANG / H-LANG         |
| `hono-03-a`  | `src/utils/color.ts:36`                               | `src/utils/color.ts:14`                               | `src/utils/color.ts:53`                               | H-COLOR / H-COLOR       |
| `hono-04-a`  | `src/utils/jwt/jws.ts:29`                             | `src/utils/jwt/jws.ts:122`                            | `src/utils/jwt/jws.ts:34`                             | H-JWS / H-JWS           |
| `hono-04-b`  | `src/utils/jwt/jws.ts:29`                             | `src/utils/jwt/jws.ts:54`                             | `src/utils/jwt/jws.ts:35`                             | H-JWS / H-JWS           |
| `hono-05-a`  | `src/utils/jwt/jws.ts:78`                             | `src/utils/jwt/jws.ts:108`                            | `src/utils/jwt/jws.ts:86`                             | H-JWS / H-JWS           |
| `hono-05-b`  | `src/utils/jwt/jws.ts:78`                             | `src/utils/jwt/jws.ts:108`                            | `src/utils/jwt/jws.ts:93`                             | H-JWS / H-JWS           |
| `zod-01-a`   | `packages/zod/src/v4/classic/from-json-schema.ts:132` | `packages/zod/src/v4/classic/from-json-schema.ts:128` | `packages/zod/src/v4/classic/from-json-schema.ts:147` | Z-JSON / Z-JSON         |
| `zod-02-a`   | `packages/zod/src/v4/classic/from-json-schema.ts:223` | `packages/zod/src/v4/classic/from-json-schema.ts:223` | `packages/zod/src/v4/classic/from-json-schema.ts:237` | Z-JSON / Z-JSON         |
| `zod-02-b`   | `packages/zod/src/v4/classic/from-json-schema.ts:223` | `packages/zod/src/v4/classic/from-json-schema.ts:223` | `packages/zod/src/v4/classic/from-json-schema.ts:246` | Z-JSON / Z-JSON         |
| `zod-03-a`   | `packages/zod/src/v4/classic/from-json-schema.ts:390` | `packages/zod/src/v4/classic/from-json-schema.ts:132` | `packages/zod/src/v4/classic/from-json-schema.ts:430` | Z-JSON / Z-JSON         |
| `zod-03-b`   | `packages/zod/src/v4/classic/from-json-schema.ts:390` | `packages/zod/src/v4/classic/from-json-schema.ts:808` | `packages/zod/src/v4/classic/from-json-schema.ts:431` | Z-JSON / Z-JSON         |
| `zod-04-a`   | `packages/zod/src/v4/classic/from-json-schema.ts:917` | `packages/zod/src/v4/classic/from-json-schema.ts:105` | `packages/zod/src/v4/classic/from-json-schema.ts:931` | Z-JSON / Z-JSON         |
| `zod-04-b`   | `packages/zod/src/v4/classic/from-json-schema.ts:917` | `packages/zod/src/v4/classic/from-json-schema.ts:808` | `packages/zod/src/v4/classic/from-json-schema.ts:943` | Z-JSON / Z-JSON         |
| `zod-05-a`   | `packages/zod/src/v4/core/util.ts:809`                | `packages/zod/src/v4/core/util.ts:830`                | `packages/zod/src/v4/core/util.ts:826`                | Z-UTIL / Z-UTIL         |
| `zod-05-b`   | `packages/zod/src/v4/core/util.ts:837`                | `packages/zod/src/v4/core/util.ts:830`                | `packages/zod/src/v4/core/util.ts:841`                | Z-UTIL / Z-UTIL         |
| `pinia-01-a` | `packages/pinia/src/store.ts:81`                      | `packages/pinia/src/store.ts:81`                      | `packages/pinia/src/store.ts:107`                     | P-STORE / P-STORE       |
| `pinia-02-a` | `packages/pinia/src/store.ts:153`                     | `packages/pinia/src/store.ts:218`                     | `packages/pinia/src/store.ts:213`                     | P-STORE / P-STORE       |
| `pinia-03-a` | `packages/pinia/src/store.ts:930`                     | `packages/pinia/src/store.ts:218`                     | `packages/pinia/src/store.ts:952`                     | P-STORE / P-STORE       |
| `pinia-03-b` | `packages/pinia/src/store.ts:930`                     | `packages/pinia/src/store.ts:153`                     | `packages/pinia/src/store.ts:954`                     | P-STORE / P-STORE       |
| `pinia-03-c` | `packages/pinia/src/store.ts:930`                     | `packages/pinia/src/store.ts:218`                     | `packages/pinia/src/store.ts:969`                     | P-STORE / P-STORE       |
| `pinia-03-d` | `packages/pinia/src/store.ts:930`                     | `packages/pinia/src/store.ts:153`                     | `packages/pinia/src/store.ts:970`                     | P-STORE / P-STORE       |
| `pinia-04-a` | `packages/pinia/src/store.ts:291`                     | `packages/pinia/src/subscriptions.ts:26`              | `packages/pinia/src/store.ts:327`                     | P-STORE / P-SUBS        |

| Alias   | Pinned source file                                    | SHA-256                                                            |
| ------- | ----------------------------------------------------- | ------------------------------------------------------------------ |
| H-LANG  | Hono `src/middleware/language/language.ts`            | `4351ca778ede62e456fd79c8168aaab7a1ef5cb24be375024cb59e196c1c9203` |
| H-COLOR | Hono `src/utils/color.ts`                             | `48f18beb7e38cf8a172be4258e1f37fd8ba9eede0316e9eb455847fdabbf6ffc` |
| H-JWS   | Hono `src/utils/jwt/jws.ts`                           | `2bc32fc107bdd63cde3fbcea71fd7a62184c211792a3754d14abad559bd1448d` |
| Z-JSON  | Zod `packages/zod/src/v4/classic/from-json-schema.ts` | `1b27140e0709c0cc65786808c2f929289c980bc6c3142264860bdffac8b0cdf6` |
| Z-UTIL  | Zod `packages/zod/src/v4/core/util.ts`                | `f457744f5cf871340ae9699dfb72c4824d2ab3029838c8d88c6a1a45dcb6ce26` |
| P-STORE | Pinia `packages/pinia/src/store.ts`                   | `6c25e9116fad56e1ffd7e45474af982dc829ad97ce11a7ea96ee7917d01ed08f` |
| P-SUBS  | Pinia `packages/pinia/src/subscriptions.ts`           | `39d0ebbab525b6f40d7a4e6c92e6b24341464852e90f36ceefa85d24be73f532` |

Additional directly inspected boundaries include Zod's two recursive calls to
`fromJSONSchema` at lines 237 and 246 targeting the same declaration at line
223, and Pinia's recursive `mergeReactiveObjects` call at line 107 targeting
line 81. A callback parameter such as `target.add` passed to `forEach` remains
non-exact because it has no body-bearing repository declaration. For Hono,
`parseAcceptLanguage` calls `parseAccept` at
`src/middleware/language/language.ts:74`; `parseAccept` is an arrow variable at
`src/utils/accept.ts:211`, and that callback/declaration distinction is retained
as non-exact in the negative sample.

The final `a850351` browser JSON artifact SHA-256 is
`0e9348dc3e7ed71a39dfb31fa330b8628842d86f21a30f0ca3eddb76a6611148`; the final
profile JSON artifact SHA-256 is
`f578a7b4ed3b014409e47b05590e47ae975b8a2316eedd556854b123c9fdb7f8`. The
artifacts were generated in the local temporary directory and are not committed;
the source identities and exact sample are reproduced in this report.

## Frozen semantic evaluations

`pnpm eval:semantic` passed on `a850351`: 13/13 eligible supported exact
resolutions, zero incorrect exact, zero missed resolvable, and 17/30 supported
occurrences. The other 13 are explicitly unsupported; unresolved and ambiguous
occurrences remain separately counted. Source evidence mismatches were zero.
This frozen corpus was authored by Codex and is not independently reviewed.

`pnpm eval:external` exited 0 for all four pinned external cases. The source
labels and authored-before-prediction statuses vary by corpus; `ufo` reports 4/4
labeled cases correct and `sourcemaps` reports four scored correct cases plus
one post-prediction correction excluded from scoring. These results are narrow
static-source evidence, not repository-wide accuracy or runtime behavior.

## Verification evidence

Commands below used pinned Node `24.22.2` and pnpm `12.16.1`. The general
checks, semantic/external/browser evaluations, security audit, profile, and
real-world browser replay were rerun on clean SHA
`a85035150cca742befc6a7ced0955f2696cac607`. The PostgreSQL suite ran on code SHA
`13566a6a44bebef8c6752c8f2b8b55e197c29451`; `a850351` changes only this review
document, not the tested runtime code.

| Command / check                         | Result                                                                                  | Evidence boundary                                                                                                                                                                           |
| --------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`                            | PASS — 49 files passed, 18 skipped; 551 tests passed, 88 skipped                        | PostgreSQL-only tests were skipped because this run had no test DB URL; those tests were run separately below.                                                                              |
| `pnpm eval:semantic`                    | PASS — 13/13 eligible exact, 0 incorrect, 17/30 supported                               | Codex-authored labels, not independent human gold.                                                                                                                                          |
| `pnpm eval:external`                    | PASS — four pinned corpus gates                                                         | Labels are not all independently reviewed; capability coverage remains partial.                                                                                                             |
| `pnpm test:browser`                     | PASS                                                                                    | Pinned source navigation, context separation, occurrence evidence, history/recovery, and safe rendering workflows passed; tasks are not human-study evidence.                               |
| `pnpm security:check`                   | PASS — no known vulnerabilities found                                                   | `pnpm audit --audit-level=low`.                                                                                                                                                             |
| PostgreSQL-backed integration selection | PASS — 16 files, 80 tests passed, 1 file and 5 tests skipped                            | PostgreSQL 17.12; isolated database `codethread_cttrace_003` in a disposable local container. Migration reached schema 7; runtime grants passed twice. Windows-specific skips are retained. |
| Pinned real-world browser replay        | PASS — 15/15 tasks; 22 exact expected/observed; zero wrong exact; zero supported misses | Clean working tree and exact SHA `a850351`; Hono/Zod/Pinia source commits listed above; labels unreviewed by humans.                                                                        |
| Pinned whole-repository profile         | PASS as a reproducible profile; Zod coverage remains incomplete                         | Clean working tree and exact SHA `a850351`; see profile table and Zod failure detail above.                                                                                                 |
| Hosted Ubuntu / Windows / PostgreSQL CI | NOT VERIFIED for `a850351` at report time                                               | Run #183 passed only on stale PR head `f6ad804`. A fresh hosted run is required after publishing the final report commit.                                                                   |
| Human gold review / human PR approval   | NOT VERIFIED                                                                            | PR #36 remains draft; no human approval is claimed.                                                                                                                                         |

## Acceptance matrix and residual risk

| Acceptance                                                       | Status                      | Notes                                                                                                                |
| ---------------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Zero incorrect exact relationships in source-anchored sample     | PASS                        | 22/22 expected exact labels observed; zero wrong exact and zero supported misses.                                    |
| No semantic evaluation or source-provenance regression           | PASS                        | Baseline and candidate semantic score/profile coverage counts match; pinned content hashes are recorded above.       |
| Coverage and context readiness reported separately               | PASS                        | Inventory, source coverage, analysis completion, context completion, memberships, and failed contexts are distinct.  |
| Zod resource failure improved or reproducible blocker documented | PASS WITH LIMITATION        | Three resource failures and 38 omitted files reproduce; no safe optimization was demonstrated in this scoped change. |
| Full Zod source/context coverage                                 | FAIL                        | 38/477 files omitted; 3/21 contexts fail `RESOURCE_LIMIT`; other contexts are invalid or unsupported.                |
| Required local checks and relevant real-PostgreSQL tests         | PASS                        | Exact command results above.                                                                                         |
| Hosted CI on final PR SHA                                        | NOT VERIFIED at report time | Do not treat baseline run #183 as current evidence.                                                                  |
| Human-reviewed gold and PR approval                              | NOT VERIFIED                | Neither is claimed; PR stays draft.                                                                                  |

Residual risks: Zod's maximum worker peak RSS is about 1,013 MiB, observed
parent peak RSS was about 1,135 MiB, and the final profile took about 98 seconds
of the 120-second deadline on this Windows host. Cross-platform capacity,
broader TypeScript syntax, all repository configurations, human-reviewed labels,
and runtime behavior remain unverified. The browser replay proves only the
listed static source relationships for the three pinned commits.

**Merge recommendation: NO-GO.** Preserve the documented Zod partial coverage,
obtain exact-SHA hosted checks and human review before reconsidering. No merge,
deploy, force-push, or branch-protection bypass was performed.
