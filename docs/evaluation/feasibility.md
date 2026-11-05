# CT-EVAL-001A feasibility assessment

## Decision

**CONDITIONAL GO** for preparing a narrowly scoped exploratory pilot protocol
after independent answer-key review and an academic scope decision. The current
evidence does not support a confirmatory effectiveness study, a general accuracy
claim, or a claim that visual presentation improves comprehension.

The feasibility artifacts now include an offline task validator, objective
component scorer, and labeled synthetic scoring demo. They verify pinned task
data and scoring mechanics; they do not validate answer-key independence or
establish study outcomes. The task dataset records local fixture paths,
condition eligibility, explicit parity classes, and its existing
`AWAITING_INDEPENDENT_REVIEW` status. See [`protocol.md`](protocol.md) for the
result format and human-study gates.

This assessment is based on source inspection, the existing pinned fixtures, the
documented capability-assessment regressions, and the recorded CLI/browser
observations on the current implementation. The baseline is
`341bc35d27b9aad6c76d4572bf7754cf638bc6c6` (`origin/main` at assessment time).
GitHub Actions run
[41862749434](https://github.com/hungthinh1104/CodeThread/actions/runs/41862749434)
passed on Windows and Ubuntu for that exact SHA. This is implementation and
fixture evidence, not participant evidence. No participant study was run.

The worktree's local `git fetch` could not update `.git/FETCH_HEAD` because
`.git` is read-only in this environment. GitHub's latest commit lookup and the
checked `origin/main` both identified the stated baseline. The pinned Node/pnpm
tools are present under `.tooling` and were used for the local checks recorded
below. Existing hosted CI is reported separately from these local results.

## Research alignment and questions

CodeThread supports code-first, source-backed investigation. Its static links
are claims about source structure. They do not establish that a route registered
successfully, a method ran, a test passed, or a runtime value was returned.
Tests may support an investigation but are not a required entry point.

- **RQ1, future confirmatory:** On a fixed, independently reviewed task set, how
  does task correctness and completion time differ between conventional
  IDE/source inspection and a specified CodeThread condition? Text and visual
  conditions must be analyzed as distinct contrasts unless their information
  access is demonstrably aligned.
- **RQ2, future confirmatory:** For tasks restricted to facts reachable in both
  CodeThread presentations, how do correctness and time differ between visual
  and textual presentation of the same snapshot and relation kinds? This is a
  presentation-and-navigation contrast, not evidence that visual graphs add
  semantic facts.
- **RQ3, guardrail:** How often do participants make unsupported exact claims
  when presented with unresolved, ambiguous, unsupported, or truncated results?

The official thesis title remains academic metadata. `product.yaml` says the
title does not make test-first navigation a product requirement; that does not
establish the institution's thesis rules. Whether the thesis requires a
test-to-code task remains **unknown** and requires an adviser or institutional
decision before finalizing the study scope.

## Verified semantic coverage

The status column uses the requested evidence classes: `VERIFIED` means the
narrow behavior is exercised by current implementation and tests; `PARTIAL`
means only the stated subset is supported; `UNSUPPORTED` means the behavior is
outside the analyzer's contract; `UNKNOWN` means this input cannot establish a
reliable result. These labels describe capability evidence, not general
accuracy.

The implementation ownership is in `packages/symbol-indexer/src/extract.ts`;
bounded traversal is in `packages/trace-engine/src/index.ts`; shared schemas and
request-aware parsers are in `packages/contracts`; the CLI and loopback viewer
are in `scripts/investigate.ts`, `scripts/viewer.ts`, and `scripts/viewer.js`.
Tests include `tests/semantic-extraction.test.ts`,
`tests/semantic-trace.test.ts`, `tests/capability-assessment.test.ts`, and
`tests/viewer-browser.ts`.

| Capability                                                                  | Status        | Boundary and evidence                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Named function declarations with bodies and method declarations with bodies | `PARTIAL`     | Extracted with declaration evidence and deterministic source identity. This is not general class, interface, overload, or framework modeling.                                                                                                         |
| Direct identifier calls                                                     | `PARTIAL`     | Local function bindings and supported relative named imports/aliases resolve when the relevant source files are supplied and compiler diagnostics do not block the binding/target. Occurrences keep lexical owners and call-site evidence.            |
| Cross-file inputs                                                           | `PARTIAL`     | Only files explicitly present in the immutable manifest can resolve. The analyzer does not discover or fetch dependencies. The pinned todo experiment below changes unresolved route-factory calls to exact when verified source files are added.     |
| Method references                                                           | `PARTIAL`     | Noncomputed method property-access expressions passed as call arguments can be `REFERENCES` when one supported source method declaration is identified. The result does not prove receiver identity, framework registration, dispatch, or invocation. |
| Ambiguous, missing, unsupported, and unresolved sites                       | `VERIFIED`    | The analyzer preserves uncertainty and diagnostics rather than emitting a guessed exact target. Empty or unsupported coverage is not equivalent to a successful exact analysis.                                                                       |
| Source evidence                                                             | `VERIFIED`    | Source and declaration spans carry path, content identity, and UTF-16 ranges; evidence retrieval verifies against retained bytes. This is not Git history beyond the source adapter's pinned input provenance.                                        |
| Property calls, computed calls, dynamic dispatch, framework semantics       | `UNSUPPORTED` | Do not count these as `CALLS` or method `REFERENCES` unless they satisfy the narrow documented form. No runtime instrumentation is present.                                                                                                           |
| External packages, ambient types, incomplete compiler context               | `UNKNOWN`     | Bare packages and unavailable ambient declarations are not fabricated. Diagnostics can conservatively suppress an otherwise plausible source link.                                                                                                    |

The checked-in gold corpus contains 30 authored semantic call annotations (17
eligible), 13 tinyexec annotations (2 eligible), and 35 original todo
annotations (4 eligible). These are corpus composition counts, not accuracy
estimates. The external source labels were AI-authored and are awaiting
independent review.

### Reproducibility observations

On baseline code at `341bc35d27b9aad6c76d4572bf7754cf638bc6c6`, local
`pnpm check` passed: formatting, lint, requirements (26 valid), architecture,
build, typecheck, and 19 test files / 247 tests. `pnpm eval:semantic` reported
13 exact supported resolutions from 13 exact predictions, no incorrect or missed
gold relations, 3 unresolved and 1 ambiguous among 17 eligible calls, 13
unsupported calls, and zero evidence mismatches; its fixture gate passed. This
is a small authored corpus, not general accuracy evidence.

`pnpm eval:external` passed its corpus gates on the pinned inputs. For tinyexec
it reported 13 annotated calls, 2 eligible, 1 exact, 1 unresolved, 11
unsupported, and zero incorrect, missed, or evidence-mismatched occurrences. For
the original todo manifest it reported 35 annotated calls, 4 eligible, 1 exact,
3 unresolved, 31 unsupported, and zero incorrect, missed, or evidence-mismatched
occurrences. These apparent 1/1 exact precision and recall denominators are
small and labels remain unreviewed. The separate closure regression in
`tests/capability-assessment.test.ts` verifies the input-completeness change; it
must not be folded into the original gold-set metrics.

`pnpm test:browser` passed with the repository-local Playwright browser path,
including pinned todo references, tinyexec calls, target follow/back,
uncertainty, evidence, and safe rendering. `pnpm security:check` could not reach
the npm advisory endpoint from this local environment
(`ERR_PNPM_AUDIT_BAD_RESPONSE`, socket permission error); this is a network
service failure, not a reported vulnerability result. The baseline hosted run's
security audit step passed. A PR's own hosted checks must be recorded against
its exact SHA; baseline CI is not a substitute.

### Experiment A: input completeness versus type information

The original two-file todo manifest contains `routes/index.ts` and
`routes/todo.router.ts`. A source-pinned closure adds `routes/auth.router.ts`,
`routes/user.router.ts`, and `config/passport.ts`; their raw SHA-256 values and
upstream Git blob IDs are recorded in `fixtures/external/README.md`. The files
all come from upstream commit `c64bdfaf3f36a3fde88fba8191ad0a98d4acbc8c`.

With the original manifest, `authRouter()`, `userRouter()`, and `initialize()`
in `routes/index.ts` are unresolved; `todoRouter()` is exact. With the verified
additional source files, the three previously unresolved calls resolve to their
source declarations. The root call anchors are `routes/index.ts:14`, `:40`,
`:41`, and `:42`; target declarations are `config/passport.ts:64–67`,
`routes/auth.router.ts:4–9`, `routes/user.router.ts:4–12`, and
`routes/todo.router.ts:4–17`. This is evidence that these three findings are
caused by missing manifest inputs in the original experiment, not unsupported
direct-call syntax. The full application dependency closure is still absent:
Express, Passport, other bare packages, configuration, and runtime inputs are
not installed or analyzed.

The separate tinyexec example shows a type-context limitation. In `src/env.ts`,
`computeEnv` at lines 59–77 contains `getPathFromEnv(envWithDefault)` (line 73),
which has an exact source-backed link to the declaration at lines 18–36. The
sibling `addNodeBinToPath(...)` call at line 73 remains unresolved in the
current annotated result. Its declaration at lines 38–57 contains `URL` in the
parameter and `process` in the body; Node types and other repository files are
excluded. The current conservative compiler-diagnostic guard rejects exact
resolution when an error overlaps the declaration. This demonstrates a false
negative caused by incomplete type context and the broad declaration-overlap
guard; it does not prove that every such diagnostic is semantically unrelated to
target identity. The assessment does not relax the guard or invent type
declarations.

### Experiment B: missing relationship kinds

In pinned todo source, `routes/todo.router.ts` passes `toDoCtrl.getAll`,
`toDoCtrl.getOne`, and `toDoCtrl.create` as call arguments at lines 8, 11,
and 14. With the selected controller source, they resolve as three `REFERENCES`
occurrences to `ToDoController.getAll` (declaration lines 10–26), `getOne`
(28–40), and `create` (42–60). They are not call edges. The visible code shape
resembles route configuration, but these facts do not prove that a framework
accepted or registered the values, that the same object is used at runtime, or
that a request invokes them.

Other property calls in the controller, including `todoManager.findAll`, are not
covered by the method-reference feature because they are call expressions, not a
supported method value passed as an argument. Callback and framework
registration meaning likewise remain unsupported. A static type checker may
identify declarations for some of these expressions, but type-checker identity
alone is not sufficient to relabel them as the supported relation kind.

## Textual and visual information parity

Both presentations consume the same trace engine facts and shared evidence
contracts, but expose different bounded views. The textual `inspect` flow
queries depth 1, caps its neighbor request at 50 nodes, displays at most 20
relationship rows, and marks omitted results. The browser viewer uses depth 2,
at most 50 graph nodes, and at most 50 unknown rows. Both support explicit
relation-kind filtering; visual evidence is retrieved from the same retained
snapshot. Thus semantic identity is shared, but accessible information and
traversal depth are not automatically equivalent.

| Candidate                       | IDE access                               | Text access                                                                                | Visual access                                                                                                              | Parity finding                                                                                                                                                                                                                 |
| ------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1 direct route-builder calls   | All selected files and declarations      | Direct `CALLS` from `routes`; all four answer facts fit within the observed 20-row display | Direct root calls are present, with possible additional depth-2 facts                                                      | `ELIGIBLE_WITH_LIMITATIONS` for RQ1. `INSUFFICIENT_EVIDENCE` for RQ2: the prompt does not exclude callback-owned `authenticate(...)`, omitted from the four-item answer key. Exclude F1 from RQ2 until independently resolved. |
| F2 controller method references | Both selected files and source locations | One-hop `REFERENCES` filter exposes the three occurrences and evidence                     | `REFERENCES`-only browser test on the pinned input displays exactly three exact references and supports following a target | Best current common subset for a narrow RQ2 task. It tests navigation and interpretation of references, not framework behavior.                                                                                                |
| F3 uncertainty at `computeEnv`  | Source and diagnostics are inspectable   | The exact inner call and unresolved outer call are visible with evidence/diagnostics       | The same semantic facts are available, but UI exposure and clicks should be checked before a study                         | `EXPLORATORY_ONLY`; useful for uncertainty recognition, not a broad semantic accuracy outcome.                                                                                                                                 |

For each condition, tasks must define a common source snapshot, selected files,
filters, initial symbol, allowed evidence operations, and any time limit. The
task bank must not treat a deeper visual neighborhood as “same information”
merely because both clients call the same engine. The viewer's browser tests
establish that a particular interface path works; they do not establish
usability parity for study participants.

## Candidate task feasibility

The machine-readable prompts, expected assertions, source hashes, anchors,
required capabilities, and review checklist are in [`tasks.json`](tasks.json).

| ID            | Family                    | Feasibility                 | Use and limit                                                                                                                                                                                                            |
| ------------- | ------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CTE-F1-001`  | Direct/cross-file calls   | `ELIGIBLE_WITH_LIMITATIONS` | Candidate for RQ1 with limitations only. Exclude from RQ2 until independent review resolves the callback-scope conflict; preserve the four-answer key unchanged meanwhile. It cannot answer whether HTTP routes execute. |
| `CTE-F2-001`  | Static method references  | `ELIGIBLE_WITH_LIMITATIONS` | Three exact source method references in the todo route/controller subset. The strongest common Text/Visual task if restricted to `REFERENCES`.                                                                           |
| `CTE-F3-001`  | Uncertainty/evidence      | `EXPLORATORY_ONLY`          | Contrasts exact `getPathFromEnv` with unresolved `addNodeBinToPath`; one small sample and a known diagnostic confound limit interpretation.                                                                              |
| `CTE-REJ-001` | Runtime handler execution | `REJECTED`                  | Static source links do not establish successful framework registration, runtime dispatch, or execution.                                                                                                                  |
| `CTE-REJ-002` | Runtime/database outcome  | `REJECTED`                  | Unsupported property calls, absent dependencies, and no runtime/database execution make returned records or behavior unanswerable from this snapshot.                                                                    |

No task is classified `ELIGIBLE` without limitations. Two narrow comprehension
tasks and one exploratory uncertainty task are not a matched, sufficiently broad
task bank for a confirmatory comparison. Task difficulty estimates are
provisional and need pilot timing and independent review.

## Answer-key status and review requirements

The source observations in `tasks.json` were re-audited against the pinned
source files and their checked SHA-256 values. This re-audit is not independent
validation: the existing labels and provisional task keys were authored by
Codex, and no independent reviewer has signed off. Status is
`AWAITING_INDEPENDENT_REVIEW`.

Before any pilot, an independent reviewer who did not author the labels should
verify each task's source selection, hash, location, target declaration, lexical
owner, relation kind, unresolved/unsupported boundaries, and prohibited runtime
inferences without using analyzer output as the answer key. Keep disagreements
and their resolution explicit; do not edit upstream gold labels to match
analyzer predictions.

## Main validity threats

- **Construct validity:** F1/F2 measure bounded navigation and interpretation of
  source anchors, not broad system comprehension. F3 emphasizes uncertainty
  recognition.
- **Internal validity:** learning, task order, repository familiarity, unequal
  task complexity, training, tool familiarity, and differing display depth can
  confound condition effects.
- **External validity:** the candidate tasks use two small, older repositories
  and selected files; they were chosen partly because existing capabilities can
  resolve the requested facts. Results would not generalize to arbitrary
  TypeScript or framework-heavy code.
- **Conclusion validity:** the task bank is small; pilot scores may have
  ceiling/floor effects and cannot establish population-level improvement. No
  sample size or inferential analysis is set here.
- **Selection and coverage bias:** answerable tasks selectively sample current
  support. Report semantic coverage failures separately from
  navigation/presentation failures and include uncertainty tasks rather than
  silently dropping them.
- **Information parity:** viewer depth 2 and text depth 1 plus the 20-row
  presentation cap can expose different facts. RQ2 must use only the task's
  verified common subset and disclose extra accessible information.

## Method references

- Cornelissen, Zaidman, and van Deursen studied dynamic execution-trace
  visualization with Eclipse/Extravis, not CodeThread's static source relations.
  Their results are methodological context only; no reported effect size
  transfers to this project.
  [Publisher DOI](https://doi.org/10.1109/TSE.2010.47),
  [TU Delft research record](https://research.tudelft.nl/en/publications/a-controlled-experiment-for-program-comprehension-through-trace-v/).
- Kitchenham and Madeyski discuss analysis and meta-analysis challenges for
  small-sample software engineering experiments; this does not supply a
  sample-size justification for this task bank.
  [Empirical Software Engineering article](https://doi.org/10.1007/s10664-024-10504-1).
- OSF describes preregistration as a time-stamped, read-only study plan posted
  before data collection or analysis.
  [OSF guidance](https://help.osf.io/article/330-welcome-to-registrations).
- Kitchenham et al.'s empirical software engineering guidelines are a general
  methods reference, not validation of this particular design.
  [Publisher DOI](https://doi.org/10.1109/TSE.2002.1027796).
