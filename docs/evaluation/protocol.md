# CT-EVAL-001A study protocol and result format

## Status and authorization

This is a protocol proposal and an offline engineering toolkit. No participant
has been recruited, no session has been run, and no empirical result exists. The
current answer keys and source labels remain `AWAITING_INDEPENDENT_REVIEW`. This
document does not authorize recruitment or a pilot. Obtain the thesis adviser or
institution's decision on whether a test-to-code task is required, independent
answer-key review, and any applicable ethics approval before collecting
participant data. Before recruitment, use the institution-approved consent
process and explain the study purpose, tasks, conditions, data collected,
voluntary participation, ability to skip or withdraw, retention/deletion plan,
and contact for questions. No consent process or participant material has been
approved or used for this proposal.

The source-pinned candidates and current feasibility decisions are listed in
[`tasks.json`](tasks.json). The research and implementation limitations are in
[`feasibility.md`](feasibility.md) and
[`study-readiness.md`](study-readiness.md).

## Research questions and estimands

- **RQ1:** On the reviewed tasks, how do correctness and completion time differ
  between conventional IDE/source inspection and a specified CodeThread
  condition? Textual and visual tracing are separate contrasts.
- **RQ2:** On tasks where both CodeThread presentations expose the same
  answer-relevant facts, evidence, relation kinds, uncertainty and limits, how
  do correctness and time differ between visual and textual presentation? This
  is a presentation and navigation comparison, not a comparison of semantic
  coverage.
- **RQ3 guardrail:** How often do responses assert a target, relationship,
  registration, execution, or runtime outcome that the permitted evidence does
  not establish?

The primary outcome is task-level correctness. Completion time is secondary.
Unsupported conclusions are a guardrail. Confidence and usability are
exploratory. The candidates are too few and too coverage-selected to support a
confirmatory effectiveness claim. Begin with a small exploratory case study only
after the prerequisites below; do not choose a sample size or run significance
tests from this protocol alone.

After each task, ask the same exploratory usability item in every condition:
“How easy or difficult was it to find and verify the requested relationships and
source evidence?” Use a 1–5 response from very difficult to very easy, or `null`
when not collected or declined. This single item is not a validated usability
scale and is not part of the correctness score. Report its 1–5 count
distribution by task and condition; do not make inferential or population claims
from it.

F1 and F2 remain provisional task candidates for all three conditions with
limitations. F1 is excluded from RQ2 because its prompt does not resolve whether
the callback-owned `authenticate(...)` call belongs in the four-item answer key.
Do not score F1 for RQ2 until an independent reviewer resolves the scope and the
task wording/key are aligned. F2 is a limited RQ2 candidate using a
`REFERENCES`-only filter and the same three method-reference occurrences. F3 is
exploratory and must not be used for confirmatory RQ2 unless diagnostic access
is shown to be equivalent. Rejected tasks have no answer key and cannot be
assigned.

## Participants, assignment and training

The intended population is developers with declared TypeScript familiarity;
recruitment access and experience distribution are unknown. Define eligibility
before recruitment. Record only coarse experience categories when approved and
necessary to interpret results. Do not collect names, email addresses, employer
details, repository credentials, or unrelated personal information.

Use task assignments permitted by `conditionEligibility` in the validated task
bank. Do not infer parity from that field alone: inspect the task's
`informationParity` and RQ2 restriction before assigning a comparison. There is
no default assignment or counterbalancing implementation. Keep answer-bearing
tasks out of training. Give each condition the same source orientation, evidence
explanation, uncertainty explanation and task instructions. Standardize IDE
setup and allowed navigation. Do not provide semantic hints in one condition
only.

The current bank is not sufficient for a confirmatory crossover: repeated
exposure risks learning and answer carryover, and there are too few matched,
non-overlapping task forms. A between-subject design would require a recruitment
and precision rationale that does not yet exist. A later exploratory case study
can first test wording, training, navigation, timing, accessibility, uncertainty
recognition and failure handling without population claims.

## Procedure and recording

Before any approved session, freeze the task file, source revision and hashes,
selected inputs, tool build, initial symbol, filters, query bounds, answer form,
time cap and retry rule. Record condition and task order. Start timing when the
task is presented; stop when a final response is submitted. Preserve partial
responses and do not overwrite an answer with a corrected version. Record tool
failures by the result schema's bounded reason code and keep failures distinct
from semantic coverage failures and presentation failures.

The offline toolkit does not present tasks, collect answers, start a timer, or
write result files. An approved local collection procedure must produce the
result JSON described below. The scoring command reads that file and writes
nothing.

## Objective scoring and human review

For each expected assertion, the deterministic scorer awards:

1. **Occurrence point:** the submitted relation kind and exact source-site
   path/range match the pinned answer.
2. **Conclusion point:** the resolution status matches; an exact claim must also
   match the target path, declaration name, owner when supplied, and complete
   declaration range. A non-exact answer must not name an exact target.
3. **Evidence points:** one point for each predeclared source-site, target or
   candidate-declaration anchor cited with the correct task assertion ID.

The score is earned points divided by the task's fixed available points. Missing
components earn zero; correctly answered components remain partial credit. A
wrong exact target counts as an incorrect exact claim and a missed expected
assertion. Evidence references with a recognized role, known assertion ID, and
valid structure are participant responses even when their path, coordinates, or
role do not match the answer key. Preserve those values exactly and award zero
for each incorrect or omitted expected anchor; never normalize or reject an
otherwise valid dataset because an answer is wrong. Malformed references,
unknown assertion IDs, duplicate references, and invalid result structure still
reject the dataset. The scorer does not score free text, interpret unsupported
claims, or decide whether a narrative explanation demonstrates comprehension.
Those judgments remain `AWAITING_HUMAN_SCORING` until an independent human
rubric review is authorized and recorded.

Participant scoring is gated on every answer key used by the result being marked
`INDEPENDENTLY_REVIEWED` with review provenance scoped to `answer_key` or
`complete_task`. A source-anchor-only or parity-only review does not satisfy the
answer-key gate. The current bank does not pass that gate. `study:score` must
therefore refuse the current participant-result scoring request. The separate
synthetic path is an engineering test only and reports
`SYNTHETIC_ENGINEERING_TEST_ONLY`; it cannot be represented as an independently
validated study result.

The result schema requires an explicit `confidence` value from 1 to 5 or `null`;
omission is invalid, and `null` means not collected or declined. Confidence is
reported descriptively. Do not treat an ordinal mean as calibrated confidence or
run significance tests in an exploratory pilot. It likewise requires a
`usabilityRating` from 1 to 5 or `null`, and the scorer emits only its aggregate
count distribution. The usability response is separate from answer text and is
not used to award objective points.

| Outcome                | Recording and scoring rule                                                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Completed              | Score submitted objective components; preserve free text for later human review.                                                                                  |
| Partial or abandoned   | Score only submitted objective components; retain the outcome status.                                                                                             |
| Timeout                | Score any submitted partial components; mark duration as censored at the recorded cap.                                                                            |
| Missing                | Record an explicit missing status and null duration/confidence when unavailable; unanswered rubric components score zero.                                         |
| Tool failure           | Record a bounded failure code; preserve captured responses in the raw file, but censor the entire record from objective denominators and missed-assertion counts. |
| Unsupported task       | Count separately; exclude from objective participant correctness rather than treating it as a participant error.                                                  |
| Unsupported conclusion | Preserve in submitted/additional claims for human coding; do not infer it from a wrong answer or automate the judgment.                                           |

An observed duration for a `tool_failure` is retained in the private result but
is not a task completion time and is excluded from the measured completion-time
mean. Timeouts remain censored at the recorded cap.

Do not exclude a failed task after seeing an answer without recording the
predeclared reason and analysis denominator.

`submissions` counts every structurally valid result.
`objectiveScoredSubmissions` counts records that contribute to objective
denominators. A `tool_failure` record contributes zero objective points, zero
missed assertions, and no objective denominator, even when a partial answer was
captured. Its original response stays unchanged in the private input file for
authorized human review; aggregates do not emit it. If a task/condition group
contains only tool failures or unsupported tasks, `objectiveAccuracy` is `null`
because no objective observations were scored.

## Result file and privacy

Use a JSON document with `schemaVersion: 3`, `studyVersion: "CT-EVAL-001A-v2"`,
required `provenance`, and a `results` array. Provenance contains the SHA-256
digest of the canonical validated task bank, scoring-policy version and digest,
and the full scorer Git commit. Canonical JSON sorts object keys and ignores
whitespace while preserving array order. The task digest covers the complete
validated task definitions; the policy digest covers the versioned point rubric
and answer/evidence matching rules.

Before collecting a dataset, run `pnpm --silent study:provenance` from the clean
committed release checkout and freeze the returned schema version, study
version, and provenance object with the result dataset. `study:score` resolves
its own active `HEAD` and rejects a dirty worktree; the scorer requires an exact
match with the dataset's scorer revision. A new commit therefore needs new
result provenance. There is no compatibility mapping, automatic migration, or
historical rescore. Schema v1/v2, study v1, missing provenance, changed task
bank/rubric, and a different scorer revision fail with typed errors. The
synthetic demonstration uses a reserved non-commit scorer marker and cannot pass
the participant scoring path.

Each result requires a random pseudonymous token in the form `P-` followed by 16
uppercase hexadecimal characters, task/condition/order, duration and its
observed/censored/missing status, submitted answer, structured objective claims,
evidence references, additional claims, confidence, completion status, and
`usabilityRating`, `toolFailureCode`, `missingReasonCode`, and
`unsupportedReasonCode` fields that are null or required according to the
outcome. Every record has `humanScoringStatus: "AWAITING_HUMAN_SCORING"`. Extra
properties are rejected; the schema has no name or email fields. Free text can
still contain personal details, so keep raw results private and review approved
data handling before collection. Do not put participant data in the task bank,
fixtures, issue, pull request, or source control.

Store approved local result files only in the ignored `local-study-data/`
directory. Set access, encryption, retention and deletion rules before
collection. The scorer reads the bounded file without modifying it, validates
task assignment and result structure, and emits aggregates by task and condition
only. Incorrect evidence remains in the original private file for authorized
human review; aggregates omit participant tokens and answer text. Small groups
can still be re-identifiable; keep outputs private and follow institutional
policy. No network service or telemetry is used.

Example command after authorized collection:

```sh
pnpm --silent study:score -- ./local-study-data/results.json
```

For a deterministic software-only demonstration, use `study:demo`. It constructs
one synthetic answer in memory and prints the banner
`SYNTHETIC DRY RUN — NOT EMPIRICAL DATA`; it creates no file and is not a
participant observation.

## Missingness, exclusions and validity

Predefine how to handle participant decline, missing logs, interruption,
unsupported tasks, tool errors, timeouts, prior repository familiarity and
protocol deviations. Report denominators separately for correctness, time,
unsupported conclusions, confidence, and usability ratings. Do not impute
missing answers or convert a tool failure into a participant failure.

Threats include learning/carryover, task difficulty, prior repository
familiarity, TypeScript skill variation, training and facilitator effects,
coverage-based task selection, unequal accessible information, and the limited
size and age of the two pinned source corpora. Keep semantic coverage failures
separate from UI failures. Existing answer labels are AI-authored and not
independent ground truth. No population claim follows from implementation tests
or this selected task bank.

Dynamic execution-trace visualization studies provide methodological context,
not direct evidence for CodeThread's static relationships. See Cornelissen,
Zaidman and van Deursen's
[controlled trace-visualization study](https://research.tudelft.nl/en/publications/a-controlled-experiment-for-program-comprehension-through-trace-v/),
the empirical software engineering
[small-sample guidance](https://doi.org/10.1007/s10664-024-10504-1), and
[OSF registration guidance](https://help.osf.io/article/330-welcome-to-registrations).
Do not copy effect sizes from dynamic-trace research into CodeThread claims.
