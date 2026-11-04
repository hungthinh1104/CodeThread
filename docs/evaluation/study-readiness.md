# CT-EVAL-001A study readiness

## Readiness status

**Conditional readiness for a later exploratory pilot protocol only.** This
document does not authorize recruiting participants or running a study. There
are two narrow tasks with source-pinned answers and one uncertainty task
suitable only for exploration. The answer keys are awaiting independent review,
academic title requirements are unresolved, and the current task bank is too
small and unbalanced for confirmatory RQ1/RQ2 claims.

No sample size, treatment effect, significance test, participant result, or
claim of improved comprehension is established here.

An offline task validator, objective-component scorer, and synthetic scoring
demo are implemented for this task bank. They are engineering tools only: no
session collection, human scoring workflow, participant data, or empirical
result is implemented. The result format and operational score rules are in
[`protocol.md`](protocol.md).

## Design comparison

| Design                             | Strengths                                                                                                                                               | Current risks                                                                                                                                                                                                                           | Current decision                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Within-subject                     | Controls participant skill differences and can use fewer participants for a given task-level comparison.                                                | Strong learning/carryover when the same source or answer is revisited; participants may remember declarations across conditions. The current bank has too few matched, non-overlapping forms. Order and familiarity effects are likely. | Do not use for confirmatory work yet. Reconsider only after creating independently reviewed, matched task forms and counterbalancing condition/order. |
| Between-subject                    | Avoids each participant seeing the same answer in multiple tools and reduces direct task carryover.                                                     | Requires more participants; skill, IDE fluency, TypeScript experience, and repository familiarity can vary sharply between groups. Recruitment feasibility is unknown.                                                                  | Not justified until a target estimand, recruitment plan, and sample-size/precision rationale exist.                                                   |
| Small exploratory case study/pilot | Can reveal whether task wording, evidence navigation, training, timing, and uncertainty handling work in practice without claiming a population effect. | Small, purposive samples are not a basis for causal or general effectiveness claims. Observations can be researcher-sensitive and tasks are coverage-selected.                                                                          | Recommended next study design, only after answer-key review, adviser/institution decisions, and any required ethics approval.                         |

The first pilot should treat CodeThread as a bounded task tool and assess
protocol feasibility: whether participants can locate requested source facts,
distinguish `CALLS` from `REFERENCES`, cite evidence, recognize
unresolved/unsupported states, and complete the workflow. Any comparison among
IDE, text, and visual conditions is exploratory until access parity and task
forms are reviewed.

## Estimands and outcomes for a future confirmatory study

Define these before collecting data; this readiness document is not a
preregistration.

- **RQ1 primary outcome:** task-level difference in rubric correctness between
  conventional IDE/source inspection and a specifically named CodeThread
  condition on a fixed, independently reviewed task set. If both textual and
  visual CodeThread are compared with IDE, predeclare the two contrasts and how
  multiplicity is handled. Do not combine them into one undefined “CodeThread
  effect.”
- **RQ1 secondary outcome:** task completion time under the same task and
  condition definitions.
- **RQ2:** task-level difference in correctness and time between visual and
  textual CodeThread when snapshot, relation kinds, answer-relevant facts,
  source evidence, and uncertainty are accessible in both. This estimates the
  effect of presentation and navigation under that restricted parity condition,
  not incremental semantic coverage.
- **RQ3 guardrail:** rate of responses that assert an exact target,
  registration, execution, or runtime outcome beyond the available static
  evidence. Report unsupported conclusions separately from correctness and
  semantic coverage.
- **Exploratory outcomes:** confidence after each answer, the fixed usability
  rating specified in [`protocol.md`](protocol.md), descriptive calibration
  against rubric score, and tool/protocol failures. Do not attach confirmatory
  claims to these outcomes in a pilot.

The current F2 `REFERENCES` task is the best candidate for a limited RQ2
comparison because both interfaces can expose the three direct reference facts
under the same relation-kind filter. F1 must be scored only on the four direct
calls owned by `routes`, since the viewer reaches depth two while textual
`inspect` is depth one. F3 is an uncertainty-recognition probe; confirm before
use that both clients expose the same diagnostic context. If they do not, keep
it out of RQ2.

## Operational definitions and scoring

1. Before participant data collection, freeze task wording, selected source
   revision/files/hashes, allowed tools, initial symbol, filters, response form,
   time cap, and rubric. Each rubric item is an atomic, source-pinned assertion
   with a relation kind and anchor.
2. The offline scorer awards separate objective points for relation kind and
   source-site identity, resolution status and exact target identity, and each
   cited predeclared source anchor. Task correctness is earned divided by the
   fixed available points; missing components earn zero and partial answers get
   proportional credit. A wrong exact target is an incorrect exact claim and a
   missed expected assertion. Free text receives no automated score.
3. Predefine “unsupported conclusion” as an assertion of an exact target, owner,
   registration, dispatch, execution, or runtime result not established by the
   task's permitted evidence. The current tool preserves but does not classify
   or count these claims. Independent human review must code them; they remain
   `AWAITING_HUMAN_SCORING`.
4. Measure time from task presentation to submitted final answer using the same
   visible timer/logging rule in every condition. Predeclare a time cap. A
   timeout has no final completion time; report it as censored at the cap, not
   as an observed completed duration.
5. Ask the same fixed confidence question after each answer. In a pilot,
   summarize confidence and correctness descriptively; do not use significance
   testing or claim calibrated confidence.
6. Ask the single post-task ease-of-finding rating specified in
   [`protocol.md`](protocol.md) after each task. Report its response-count
   distribution by task and condition; it is exploratory and does not enter the
   correctness score.
7. Keep semantic coverage failures distinct from UI/presentation failures. If a
   required fact is unavailable because the analyzer did not cover it, classify
   it as a semantic coverage failure. If an available fact cannot be found
   because of a client defect, classify it as a presentation/tool failure. Do
   not silently drop either after seeing responses.

| Outcome            | Recording rule                                                                                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Incorrect response | Preserve the response and score each rubric item; do not overwrite with a corrected answer.                                                                                 |
| Partial answer     | Score only supported, correctly anchored atomic items; calculate proportional score.                                                                                        |
| Timeout            | Score submitted items if a partial response exists; otherwise unanswered rubric items score zero. Record timeout separately and time as censored at the cap.                |
| Abandoned task     | Preserve any submitted partial response, mark abandonment and reason if voluntarily provided; do not recode as an ordinary timeout.                                         |
| Tool failure       | Log the condition, operation, sanitized error, and time. Pause and apply a predeclared retry rule. Do not silently replace the task or impute a participant answer.         |
| Missing data       | Use reason codes (not collected, participant declined, logging failure, other); do not silently impute. State the analysis denominator for each outcome.                    |
| Unsupported task   | Mark before exposure when a task's required fact is outside the declared support or parity boundary. Report the count separately; do not score it as a participant failure. |

Use coded participant identifiers only if a later approved protocol needs them.
Minimize collected personal data, set access/retention rules in advance, and
obtain institutional ethics/privacy approval where required.

## Participant and session controls

- Recruit the population that matches the intended claim (for example,
  developers with declared TypeScript familiarity); current recruitment access
  and skill distribution are unknown.
- Record relevant experience in coarse, predeclared categories if approved and
  necessary for interpretation. Do not collect unrelated personal details.
- Provide the same brief tool training, source orientation, and
  evidence/uncertainty explanation to all conditions. Keep task answers out of
  training materials.
- Standardize IDE setup and allowed navigation. In CodeThread conditions, record
  selected revision, manifest, root symbol, filters, displayed limits,
  truncation, and evidence operations.
- Prevent answer leakage by using non-overlapping tasks across within-subject
  conditions or separate participants/task sets. Counterbalance order only when
  matched forms exist.
- Ask about repository familiarity before exposure and record it consistently;
  do not assume randomization removes strong prior familiarity in a small
  sample.
- Predefine interruption, browser/CLI failure, and retry handling. Do not let a
  facilitator provide semantic hints in one condition only.

## Independent review and pilot prerequisites

Before any pilot:

1. Obtain an adviser/institution decision on whether the thesis title or local
   academic rules require a test-to-code scenario. Product metadata alone cannot
   answer this.
2. Have at least one reviewer who did not author the existing labels
   independently inspect source-pinned task assertions without seeing analyzer
   predictions. Prefer two independent annotations followed by a documented
   adjudication for any claim used as a primary outcome.
3. Verify every source hash, repository revision, selected input, range, lexical
   owner, relationship kind, compiler diagnostic, and answer boundary. Preserve
   both agreement and disagreement; keep existing gold labels unchanged unless a
   separately justified correction is reviewed and documented.
4. Walk each task through IDE, text, and visual conditions with the exact frozen
   settings. Confirm answer-relevant facts, source evidence, uncertainty,
   ordering and truncation are visible. Exclude tasks from RQ2 if parity cannot
   be shown before participant outcomes.
5. Pilot the wording, training, scoring form, timing, accessibility, and failure
   logging. Use pilot results only to refine feasibility and protocol, with
   changes documented; do not fold pilot outcomes into a confirmatory analysis
   unless that use was predeclared and ethically approved.
6. Obtain any required ethics/participant approval and consent before
   recruitment. Preregister the confirmatory hypotheses, outcomes, exclusions,
   missingness, and analysis plan in a time-stamped record before data
   collection or analysis.
   [OSF registration guidance](https://help.osf.io/article/330-welcome-to-registrations).

Do not choose a numeric sample size until the confirmatory estimand, minimally
meaningful effect or precision target, design, participant population, and
realistic recruitment are specified. A small feasibility pilot should be sized
for operational questions, not for an underpowered significance test.
Small-sample software engineering methods literature cautions that sample size
and distribution affect estimates and analysis; it does not make a weakly
designed pilot confirmatory.
[Kitchenham and Madeyski, 2024](https://doi.org/10.1007/s10664-024-10504-1).

## Validity and analysis safeguards

- **Internal validity:** control learning, order, task complexity, training,
  facilitator assistance, device setup, and repository familiarity. Avoid
  repeated exposure to the same answers across conditions.
- **Construct validity:** correctness on these source-navigation tasks may not
  represent broad comprehension, maintenance performance, or productivity. Keep
  claims at task level.
- **External validity:** two selected small projects, old source snapshots, and
  engine-supported task selection cannot represent all TypeScript repositories,
  teams, or frameworks.
- **Conclusion validity:** the current bank is small. Pilot data should be
  descriptive; no p-values, general effect claims, or population inferences.
- **Selection bias:** tasks were selected from existing supported examples.
  Report unsupported task opportunities and coverage separately; do not present
  only successes as analyzer accuracy.
- **Information parity:** the text client and viewer have different
  depth/presentation bounds. Freeze and inspect exact settings; use a common
  answer-relevant subset for RQ2.
- **Researcher/annotation bias:** existing labels and provisional keys were
  AI-authored and are not independent. Independent review must precede scored
  use.
- **Prior literature fit:** Cornelissen et al. evaluated dynamic execution-trace
  visualization with Eclipse/Extravis. It is methodological context, not direct
  evidence for static CodeThread relationships and supplies no transferable
  effect size.
  [TU Delft record](https://research.tudelft.nl/en/publications/a-controlled-experiment-for-program-comprehension-through-trace-v/).

For future empirical reporting, describe assignment, participants, tasks,
conditions, exclusions, missing data, scoring, and analysis transparently.
Kitchenham et al.'s empirical software engineering guidelines are a general
reference; the task-specific validity claims still require their own evidence.
[Publisher DOI](https://doi.org/10.1109/TSE.2002.1027796).

## Open decision and next action

**Single most valuable next action:** ask the thesis adviser or institution to
resolve whether a test-to-code scenario is academically required. That answer
determines whether the current code-first task bank is an acceptable thesis
evaluation or whether a separately authorized test-analysis capability/task
family is needed. Independently reviewed source keys remain a required gate
before any pilot.
