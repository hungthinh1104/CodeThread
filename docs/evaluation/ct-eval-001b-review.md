# CT-EVAL-001B Human Review Package — Draft

**Status:** Draft package prepared for independent human review. It is not an
independent review, approval, preregistration, or authorization to recruit
participants.

**Baseline:** current `main` / PR base is
`884e97964e2374e61b65174340d6614cf2bdc2ad` (merge commit for PR #19). PR #19
merged at that revision; its content CI
[41964366707](https://github.com/hungthinh1104/CodeThread/actions/runs/41964366707)
passed on Ubuntu and Windows for PR head
`95a2fd5033ef6266bae366e3e9139120e17af119`. That run is not evidence of a direct
run on the merge commit. This package is tracked by
[Issue #20](https://github.com/hungthinh1104/CodeThread/issues/20).

## Decision and gates

**Decision: BLOCKED for participant scoring, recruitment, and pilot readiness.**
PR #19 is merged. This remediation closes the two confirmed scorer risks by
censoring objective scoring for tool failures and requiring exact clean-commit
provenance. The answer keys still have not received independent review, and
institutional/academic approvals remain outstanding.

The source ledger below is a source re-audit by the same agent that authored the
provisional labels. Every answer key remains `AWAITING_INDEPENDENT_REVIEW`. No
participant data, observations, or empirical result is present.

## Pinned source and assertion ledger

All paths, source hashes, byte counts, revisions, and coordinates are defined in
[`tasks.json`](tasks.json). Local fixture bytes were checked against the pinned
repository sources; where supplied, Git blob IDs also matched. Coordinates are
one-based UTF-16, end-exclusive.

`study:validate` accepts five records: F1 and F2 are eligible with limitations,
F3 is exploratory only, and both rejected tasks remain rejected. The three
answer-key tasks contain nine assertions total. No task wording, answer key,
source fixture, or gold label was changed for this re-audit.

| Task / assertion   | Source anchor and expected relation                                                                                                                                                         | Verification and finding                                                                                                                                                                      | Confidence / review                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| CTE-F1-001 / F1-A1 | `routes/index.ts:14:11–23` `initialize()` → `config/passport.ts:64:1–67:2`; `CALLS`                                                                                                         | Pinned source and declaration reviewed; becomes exact when `config/passport.ts` is included. Does not establish initialization at runtime.                                                    | `SOURCE_VERIFIED_BY_AGENT`; independent answer-key review pending                           |
| CTE-F1-001 / F1-A2 | `routes/index.ts:40:20–32` `authRouter()` → `routes/auth.router.ts:4:1–9:2`; `CALLS`                                                                                                        | Pinned source reviewed; exact with the selected five-file closure.                                                                                                                            | `SOURCE_VERIFIED_BY_AGENT`; independent answer-key review pending                           |
| CTE-F1-001 / F1-A3 | `routes/index.ts:41:20–32` `userRouter()` → `routes/user.router.ts:4:1–12:2`; `CALLS`                                                                                                       | Pinned source reviewed; exact with the selected five-file closure.                                                                                                                            | `SOURCE_VERIFIED_BY_AGENT`; independent answer-key review pending                           |
| CTE-F1-001 / F1-A4 | `routes/index.ts:42:20–32` `todoRouter()` → `routes/todo.router.ts:4:1–17:2`; `CALLS`                                                                                                       | Pinned source reviewed; exact in the original two-file input.                                                                                                                                 | `SOURCE_VERIFIED_BY_AGENT`; independent answer-key review pending                           |
| CTE-F2-001 / F2-A1 | `routes/todo.router.ts:8:19–34` `toDoCtrl.getAll` → `controllers/todo.controller.ts:10:3–26:4`, owner `ToDoController`; `REFERENCES`                                                        | Expression is passed as an argument; the pinned declaration and browser/text evidence match. It is not a call edge or proof of dispatch.                                                      | `SOURCE_VERIFIED_BY_AGENT`; independent answer-key review pending                           |
| CTE-F2-001 / F2-A2 | `routes/todo.router.ts:11:22–37` `toDoCtrl.getOne` → `controllers/todo.controller.ts:28:3–40:4`, owner `ToDoController`; `REFERENCES`                                                       | Same evidence basis as F2-A1.                                                                                                                                                                 | `SOURCE_VERIFIED_BY_AGENT`; independent answer-key review pending                           |
| CTE-F2-001 / F2-A3 | `routes/todo.router.ts:14:20–35` `toDoCtrl.create` → `controllers/todo.controller.ts:42:3–60:4`, owner `ToDoController`; `REFERENCES`                                                       | Same evidence basis as F2-A1.                                                                                                                                                                 | `SOURCE_VERIFIED_BY_AGENT`; independent answer-key review pending                           |
| CTE-F3-001 / F3-A1 | `src/env.ts:73:45–75` `getPathFromEnv(envWithDefault)` → `src/env.ts:18:1–36:2`; exact `CALLS`                                                                                              | Exact call and declaration inspected in pinned `tinyexec` source and reproduced with the one-file manifest.                                                                                   | `SOURCE_VERIFIED_BY_AGENT`; independent answer-key review pending                           |
| CTE-F3-001 / F3-A2 | `src/env.ts:73:23–76` `addNodeBinToPath(...)`; unresolved. Candidate declaration `src/env.ts:38:1–57:2`.                                                                                    | Node ambient inputs are absent; `URL` and `process` diagnostics occur in the declaration. The analyzer reports no exact link. The candidate’s same name is not evidence of a resolved target. | `SOURCE_VERIFIED_BY_AGENT`; cause is input/diagnostic-sensitive; independent review pending |
| CTE-REJ-001        | `routes/todo.router.ts:11` passes `toDoCtrl.getOne`; the candidate declaration is `controllers/todo.controller.ts:28:3-40:4`. Asks which method executes and whether registration succeeds. | Rejected: source shows an argument reference, but not registration, runtime dispatch, receiver identity, or execution.                                                                        | `SOURCE_VERIFIED_BY_AGENT`; rejection rationale awaits independent review                   |
| CTE-REJ-002        | `controllers/todo.controller.ts:19` calls `todoManager.findAll(vUser.id)`; `models/todo.ts` is pinned. Asks which database rows are returned.                                               | Rejected: the property-call behavior, database state, and runtime result are not established by these source files.                                                                           | `SOURCE_VERIFIED_BY_AGENT`; rejection rationale awaits independent review                   |

### Source identity manifest

| Pinned repository / revision                                     | File                             | Bytes | Raw SHA-256                                                        | Git blob where recorded                    |
| ---------------------------------------------------------------- | -------------------------------- | ----: | ------------------------------------------------------------------ | ------------------------------------------ |
| `vunb/ts-node-todo` / `c64bdfaf3f36a3fde88fba8191ad0a98d4acbc8c` | `routes/index.ts`                | 1,710 | `e361911be0b6b29857eb8eac273de29fb4b3980f324f7326b582a141d5732531` | `a6f73b75ff5c9fe7c5f1eff1570fd1aa31bc7987` |
| same                                                             | `routes/todo.router.ts`          |   395 | `a698ded96d38c6afb4f7eb6d385ae8add0ec3340eb7aa29a979540147a074442` | `fe42f94012589db3b99115129c4069356816c333` |
| same                                                             | `routes/auth.router.ts`          |   228 | `10394dda38710b099f969261aea34cee35031960f1e0e9cda1b3164eabb45ff3` | `397ac5a2c05307dc6bab2d28c511da303226cf6c` |
| same                                                             | `routes/user.router.ts`          |   289 | `b5c300467588f00f7a23dd970b71ff0fff42b1420a7bf031c7771111b711c28b` | `72bc9eae0f9a077e7836a4f983bdabec34a99343` |
| same                                                             | `config/passport.ts`             | 1,839 | `be8d28b84a3ac2632b905c5bec3b284c70c210d1a2d96015b1b7f469674d0c6c` | `746ec3004287c7d333e2beb44813706bc5dcd6df` |
| same                                                             | `controllers/todo.controller.ts` | 2,333 | `3d1a82e2db7af3c8af876ff445fce286517c3636ee571f4094ea22e9b48195c2` | `41be3af14444631c108724f261e77f3c0360c208` |
| same                                                             | `models/todo.ts`                 | 1,447 | `1e93beb954c55d2e2ca093264c8fcbe2a9d26d9591b3a0c8c846b4b60ad024ad` | `be04b61cd0ae1c766b27276536b7318f23115aea` |
| `tinylibs/tinyexec` / `4a2aca1cf11943445c7bae6c767086a8c61291ef` | `src/env.ts`                     | 1,722 | `3e592708f39d6542112a8c4726854d0af38b311366d2ce913f4148cce7589bb5` | `a269c8a01c84484ff673a2500a9e90a7deabc734` |

The two initial todo source Git object IDs above are recorded here because they
were absent from the original task records.

## Input completeness and semantic uncertainty

### CTE-F1-001: selected-source closure

With the original two-file manifest (`routes/index.ts` and
`routes/todo.router.ts`), the four calls owned by `routes` yielded one exact
(`todoRouter`) and three unresolved (`initialize`, `authRouter`, `userRouter`).
Adding the verified `auth.router.ts`, `user.router.ts`, and `config/passport.ts`
changed those three calls to exact. The five-file run recorded 8 declarations,
58 call sites, 5 exact calls overall, 0 unresolved, 0 ambiguous, and 53
unsupported. This is evidence that selected-source completeness changes
resolution; it is not a claim about a complete application or type-dependency
closure. Bare Express/Passport dependencies and remaining repository/runtime
inputs remain absent.

The F1 prompt says “direct identifier calls nested in the application setup
block.” `routes/index.ts:21–32` also contains `authenticate(...)` in an arrow
callback. The intended four are direct setup calls owned by `routes`;
callback-owned calls are unsupported. The wording does not explicitly exclude
the callback, so prompt scope is `INSUFFICIENT_EVIDENCE` until an independent
reviewer agrees on an unambiguous wording. Do not silently edit the gold answer.

### CTE-F3-001: incomplete ambient type inputs

In the exact one-file `src/env.ts` input, the CLI reports 1 exact call, 1
unresolved call, and 11 unsupported call sites. `getPathFromEnv(...)` is exact;
`addNodeBinToPath(...)` remains unresolved despite a same-named source
declaration. Missing Node declarations account for `URL` in the signature and
`process` in the body. The current implementation rejects exactness when an
error overlaps a declaration. It has not been established that all such
diagnostics affect target identity, or that unrelated body errors can safely be
ignored. Do not add fabricated ambient declarations or relax the compiler
profile to make the candidate exact.

## Semantic relationship inventory

| Pinned source evidence                                                                                                                        | Classification                                            | What can be established                                                                                                                                      | Remaining uncertainty / investigation impact                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `routes/todo.router.ts:8,11,14`: `toDoCtrl.getAll`, `getOne`, and `create` are noncomputed method expressions passed as arguments.            | `REFERENCES`, not `CALLS`                                 | The pinned analyzer resolves each occurrence to its corresponding `ToDoController` declaration, preserving separate occurrences.                             | The source shows arguments to `router.get`/`post`; it does not establish framework registration success, receiver identity at runtime, or handler execution.                                           |
| `controllers/todo.controller.ts:19,34,54,73`: `todoManager.findAll`, `findOne`, `create`, and `update`; declarations are in `models/todo.ts`. | Property `CALLS`, unsupported by the current extractor    | The pinned source imports one `todoManager` constructed from `ToDoManager`, and these member names have project declarations in the selected source closure. | The current proof does not emit general property calls. No model/database result or runtime state can be inferred. This gap prevents a source-backed route-to-model trace through the controller body. |
| `routes/index.ts:21`: `authenticate(...)` is inside an inline arrow passed to `app.use`.                                                      | Syntactic direct call with unsupported callback ownership | The call expression and source span exist; `authenticate` has a pinned declaration in `config/passport.ts`.                                                  | The analyzer does not assign this call to the arrow owner, so it cannot appear as an owned exact graph edge. Callback execution and middleware registration remain unknown.                            |
| `routes/index.ts:40-42`: `authRouter()`, `userRouter()`, and `todoRouter()` are arguments to `app.use`.                                       | Direct `CALLS` to local router factories                  | The direct function calls resolve when their source files are in the selected closure.                                                                       | `app.use` is a framework property call; static source does not prove the application starts or that registration succeeds.                                                                             |
| `controllers/todo.controller.ts:19` onward and rejected task CTE-REJ-002 ask about database rows.                                             | Property calls plus unavailable runtime/database behavior | The source contains method invocations and model methods.                                                                                                    | Returned rows depend on database contents/runtime behavior and are not answerable from the pinned source. The task remains rejected.                                                                   |

## IDE / Textual / Visual information parity

| Task       | Conventional source inspection                                                                                          | Textual CLI                                                                                                                                               | Visual viewer                                                                                                                                                                                                                                                                               | Assessment                                                                                                                                                                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CTE-F1-001 | Pinned five files; source anchors checked against the text, including the callback-owned `authenticate(...)` candidate. | Root routes/index.ts@9:1; outgoing CALLS; depth 1; four answer rows fit the 20-row display cap; callback-owned call is not an exact edge.                 | Same five pinned files; root routes; CALLS only; four answer calls plus one extra depth-2 exact call `initialize -> getStrategy`; reports `depth_limit`; no external requests.                                                                                                              | `PARITY_WITH_LIMITATIONS`; **not currently RQ2-eligible** because the prompt omits the callback-scope exclusion; a reviewer must decide whether to narrow the prompt or add an assertion.                                                         |
| CTE-F2-001 | Exact task pair exposes all three expressions and declarations.                                                         | Root routes/todo.router.ts@4:1; outgoing REFERENCES; one hop; retrieve each site and follow to its declaration. Three exact references, zero exact calls. | Exact two pinned files; root todoRouter; REFERENCES only; all three site/declaration excerpts, UTF-16 ranges, and file hashes checked; three references, zero calls, no truncation, no external requests. The uncertainty panel says no unrepresented observations for this filtered query. | PARITY_WITH_LIMITATIONS: the answer-relevant subset now reproduces on identical files, while depth, navigation, and filter-scoped uncertainty presentation still differ. Suitable as a limited RQ2 candidate after independent answer-key review. |
| CTE-F3-001 | Pinned `src/env.ts` inspected at both line-73 occurrences and declarations.                                             | Select `computeEnv`; inspect outgoing `CALLS`; view exact and unresolved evidence/diagnostics.                                                            | Browser test uses the same one-file input and verifies exact follow, unresolved no-follow, evidence, and uncertainty.                                                                                                                                                                       | `PARITY_WITH_LIMITATIONS`; good exploratory uncertainty case, but it is classified `RQ3-exploratory`, not an RQ2 task.                                                                                                                            |

The text client inspects one hop and displays at most 20 relationship and 10
unknown rows; the viewer can expose depth two and up to 50 nodes. Shared trace
code does not make these conditions informationally equivalent. The committed
headless browser check now loads F1 and F2 from the exact `selectedFiles` lists
in `tasks.json`, verifies each raw SHA-256, and analyzes those bytes without
adding files from the broader external corpus. It blocks cross-origin requests
and does not execute upstream code. For F1, the interaction selects the `routes`
function in `routes/index.ts` with `CALLS` only, exposes the four answer-key
calls plus the deeper `initialize -> getStrategy` call, and reports
`depth_limit`. It follows a source-backed target and retrieves the exact site
excerpt. For F2, it selects `todoRouter`, filters to `REFERENCES`, and shows
exactly three references and zero calls on the two-file task input; it retrieves
the occurrence excerpt and follows the declaration. These are headless
interaction results, not screenshots or human observations.

Textual interaction sequences on the same frozen task inputs:

- F1: `symbols routes/index.ts`; `inspect routes/index.ts@9:1 calls outgoing`;
  retrieve each site with `evidence site <path>@<start>-<end>` and follow its
  declaration. The selected input is exactly the five F1 files in `tasks.json`;
  four root-owned direct calls are within the 20-row limit. The CLI query
  applies depth one and reports its depth limit.
- F2: `symbols routes/todo.router.ts`;
  `inspect routes/todo.router.ts@4:1 references outgoing`; retrieve the three
  site excerpts, follow each controller method declaration, then return to
  `todoRouter`. The selected input is exactly the two F2 files in `tasks.json`;
  the answer subset is three references, zero calls. CLI inspection reports a
  depth limit when it omits further traversal.

For both workflows, the manifest is version 1 and is constructed from the task's
`source.selectedFiles`: preserve each declared source path, read its
`fixturePath` bytes unchanged, set `contentBase64` from those bytes, and use the
declared SHA-256. `pnpm study:validate` verifies these selected fixtures before
the session. Start the session with
`pnpm investigate -- --manifest <task-manifest.json>`, then enter the listed
commands. The independent source baseline opens the same paths from the pinned
fixture set and inspects the line anchors in the ledger. No editor build or
extension set was pinned, so this records source inspection rather than a
reproducible IDE-product condition; a pilot must pin that tool separately.

### F1 answer-scope conflict

The current F1 task metadata remains provisional. Source inspection finds a
fifth direct identifier call, `authenticate(...)`, at `routes/index.ts:21`,
inside the arrow callback passed to `app.use`; its source declaration is
`config/passport.ts:69:1–74:2`. The four answer-key calls are exact calls owned
directly by `routes`, while this callback-owned call is not emitted as an exact
graph edge. The prompt says “direct identifier calls nested in the application
setup block” and does not exclude callback bodies. The source conflicts with the
four-answer key under a broad reading of the prompt. Because the wording does
not define whether callback-owned calls count, task-scope classification remains
`INSUFFICIENT_EVIDENCE`; F1 is **not currently eligible for RQ2 scoring**,
despite the task bank's provisional `ELIGIBLE_WITH_LIMITATIONS` value. Do not
change the gold labels to match analyzer output.

Proposed source-grounded correction for independent review: change the prompt to
ask for “the direct identifier calls owned by the `routes` function body,
excluding calls inside callback or other nested function bodies.” That preserves
the existing four intended answers. The reviewer may instead decide the task
intends all nested calls and require a source-backed fifth assertion; that
choice changes the answer key and must be independently reviewed. The task bank
has not been edited pending that decision.

## Measurement-integrity audit

| Invariant                                               | Baseline finding and current handling                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Incorrect participant answers remain valid observations | Implemented: structurally valid wrong evidence is retained as submitted and scores zero for the incorrect anchor.                                                                                                                                                                                                                    |
| Wrong evidence does not invalidate the dataset          | Covered for wrong path, coordinates, role, incomplete evidence, mixed answers, and multiple participants.                                                                                                                                                                                                                            |
| Missing differs from wrong                              | Implemented and covered; missing has explicit status and no submitted claims.                                                                                                                                                                                                                                                        |
| Unsupported claims are not silently judged              | Additional claims are retained in the private result; automatic scoring does not interpret free text or decide unsupported conclusions. Human scoring remains pending.                                                                                                                                                               |
| Timeout censoring                                       | Explicit duration status and completion status; tested.                                                                                                                                                                                                                                                                              |
| Tool failure distinct from participant error            | **Confirmed and corrected:** baseline synthetic empty failure was counted as 0/12 with 3 misses; partial failure was 4/12 with 2 misses. The new scorer preserves the failure count and submitted raw record, excludes the whole failure record from objective denominators/missed counts, and reports `objectiveScoredSubmissions`. |
| Deterministic score                                     | Input-record reordering produces identical aggregate; canonical bank digest ignores object-key order and whitespace while preserving array order.                                                                                                                                                                                    |
| Assignment validation                                   | Task eligibility and condition assignment are checked; condition mismatch is tested.                                                                                                                                                                                                                                                 |
| Aggregate privacy                                       | Tokens and answer text are omitted from aggregates; result schema rejects extra fields; tested. Raw result files still require approved private handling.                                                                                                                                                                            |
| Independent answer-key review gate                      | Participant scoring refuses unreviewed answer keys. All current keys remain awaiting review.                                                                                                                                                                                                                                         |
| Synthetic data separation                               | Demo emits `SYNTHETIC_ENGINEERING_TEST_ONLY` / “NOT EMPIRICAL DATA”, creates no file, and does not pass the participant-scoring gate.                                                                                                                                                                                                |
| No silent historical rescore                            | **Corrected:** schema v3 provenance binds task bank, scoring policy and full scorer commit. The scorer derives its own commit and rejects dirty worktrees or mismatched IDs. There is no compatibility mapping or migration; schema v1/v2 and study v1 data are rejected.                                                            |

Confirmed baseline counterexamples (synthetic only, not participant data): an
empty `tool_failure` produced `tool_failure=1`, `objectiveAvailable=12`,
`objectiveAccuracy=0`, and three missed assertions. Supplying only F2-A1 before
the failure produced 4/12 and two misses. Regression tests cover both. The
corrected output keeps `tool_failure=1`, sets `objectiveScoredSubmissions=0`,
uses `objectiveAvailable=0` / `objectiveAccuracy=null`, and reports zero missed
assertions.

The before-fix regression was run against baseline `884e979...`: the empty
failure expected no objective denominator, but the scorer returned 12 available
points, accuracy 0, and three misses. The partial-answer case returned 4/12 and
two misses. After the correction, the focused test passes for both variants and
asserts that the input result object remains byte-for-byte unchanged.

### Implemented scoring correction and identity boundary

Result schema v3 / study version `CT-EVAL-001A-v2` bind the validated task bank,
scoring policy, and full Git commit. `pnpm study:provenance` emits the
collection metadata from a clean committed checkout. The scoring CLI
independently reads its active commit and refuses a dirty worktree; mismatch,
missing identity, old schema, old study version, changed task bank, or changed
scoring policy fails explicitly. There is intentionally no compatibility
mapping: historical inputs without this identity are not silently migrated or
rescored.

`tool_failure` outcomes retain their submitted claims/evidence in the original
private input file, but the whole record is excluded from objective scoring
because the current schema cannot identify exactly which assertions were
available before interruption. This conservative censoring avoids scoring
captured partial work or interruption-caused omissions as participant
correctness. Aggregate output exposes total `submissions`, failure completion
counts, and `objectiveScoredSubmissions` separately. A future collection design
may record assertion-level availability, but it is outside this remediation.

The active commit is resolved from the scorer's own clean Git checkout using a
shell-free Git invocation; it is never trusted from the result file. This binds
the scoring implementation to an immutable source revision rather than hashing
arbitrary source files. It relies on the normal guarantee that each scoring
change is committed under a new Git object; it does not detect a changed binary
that falsely reports an old commit. The provenance command prepares metadata but
does not collect responses or authorize data collection.

## Independent answer-key review checklist

For each row in the assertion ledger, the reviewer should record **agree /
disagree / insufficient evidence**, reviewer identity/role, date, and scope
(`answer_key` or `complete_task`). An anchor-only review does not authorize
participant scoring.

- Recompute pinned source hashes and Git blob IDs; confirm repository and
  revision.
- Independently verify site/declaration coordinates, lexical owner, and exact
  source text.
- Confirm `CALLS` versus `REFERENCES`, expected exact/unresolved state, and any
  candidate declaration wording.
- Check that each prompt asks only for facts available in its selected source
  closure and does not imply execution, registration success, or database
  results.
- Resolve the F1 callback-scope ambiguity and decide whether its extra depth-two
  information is acceptable for the RQ2 prompt. F2's exact two-file visual
  condition is now reproduced, but its labels still require independent review.
- Preserve disagreements and do not change expected answers solely to fit
  analyzer predictions.

## Pilot-readiness checklist

No item below is authorization to recruit. Record named approver, evidence, and
date before marking any gate complete.

- [ ] Adviser/institution confirms academic scope and whether code-first tasks
      satisfy the thesis question.
- [ ] Independent reviewers approve all answer keys and task wording; adjudicate
      disagreements before scoring.
- [ ] Ethics/IRB determination and approved consent/privacy materials are
      recorded before recruitment.
- [ ] Participant eligibility, exclusions, withdrawal, and missing-data rules
      are frozen.
- [ ] Random assignment, task order, training, counterbalancing, and
      prior-repository-familiarity handling are frozen.
- [ ] Tool versions, source revisions, selected files, display/traversal limits,
      and scorer build identity are pinned for each condition.
- [ ] Timing, timeout, retry, tool-failure, and unsupported-task procedures are
      rehearsed without participants.
- [ ] Scoring rubric and scorer identity are versioned; no historical dataset is
      rescored without an explicit future review and approved policy.
- [ ] Raw-result access, encryption, retention, deletion, and aggregate
      disclosure limits are approved.
- [ ] Pilot purpose and analysis are limited to feasibility unless a separate
      preregistered, ethically approved confirmatory plan exists.

## Historical CT-EVAL-001A evidence

The following evidence belongs to PR #19 head
`95a2fd5033ef6266bae366e3e9139120e17af119` and is not verification of this
CT-EVAL-001B revision:

| Command / evidence                                          | Result                                                                                                                                                                                                                                 |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Earlier `pnpm check` at this SHA                            | Passed: 20 test files, 279 tests.                                                                                                                                                                                                      |
| `pnpm study:validate`                                       | Passed: all 5 task records.                                                                                                                                                                                                            |
| `pnpm study:demo`                                           | Passed: synthetic 12/12 demonstration, explicitly non-empirical.                                                                                                                                                                       |
| `pnpm eval:semantic`                                        | Passed: 13/13 eligible exact predictions; 0 wrong, missed resolvable, or evidence-mismatch counts. Labels remain unreviewed.                                                                                                           |
| `pnpm eval:external`                                        | Passed; tinyexec: 1/2 eligible exact, 1 unresolved, 11 unsupported, 15.4% supported coverage; todo base corpus: 1/4 exact, 3 unresolved, 31 unsupported, 11.4% supported coverage. Both corpus gates passed; labels remain unreviewed. |
| `pnpm test:browser`                                         | Passed locally with `PLAYWRIGHT_BROWSERS_PATH=.tooling/playwright-browsers`; pinned todo, tinyexec, evidence, uncertainty, selection, and safe-rendering browser tests passed.                                                         |
| Focused F1/F2 visual probes                                 | Passed against exact task inputs; ranges, SHA-256 values, relation filters, follow/back, truncation, uncertainty panel, and zero external requests recorded above. Temporary probe scripts removed after execution.                    |
| `pnpm security:check`                                       | Exit 1 locally: npm advisory endpoint connection denied (`ERR_PNPM_AUDIT_BAD_RESPONSE`, Windows socket error 10013); not a vulnerability result. Hosted dependency audit passed on both platforms.                                     |
| Fresh-clone `pnpm install --frozen-lockfile` + `pnpm check` | Passed in a clean clone; 139 packages reused, clone stayed clean, lockfile unchanged.                                                                                                                                                  |
| Hosted Actions run `41964366707`                            | Passed on `ubuntu-latest` and `windows-latest` for exact SHA `95a2fd5033ef6266bae366e3e9139120e17af119`, including frozen install, check, browser, semantic evaluation, and dependency audit.                                          |
| `git diff --check`                                          | Passed for tracked changes; final review draft is untracked, so Prettier and a separate trailing-whitespace scan were also run.                                                                                                        |

### Evidence manifest for this remediation

| Claim                            | Evidence binding                                                                                                                                                                                                                | Review status                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Source identities and anchors    | Upstream commits `c64bdfaf3f36a3fde88fba8191ad0a98d4acbc8c` and `4a2aca1cf11943445c7bae6c767086a8c61291ef`; fixture Git blob IDs and raw SHA-256 values in this document; `pnpm study:validate`; direct source line inspection. | Same-agent re-audit; not independently reviewed.       |
| F1/F2 viewer information         | `tests/viewer-browser.ts`, `pnpm test:browser`; task-selected manifests are derived from `tasks.json`; PR #21 head and hosted run are recorded in the PR.                                                                       | Headless browser regression; not a human observation.  |
| Scoring semantics and provenance | `tests/study-toolkit.test.ts`; `pnpm check`, `pnpm study:validate`, `pnpm study:demo`; PR #21 exact-head CI.                                                                                                                    | Engineering evidence only; does not authorize scoring. |
| Independent answer-key approval  | No reviewer identity, decision, or review artifact is present.                                                                                                                                                                  | Awaiting independent human review.                     |

On 2026-11-06, a fresh local `pnpm check` rerun passed formatting, lint,
requirements, architecture validation, build, task validation, and typecheck,
then exited 1 in Vitest: one existing `investigate-cli.test.ts` case exceeded
its 10-second test timeout (278/279 passed). The same case passed alone in 4.40
seconds; the complete CLI test file passed with one worker (22/22 in 76.58
seconds), and the full suite passed with one worker (20 files, 279 tests in
168.92 seconds). This is consistent with local parallel resource contention, but
the standard aggregate rerun did not pass. The hosted exact-SHA CI remains
green.

The local browser and audit failures above are environmental limitations, not
successful local checks. Hosted success is a separate evidence tier.

## Remaining limitations and next action

This small, selected corpus does not establish broad TypeScript accuracy,
comprehension improvement, or visual-treatment benefit. F1 remains
parity-with-limitations because the viewer exposes an extra depth-two call and
truncates at `depth_limit`; the prompt must be narrow. F2's answer-relevant
visual subset is verified on the exact two-file input, with traversal and
navigation differences disclosed. F3 is exploratory. All labels are
agent-authored and unreviewed.

**Next action:** obtain an independent source-grounded review of every answer
key and resolve the F1 prompt-scope ambiguity. Academic scope approval and any
required research ethics determination remain separate prerequisites before
recruitment; this engineering package does not grant them.
