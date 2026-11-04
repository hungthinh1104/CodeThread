# CT-EVAL-001A study protocol and result format

## Status and authorization

This is a protocol proposal and an offline engineering toolkit. No participant
has been recruited, no session has been run, and no empirical result exists. The
current answer keys and source labels remain `AWAITING_INDEPENDENT_REVIEW`. This
document does not authorize recruitment or a pilot. Obtain the thesis adviser or
institution's decision on whether a test-to-code task is required, independent
answer-key review, and any applicable ethics approval before collecting
participant data.

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

F1 and F2 are candidate tasks for all three conditions with limitations. F1's
RQ2 scoring is restricted to the four direct calls in the route setup because
the visual client can expose a deeper neighborhood. F2 uses a `REFERENCES`-only
filter and the same three method-reference occurrences. F3 is exploratory and
must not be used for confirmatory RQ2 unless diagnostic access is shown to be
equivalent. Rejected tasks have no answer key and cannot be assigned.

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
assertion. Evidence references are limited to the answer key's predeclared
anchors so the offline scorer can verify them without searching or reading
participant-specific source. It does not score free text, interpret unsupported
claims, or decide whether a narrative explanation demonstrates comprehension.
Those judgments remain `AWAITING_HUMAN_SCORING` until an independent human
rubric review is authorized and recorded.

The result schema requires an explicit `confidence` value from 1 to 5 or `null`;
omission is invalid, and `null` means not collected or declined. Confidence is
reported descriptively. Do not treat an ordinal mean as calibrated confidence or
run significance tests in an exploratory pilot.

| Outcome                | Recording and scoring rule                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Completed              | Score submitted objective components; preserve free text for later human review.                                          |
| Partial or abandoned   | Score only submitted objective components; retain the outcome status.                                                     |
| Timeout                | Score any submitted partial components; mark duration as censored at the recorded cap.                                    |
| Missing                | Record an explicit missing status and null duration/confidence when unavailable; unanswered rubric components score zero. |
| Tool failure           | Record a bounded failure code; apply the predeclared retry rule and do not impute an answer.                              |
| Unsupported task       | Count separately; exclude from objective participant correctness rather than treating it as a participant error.          |
| Unsupported conclusion | Preserve in submitted/additional claims for human coding; do not infer it from a wrong answer or automate the judgment.   |

Do not exclude a failed task after seeing an answer without recording the
predeclared reason and analysis denominator.

## Result file and privacy

Use a JSON document with `schemaVersion: 1`, a study version such as
`CT-EVAL-001A-v1`, and a `results` array. Each result requires a random
pseudonymous token in the form `P-` followed by 16 uppercase hexadecimal
characters, task/condition/order, duration and its observed/censored/missing
status, submitted answer, structured objective claims, evidence references,
additional claims, confidence, completion status, and `toolFailureCode`,
`missingReasonCode`, and `unsupportedReasonCode` fields that are null or
required according to the outcome. Every record has
`humanScoringStatus: "AWAITING_HUMAN_SCORING"`. Extra properties are rejected;
the schema has no name or email fields. Free text can still contain personal
details, so keep raw results private and review approved data handling before
collection. Do not put participant data in the task bank, fixtures, issue, pull
request, or source control.

Store approved local result files only in the ignored `local-study-data/`
directory. Set access, encryption, retention and deletion rules before
collection. The scorer accepts a bounded local file, validates task assignment
and evidence references, and emits aggregates by task and condition only. It
omits participant tokens and answer text. Small groups can still be
re-identifiable; keep outputs private and follow institutional policy. No
network service or telemetry is used.

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
unsupported conclusions and confidence. Do not impute missing answers or convert
a tool failure into a participant failure.

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
