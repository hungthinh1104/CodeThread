# Architecture, database and API readiness review

**Review period:** 2026-11-03 to 2026-11-04

**Verified base:** `origin/main` `2c64e43428a1ddcf7407cdaaeb3ec16c04aaa9fa`
**Review scope:** implementation truth, DB-01 design consistency, runtime/API
boundaries, source cache, security and next gates. This is not a DB-02
authorization.

## A. Executive assessment

The semantic core is deliberately independent of transport and persistence. The
current supported workflow is real: explicitly selected committed TypeScript
files or a caller-supplied immutable manifest flow through a bounded analyzer,
an in-memory trace engine and either the textual CLI or an optional local
browser viewer. Exact facts carry source evidence and explicit uncertainty. The
viewer uses the same trace engine; no second graph implementation was found.

The first confirmed design issue was that semantic identity intentionally
excludes Git object identity, while the earlier `RepositorySnapshot` and
`SourceFile` rows stored one commit/tree/blob/mode. Two acquisitions with the
same selected paths and bytes can reuse one semantic snapshot, so those rows
could not truthfully retain both acquisitions. The corrected model places
commit/tree on `ScanJob` and per-path blob/mode on `ScanInputFile`; semantic
snapshot identity remains unchanged.

This independent CT-ARCH-001 pass found a second related gap: the proposed job
did not retain the exact accepted revision selector and pinned configuration /
analyzer context, and it left retries ambiguous when reference resolution failed
before a commit existed. The architecture and ADR now distinguish those values
and specify that such a job cannot be retried against a moved ref. The pass also
reconciled the logical `SourceFile` dictionary with the indexer's strict UTF-8
boundary: invalidly encoded inputs fail before a semantic snapshot exists and
therefore cannot be published as snapshot files.

No PostgreSQL package, migration, database adapter, cache service, persistent
backend or external HTTP API exists. That is an explicit phase boundary, not a
current implementation defect. Logical integrity, concurrency, recovery and SQL
behavior remain untested until their implementation gates.

**Database design result:** `DESIGN_CONSISTENT` after the provenance and retry
context corrections described below. This is a logical design result only; no
PostgreSQL behavior has been verified.

**DB-02 gate:** the design is **READY_FOR_APPROVAL**, not authorization.
Persistence is not justified as the immediate next product milestone by this
audit; continue the bounded visual-versus-textual comprehension evaluation while
the in-memory workflow is usable. Any DB-02 work still requires explicit user
authorization.

## B. Verified repository state

- The initial audit preflight on 2026-11-03 fetched `origin/main` at
  `2c64e43428a1ddcf7407cdaaeb3ec16c04aaa9fa`, the merge commit for PR #14. Local
  `HEAD` was `bb90d48ca553905450cb72e3a3de42ed79e23592`; both commits have tree
  `2180fce64f3ce3c89157a9ad7f37082cada7672d`.
- The CT-ARCH-001 delivery preflight on 2026-11-04 ran `git fetch origin main`;
  `FETCH_HEAD` and `origin/main` both resolved to
  `2c64e43428a1ddcf7407cdaaeb3ec16c04aaa9fa`. The local branch at preflight was
  `fix/ct-view-interaction-selection`; the five documentation edits in section G
  were uncommitted and were preserved. No open PR existed at that preflight. The
  only open issue found was #4 (external semantic evaluation), unrelated to this
  audit. The current CT-ARCH-001 task explicitly authorizes its own scoped
  Issue, branch and Draft PR after verification.
- Hosted run
  [41659066690](https://github.com/hungthinh1104/CodeThread/actions/runs/41659066690)
  completed successfully on PR-head SHA
  `bb90d48ca553905450cb72e3a3de42ed79e23592`, with Windows and Ubuntu jobs. That
  tested tree is identical to `origin/main`; it is not a run attached to the
  merge SHA itself.
- The tree has four private packages: `code-model`, `contracts`,
  `symbol-indexer`, `trace-engine`; each exposes only its package root. No DB
  package, PostgreSQL/Drizzle runtime, migrations, persistence, or persistent
  source cache exists. The only HTTP server found is
  `scripts/viewer.ts:createViewer`, loopback-only and in-process.
- Pinned local tooling is Node 24.22.2 and pnpm 12.16.1. Baseline
  `pnpm req:validate` passed (26 requirements); `pnpm arch:check` passed (four
  packages, no errors). Baseline `pnpm check` stopped at Vitest with 246/247
  tests: `tests/investigate-cli.test.ts` case “rejects ambiguous display-name
  selection and keeps uncertain calls targetless” exceeded its 10-second
  timeout. Formatting, lint, requirement validation, architecture check, build
  and typecheck completed. A prior hosted run on the same source tree passed.
  The timeout is reported, not treated as a passing local baseline.

## C. Implementation truth matrix

Design, implementation, verification and exposure are independent dimensions.
`Accepted` in a requirement file is not a design or implementation status.

| Capability                                                           | Design status                                                            | Implementation status                                                                                               | Verification status                                                                                                                                | Exposure / notes                                         |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Git source acquisition (`CT-SOURCE-001`)                             | Accepted local acquisition ADR                                           | Implemented in `scripts/git-source.ts`                                                                              | Disposable Git integration regressions exist; final local `pnpm check` passed 247/247; hosted CI passed on identical code tree                     | CLI only; explicit pinned revision and files, no crawler |
| Manifest ingestion (`CT-INV-001`)                                    | Accepted                                                                 | Implemented by `scripts/investigate.ts::parseManifest` and `packages/symbol-indexer/src/index.ts::analyzeManifest`  | Unit/integration fixture coverage; final local `pnpm check` passed 247/247; initial timing timeout and successful reruns are detailed in section H | CLI and package function                                 |
| Symbol indexing                                                      | Accepted bounded CT-INDEX proof; broad parent capability remains partial | Implemented subset in `packages/symbol-indexer/src/extract.ts`                                                      | Unit tests and corpus evaluation; authored labels are not independent ground truth                                                                 | Public package root + CLI                                |
| `CALLS` extraction                                                   | Accepted supported direct-call subset                                    | `packages/symbol-indexer/src/extract.ts`; supported declarations/calls, unsupported inputs remain diagnostics       | Semantic/external evals and extraction tests; limited corpus                                                                                       | Public package root + CLI                                |
| `REFERENCES` extraction                                              | Accepted narrow method-property argument subset only                     | `packages/symbol-indexer/src/extract.ts`; only the narrow method-reference subset                                   | Pinned todo and adversarial tests; no claim of broad accuracy                                                                                      | Public package root + CLI; explicit opt-in in CLI/viewer |
| Source-evidence verification                                         | Accepted                                                                 | `packages/symbol-indexer/src/verify.ts` and `packages/trace-engine/src/index.ts`; verifies retained immutable bytes | Contract, trace, CLI and viewer tests                                                                                                              | TypeScript operation, CLI and local viewer               |
| `GraphNeighbors`                                                     | Accepted shared contract                                                 | `packages/trace-engine/src/index.ts::createInvestigation.neighbors`; bounded BFS                                    | Request-aware graph result tests; viewer/browser tests                                                                                             | TypeScript operation, CLI and local viewer               |
| `FindSymbolPaths`                                                    | Accepted shared contract                                                 | `packages/trace-engine/src/index.ts::createInvestigation.paths`                                                     | Request-aware path tests                                                                                                                           | Public in-memory operation only; no CLI/HTTP route       |
| `GetSourceEvidence`                                                  | Accepted shared contract                                                 | `packages/trace-engine/src/index.ts::createInvestigation.sourceEvidence`                                            | Request/result and reader tests                                                                                                                    | TypeScript operation, CLI and local viewer               |
| `GetDiagnostics`                                                     | Accepted shared contract                                                 | `packages/contracts/src/results.ts` parser only as standalone query; facts/graph projections include diagnostics    | Contract/result validation tests                                                                                                                   | No standalone query handler or route                     |
| Test query operations (`ListTests`, `GetTestTrace`, related/reverse) | Accepted reusable contracts and optional extension                       | `packages/contracts/src/schemas.ts` and `packages/contracts/src/results.ts`; no test extractor or query adapter     | Schema/result tests using synthetic fixtures                                                                                                       | No test extraction, CLI operation, or HTTP endpoint      |
| Textual investigation                                                | Accepted `CT-INV-001`                                                    | Implemented in `scripts/investigate.ts`                                                                             | CLI tests cover real pinned investigation and safety cases; baseline timeout noted above                                                           | CLI                                                      |
| Visual investigation                                                 | Accepted `CT-VIEW-001`                                                   | Implemented in `scripts/viewer.ts`, `scripts/viewer.html`, `scripts/viewer.js` and `scripts/viewer.css`             | Unit and browser tests; hosted Windows/Ubuntu workflow passed on identical tree                                                                    | Ephemeral loopback HTTP only                             |
| Repository registration / scan-job lifecycle                         | Proposed DB design                                                       | Not implemented                                                                                                     | Not verified                                                                                                                                       | Planned only                                             |
| Snapshot/source persistence and cache                                | Proposed DB/cache design                                                 | Not implemented                                                                                                     | Not verified                                                                                                                                       | Planned only                                             |
| Publication/activation                                               | Proposed transaction protocol                                            | Not implemented                                                                                                     | Not verified                                                                                                                                       | Planned only                                             |
| DB-backed query adapters                                             | Proposed SQL access patterns                                             | Not implemented                                                                                                     | Not verified                                                                                                                                       | Planned only                                             |
| Persistent HTTP application API                                      | Not selected/implemented                                                 | Not implemented                                                                                                     | Not verified                                                                                                                                       | Planned only; viewer routes are not it                   |
| Migrations, upgrade and restore                                      | Requirements/design only                                                 | Not implemented                                                                                                     | Not verified against PostgreSQL                                                                                                                    | Planned only                                             |

## D. Database architecture assessment

### D1. Entities, ownership and V0 necessity

The logical model is a proposal in `docs/architecture.md`, not a physical
schema.

| Entity                                             | Proposed owner and cardinality                                                                         | Mutability/lifecycle                                                                               | V0 persistence necessity                                                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Repository                                         | Database/source lifecycle; one-to-many snapshots and scan jobs                                         | Stable UUID independent of moving local path; active/desired pointers mutable                      | Needed only if durable local repository history is approved                                                                   |
| AnalysisConfiguration                              | Indexing lifecycle; many snapshots may share one canonical config hash                                 | Immutable canonical config; cache manifest retained while referenced                               | Needed for reproducible persisted results                                                                                     |
| RepositorySnapshot                                 | Indexing lifecycle; repository/config own many; one semantic result may be referenced by many requests | Staging then published/failed; published payload immutable; activation separate                    | Core durable semantic payload if DB is approved                                                                               |
| ScanJob                                            | Application/operational lifecycle; repository owns many; optional result snapshot                      | Idempotent operational state, attempts, generation, cancellation/failure; request-retention policy | Needed to model request intent/retry and publication fencing                                                                  |
| ScanInputFile (review correction)                  | Scan acquisition; each successful all-or-error job has one row per admitted path                       | Immutable request provenance; no partial accepted list is committed on failed selection            | Needed to preserve Git provenance independently of reused analysis result                                                     |
| SnapshotCapability                                 | Indexer capability declaration; one row per capability/version/snapshot                                | Frozen with published snapshot                                                                     | Needed to explain partial/unsupported coverage                                                                                |
| SourceFile                                         | Semantic source manifest; snapshot owns many                                                           | Frozen path/hash/byte/UTF-16 metadata; cache stores bytes                                          | Needed for source identity, lookup and evidence bounds                                                                        |
| SourceEvidence                                     | Code model; source file owns many; evidence joins support facts                                        | Immutable verified span and extractor attribution                                                  | Needed for exact source-backed facts                                                                                          |
| CodeSymbol                                         | Code model/indexer; source file declares many; relations reference symbols                             | Immutable canonical key/declaration evidence                                                       | Needed for code investigation                                                                                                 |
| CodeRelation                                       | Trace facts; source symbol owns many occurrences; exact target optional by resolution                  | Immutable distinct source occurrences                                                              | Needed for relationship queries; never unique by endpoint pair                                                                |
| RelationEvidence                                   | Typed join; one relation has one-or-more supporting evidence rows                                      | Immutable with relation                                                                            | Needed to keep site/declaration provenance relational and scoped                                                              |
| Diagnostic                                         | Extractor/lifecycle validation; snapshot owns many; optional file/evidence                             | Immutable with snapshot                                                                            | Needed for explicit uncertainty and failures                                                                                  |
| TestCase, TestStep, TestCodeLink, TestLinkEvidence | Optional test indexer/trace extension                                                                  | Would be snapshot-scoped immutable payload; hooks/syntax order do not imply execution              | Not required for current code-only V0 proof; preserve reusable contracts and gate persistence until test behavior is in scope |

### D2. Identity and provenance reconciliation

Current implementation evidence: `scripts/git-source.ts` resolves one commit and
returns `AnalysisInput` plus commit/blob/mode provenance. `analyzeManifest`
fingerprints repository UUID, source path, raw content hash/length, analyzer
identity and canonical compiler config; the Git OIDs are displayed by the CLI
but are not fed to semantic identity. Existing requirement `CT-DB-001` agrees
with that tuple.

Prior logical design mismatch: the old ERD/dictionary put commit/tree on
`RepositorySnapshot` and blob/mode on `SourceFile`, even though the snapshot
uniqueness key omits those OIDs. Two distinct commits with the same selected
path/bytes therefore share semantic identity but cannot be represented by one
commit/tree and one blob/mode set. This is a confirmed design inconsistency, not
a currently observed runtime/database corruption because no database
implementation exists.

**Recommended representation, now reflected in `docs/architecture.md`:**
`ScanJob` stores the resolved object format, commit and root tree;
`ScanInputFile` stores exact selected path, verified blob OID/mode and raw
SHA-256 for each admitted file. `RepositorySnapshot` and `SourceFile` store
semantic identity only. On successful publication, validate that the scan job's
selected path/hash manifest equals the shared snapshot manifest. A second job
from a different commit can reuse the existing analysis result while preserving
its own provenance. This preserves determinism and avoids a migration to make
Git identity part of the semantic key.

There is no deployed schema, so apply this before the first migration rather
than writing a schema migration now. If an implementation were created from the
old diagram, move commit/tree/blob/mode into per-request rows before publishing
it. If provenance had already been collapsed into one snapshot/file row for
multiple requests, the original per-request values might not be reconstructible;
no such data exists here. Making Git commit part of semantic identity is an
alternative, but it would duplicate equivalent analysis results and change the
identity contract without improving source semantics.

The CT-ARCH-001 re-audit found one remaining design gap: the logical `ScanJob`
record did not retain the exact caller revision selector or effective
configuration/analyzer context, and retry behavior was undefined if resolution
failed before a commit was pinned. The architecture and ADR now add those fields
and rules; this corrects the proposal before any migration, not runtime code.

The idempotency hash commits to caller intent: repository identity, exact
validated revision selector, UTF-8-byte-sorted selected paths and canonical
configuration hash. It is separate from source fingerprint and semantic snapshot
identity. The job retains the exact selector and pins its configuration and
analyzer version/build at acceptance. A repeated key with the same request hash
returns the original job before any ref resolution, even after a ref or server
build changes; a different caller payload conflicts. A retry after resolution
reuses the saved commit and analyzer build and rechecks the same request hash. A
failure before revision resolution has no immutable commit to preserve and
therefore requires a new job/idempotency key. If the pinned analyzer build is
unavailable, retry fails explicitly rather than using the current build. A new
key may acquire a new commit and still reuse an equal semantic snapshot. These
remain proposed database rules with no runtime behavior today.

### D2.1. Adversarial identity vectors

| Case                                                           | Required state and invariant                                                                                                                        | Future verification                                                                                                                                            |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Different commits, identical selected paths/bytes/config/build | Two `ScanJob` rows retain distinct commit/tree/blob provenance and reference one reusable `RepositorySnapshot`; no provenance field is overwritten. | In DB-02, acquire two disposable commits with identical selected `.ts` paths/bytes, then assert distinct per-job OIDs and the same semantic snapshot identity. |
| Same commit, different selected paths                          | The source fingerprint includes the selected path set, so the semantic snapshot identities differ.                                                  | In DB-02, select one file and then a different subset from the same commit; assert distinct manifest fingerprints and snapshots.                               |
| Same source, different compiler configuration                  | Different canonical configuration hashes produce different analysis identities. Each job points to the configuration it requested.                  | In DB-02, persist two config documents for identical source and assert different snapshot identities and matching job/snapshot config references.              |
| Same source/config, different analyzer build                   | The analyzer version/build is part of semantic identity and pinned on each request; different builds cannot share a result.                         | In DB-02, use two deterministic build identities with otherwise equal inputs and assert distinct snapshots.                                                    |
| Multiple requests reuse one semantic snapshot                  | One result may be referenced by multiple jobs; each job's acquisition provenance and activation outcome remain request-scoped and immutable.        | In DB-02/04, publish/reuse from two jobs and assert all per-job provenance remains intact after either activation.                                             |
| Missing/corrupt Git or source evidence                         | Acquisition/publication fails explicitly; no guessed commit/hash, partial selected-file provenance or working-tree substitution is accepted.        | In DB-02/04/06, remove or corrupt a selected object/cache object and assert a typed failure, no active pointer change and no partial publication.              |

The distinction required for retries is explicit in the proposal:

| Value                                      | Owner                                                                                                                                       | Retry meaning                                                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Original accepted revision selector        | Immutable `ScanJob.revision_selector` text                                                                                                  | Audit the caller's intent; never dereference it again for a pinned retry.                                                                |
| Resolved commit/tree and Git object format | `ScanJob`, nullable until resolution succeeds                                                                                               | Immutable acquisition context. If absent because resolution failed, retry needs a new job/key.                                           |
| Canonical selected paths/configuration     | Request hash over exact selector, UTF-8-sorted literal paths and `configuration_hash`; successful acquisition also has `ScanInputFile` rows | A caller retry re-presents the payload, which must hash identically. No partial `ScanInputFile` list is committed on failed acquisition. |
| Effective analyzer identity                | Version/build pinned on `ScanJob` and repeated in `RepositorySnapshot`                                                                      | Retry uses the same build; unavailable build fails rather than silently substituting the current one.                                    |
| Idempotency key and request hash           | Unique per repository on `ScanJob`                                                                                                          | Same hash returns the same logical job; changed payload returns `IDEMPOTENCY_CONFLICT`.                                                  |
| Job attempt                                | `ScanJob.attempt`                                                                                                                           | Increments only for an explicit retry of a retryable failed job; it does not change request generation.                                  |
| Writer epoch                               | Current writer ownership on staging `RepositorySnapshot`                                                                                    | Advances on takeover; every write/publication checks it, fencing prior owners.                                                           |
| Desired generation                         | Monotone `Repository.desired_generation`, copied to `ScanJob.generation`                                                                    | New intent advances it; retry preserves it; activation is conditional on the current desired job/generation.                             |

### D3. Invariant ownership

| Invariant / requirement                  | SQL/schema responsibility                                                                                               | Transaction/application/cache responsibility                                                                             | Current evidence                                              |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Analysis identity (`CT-DB-001`)          | Unique semantic tuple; nonnull format/build/config hashes; unique request key                                           | Canonical source/config hash and equivalence tests; match acquired manifest to semantic snapshot                         | Analyzer tests exist; DB enforcement absent                   |
| Snapshot isolation (`CT-DB-002`)         | Composite `(snapshot_id,id)` FKs for symbols, relations and evidence; repository-scoped pointers; child-side FK indexes | Query filters carry one explicit snapshot; negative cross-snapshot writes/reads                                          | Contract tests; no SQL tests                                  |
| Published immutability (`CT-DB-003`)     | Guards on all payload mutations; restricted roles; separate operational fields                                          | Parent locking serializes child writes with publication; negative insert/update/delete tests                             | Proposal only                                                 |
| Atomic publication (`CT-DB-004`)         | State/pointer constraints and transaction entry points                                                                  | Validate capability completeness, evidence joins, cycles, path/hash and cache readiness; publish and activate atomically | Proposal only                                                 |
| No fabricated targets (`CT-DB-005`)      | Target FK; row `CHECK` exact iff target present; nonexact diagnostic requirement                                        | Supported resolver, uncertainty and false-positive evaluations                                                           | Code/model/conformance tests; no SQL                          |
| Occurrence preservation (`CT-DB-006`)    | Unique snapshot canonical occurrence key, never endpoint-pair uniqueness                                                | Preserve separate evidence spans and retries; reject conflicting duplicate identity                                      | Analyzer/contract tests; no SQL                               |
| Evidence integrity (`CT-DB-007`)         | Composite file/hash/snapshot FKs; `0 ≤ start ≤ end`; nonnull extractor                                                  | Verify UTF-8, actual source bytes, full bounds, UTF-16/line coordinates and hash at publication/retrieval                | In-memory tests; durable cache absent                         |
| Static/runtime distinction (`CT-DB-008`) | Static evidence type; no runtime/pass fields                                                                            | Projection labels facts static; execution needs separate future data/evidence                                            | Contracts reject fabricated runtime fields; no runtime source |
| Request idempotency (`CT-DB-009`)        | `UNIQUE(repository_id,idempotency_key)`, request hash, one generation                                                   | Same canonical request returns same job; conflicting payload yields typed conflict; concurrent tests                     | Design only                                                   |
| Fenced/stale activation (`CT-DB-010`)    | Monotone generation, writer epoch and scoped pointers                                                                   | Lock/compare generation at commit; reject stale epoch; retain superseded complete result inactive                        | Design only                                                   |

PostgreSQL `CHECK` constraints cover only the row being written; publication
completeness and cross-table provenance need foreign keys where expressible plus
explicit transactional validation/guards. For nullable `(snapshot_id,target_id)`
composite references, the proposed `MATCH SIMPLE` plus a row-level resolution
check expresses exact-vs-nonexact cases; `MATCH FULL` would reject the intended
nonnull snapshot/null target. PostgreSQL does not automatically index
referencing FK columns, so child-side indexes must be reviewed against query
shapes rather than assumed. See the
[PostgreSQL 18 constraints reference](https://www.postgresql.org/docs/18/ddl-constraints.html).

### D4. Ten concurrency and failure scenarios

The following are design review scenarios, not executed database tests. The
existing protocol uses repository-scoped request generation, a fenced staging
writer, parent-row locks, atomic publication, and a snapshot retention advisory
lock.

| # / scenario                                   | Initial state and concurrent operations                                                                                                                    | Required invariant and unsafe outcome                                                                            | Proposed mechanism                                                                                                                                                                     | Existing implementation, missing test and residual risk                                                                                                                                        |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Two concurrent identical requests           | Repository exists; key is absent; two clients submit the same canonical request/key.                                                                       | One logical job/generation and one eventual result; no duplicate publication.                                    | Lock repository, unique `(repository,key)`, compare request hash; second caller reuses the same request.                                                                               | No DB implementation; missing independent-connection race test. Unique/lock behavior and retry after winner failure remain unverified.                                                         |
| 2. Same key, different payload                 | A key/request hash is already stored; another client submits a changed revision selector, file list or configuration under that key.                       | Reusing a key cannot substitute source/config or silently return the wrong request.                              | Compare canonical intent hash; return `IDEMPOTENCY_CONFLICT`; do not allocate a new generation.                                                                                        | No DB implementation; missing SQL conflict test. Canonicalization and retention/expiry policy need DB-02 review.                                                                               |
| 3. Older request finishes after newer accepted | Generation G1 is staging; G2 is accepted and becomes desired; G1 publishes later.                                                                          | G1 cannot replace the active pointer for newer intent; a valid G1 result may remain inactive.                    | Monotone desired generation and desired-job compare-and-swap in the same publication transaction.                                                                                      | No DB implementation; missing out-of-order publication test. Lock order and retry behavior unverified.                                                                                         |
| 4. Writer lease expires and takeover occurs    | Snapshot is staging under writer epoch E1; its lease expires; a second writer claims the same analysis tuple.                                              | Only one current writer mutates staging; partial stale data is not mixed into new output.                        | Lock snapshot, advance epoch, clear/restart unpublished staging atomically, assign new writer token.                                                                                   | No DB implementation; missing lease-expiry/takeover test. Clock/lease behavior and recovery after takeover failure unverified.                                                                 |
| 5. Old writer resumes after takeover           | E2 has taken ownership while paused E1 still holds an old token; E1 resumes a batch or publish.                                                            | Old epoch cannot write or activate.                                                                              | Every batch and publication verifies current job, lease and epoch; reject E1.                                                                                                          | No DB implementation; missing stale-token test. A missed guard on any write path would bypass fencing.                                                                                         |
| 6. Process crashes during batch persistence    | Earlier batches may be committed to invisible staging; current transaction is interrupted; a retry starts.                                                 | No partial transaction is visible; retry does not duplicate or mix partial facts.                                | Transaction rollback for interrupted batch; staging remains invisible; fenced retry increments attempt/epoch and resets unpublished partial result.                                    | No DB implementation; missing kill/rollback/retry test. Crash timing and externally visible job state require verification.                                                                    |
| 7. Publication races child writes              | Writer batch starts while publisher validates and transitions the same staging parent.                                                                     | Publication validates a stable complete child set; no child commits after validation but before publication.     | Batch takes parent `FOR SHARE` and checks writer state; publisher takes parent `FOR UPDATE`, waits, validates, and commits.                                                            | Reasoned lock plan only; missing two-connection race test. Trigger/lock interaction, lock upgrades and deadlocks unverified.                                                                   |
| 8. Reader during staging/publication           | Reader queries while batches commit and publication changes state/pointer.                                                                                 | Readers see no staging rows or partially published payload; one snapshot ID is used throughout.                  | Queries require published state; publication and pointer update share one transaction; readers resolve the active snapshot once.                                                       | No DB implementation; missing concurrent visibility/rollback test. Cross-query consistency depends on actual isolation and statement order.                                                    |
| 9. Retention races reader or activation        | Reader holds a snapshot; purge begins; an activation transaction may also change active/desired pointers.                                                  | Active, desired or in-use source/evidence is not deleted; readers do not fetch stale metadata then missing rows. | Lock order Repository → retention advisory → Snapshot → ScanJob; active/desired protection; reader shared lock through bounded cache read; delete whole snapshot then offline GC.      | No DB implementation; missing read/purge/activation race tests. Hash collisions, timeout behavior and interaction with generation locks remain unverified.                                     |
| 10. Cache readiness versus DB commit           | Required cache object is verified; publication is about to commit while a writer/GC/crash can affect cache state; later corruption may occur after commit. | No publication references an object never durably written; later loss never yields replacement text.             | Verify temp object, flush and atomic rename before DB commit; coordinate GC with scan/publication; DB failure may leave orphan; later loss returns typed unavailability/hash mismatch. | No DB/cache implementation; missing crash/corruption/restore test. Filesystem and PostgreSQL cannot share one atomic commit, so post-commit media loss remains an explicit recovery condition. |

PostgreSQL lock ordering reduces deadlocks but does not prove their absence;
deadlocks and serialization failures need whole-transaction retry rules, bounded
attempts and observability. The architecture proposes `READ COMMITTED` read-only
multi-query projections held against retention by transaction advisory locks;
this must be tested against the actual isolation/query sequence. PostgreSQL
requires the application to retry the entire transaction after serialization
failure and recommends consistent lock ordering; see
[explicit locking](https://www.postgresql.org/docs/18/explicit-locking.html) and
[serialization failure handling](https://www.postgresql.org/docs/18/mvcc-serialization-failure-handling.html).

### D5. Source cache and recovery

The proposal keeps source/config bytes in a private local content-addressed
cache and metadata in PostgreSQL. Required write order: write a temporary file
within cache root; verify raw hash/length; flush and atomically rename on the
same filesystem; only then allow DB publication to commit. A crash before DB
commit may leave safe unreferenced cache objects. A database transaction cannot
atomically commit a filesystem rename: later missing/corrupt objects must return
`SOURCE_UNAVAILABLE`/`HASH_MISMATCH`, never substitute current worktree source.

Retention remains manual/offline initially. Protect active snapshots and in-use
reads, purge whole eligible snapshots transactionally, then run delayed
mark/sweep only after scan/cache writers are paused and the live object set is
rebuilt from retained snapshots, staging inputs and configurations. Backup must
pin a consistent retained set and include the DB plus all referenced
source/config manifests and content objects. Restore to isolation, verify
hashes/references, then run representative source/query checks. PostgreSQL
documents multiple backup mechanisms and their assumptions; a DB dump alone does
not include this external cache. The actual cache, garbage collector, backup
bundle and restore drill are unimplemented.

### D6. DB-02 readiness and scope

**Design result: `DESIGN_CONSISTENT`. DB-02 status: `READY_FOR_APPROVAL` (design
only; not authorization).** The logical model, source identity, acquisition
provenance, retry context, invariant ownership, bounded query plan and failure
scenarios are now internally reconciled. The proposed minimum persistence core
is Repository, AnalysisConfiguration, RepositorySnapshot, ScanJob,
ScanInputFile, SnapshotCapability, SourceFile, SourceEvidence, CodeSymbol,
CodeRelation, RelationEvidence and Diagnostic. Keep `TestCase`, `TestStep`,
`TestCodeLink` and `TestLinkEvidence` as an optional schema extension until safe
test behavior extraction/persistence is an approved product need; keep their
reusable contracts intact.

Before implementation, human approval must review and approve the explicit
request-hash/revision retry rule, decide whether historical snapshots solve a
measured V0 need, decide the optional test-table gate and approve the
PostgreSQL/Drizzle/toolchain choices. DB-02 acceptance must include fresh
database creation and negative tests for cross-snapshot FKs, exact
target/resolution mismatch, duplicate occurrences, evidence hash/range mismatch,
immutable published payload, null composite target semantics and `ScanJob` reuse
with distinct commit/blob provenance. DB-04 adds
concurrency/interruption/fencing tests; DB-05 benchmarks; DB-06 privilege,
upgrade and restore verification. No PostgreSQL integration test has run in this
review.

## E. Backend and security assessment

### Runtime ownership

Actual pipeline:

```text
explicit manifest or Git object selection
  → analyzeManifest (validation + bounded compiler worker)
  → immutable AnalysisSnapshot (facts + retained source)
  → createInvestigation (validated in-memory query/evidence)
  → CLI text or viewer transport projection
```

The Git adapter owns trusted host Git invocation and immutable object
acquisition. The symbol indexer owns semantic extraction and source validation.
The trace engine owns graph expansion and source-reader comparison. The CLI owns
argument/session orchestration and terminal-safe text. The local HTTP viewer
owns token/Host/Origin checks, HTTP bounds and transport error mapping; it does
not own extraction or graph semantics. There is no application service,
repository authorization store, connection pool, database adapter, migration
runner, or persistent API.

### Current boundary observations

- **CONFIRMED:** viewer request/response limits, loopback binding,
  Host/Origin/session token checks, CSP, no CORS, timeouts and connection cap
  are implemented in `scripts/viewer.ts`; unit/browser tests exist. This is one
  local-user process, not multi-user authorization.
- **CONFIRMED:** viewer symbol-search offset pagination (`offset ≤ 2000`, 50
  rows) is adapter-local; shared query contracts use snapshot/filter-bound
  cursors. They serve different UI and semantic needs.
- **CONFIRMED / intentional:** viewer errors use nested
  `{error:{code,message}}`, HTTP statuses and shorter messages; shared
  `queryErrorSchema` is flat and is not wired to this local HTTP adapter. The
  viewer has a transport mapping layer.
- **RISK, low severity:** `createInvestigation().neighbors` already validates
  its own result and the viewer parses it again. This duplicates a bounded
  structural parse at a trust boundary; no incorrect behavior was reproduced. It
  provides a second transport-boundary check and is not changed in this review.
- **CONFIRMED:** interactive CLI recovers from a command error; piped/batch CLI
  writes the typed error, sets exit status 2 and stops. Git acquisition
  cancellation exits 130. No error is silently converted to an empty successful
  graph.
- **UNKNOWN / not applicable today:** production telemetry, request-level
  end-to-end cancellation and external authorization are not supplied by this
  local ephemeral workflow. A future service must decide them rather than
  inheriting loopback assumptions.

For any later application service, preserve
`transport → application orchestration → semantic/query interfaces → persistence adapters`.
Keep DB row types out of shared public contracts and never duplicate graph
traversal in an HTTP handler. No server framework is required by today's
process. Compare Fastify/NestJS/built-in HTTP only when an authorized persistent
service has real routing, validation, lifecycle and operational requirements.

### Security and failure boundaries

The present viewer is bounded and local, but its random token is not user
identity. If a persistent or remotely reachable API is approved, object IDs and
repository/snapshot IDs require repository-scoped object authorization on every
operation, plus least-privilege DB roles, query and statement timeouts, bounded
paging/batching/response sizes, cancellation, idempotent writes, sanitized
errors, and logs that exclude source excerpts, tokens and connection strings.
This is a future security gate, not a demonstrated vulnerability in the loopback
viewer. OWASP identifies object-level authorization and resource-consumption
limits as API risks; the proposed service must add explicit controls before
external exposure.

The Git source adapter's threat model assumes the local Git executable and
repository metadata are trusted; this is documented in `AGENTS.md` and ADR-0004.
The CLI invokes no repository scripts, package managers or filters and uses
explicit object reads. That does not sandbox malicious local Git metadata or a
compromised Git executable; the design explicitly rejects alternate object
stores and linked worktrees.

## F. Findings register

| ID / severity / status                                            | Evidence and expected invariant                                                                                                                                                                                                                                              | Observed impact                                                                                                                                                                              | Smallest correction / regression / milestone                                                                                                                                                                                             | Decision                                           |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `DBR-001` — P1, **CONFIRMED** design inconsistency                | Prior `docs/architecture.md` ERD/dictionary put Git commit/tree on `RepositorySnapshot` and blob/mode on `SourceFile` (old lines 133–174 and 308–311). `CT-DB-001` identity excludes those OIDs; `scripts/git-source.ts` returns provenance separately from `AnalysisInput`. | Same semantic snapshot can be acquired from different commits/object formats/modes; one row could not preserve every acquisition. Runtime DB corruption is not claimed because no DB exists. | Corrected architecture/ADR to `ScanJob` + `ScanInputFile`, retaining source fingerprint. DB-02 regression: two commits, identical selected path/bytes, distinct provenance, same semantic snapshot, then verify both jobs' provenance.   | Human approval required before migrations.         |
| `DBR-004` - P1, **CONFIRMED design gap; corrected**               | The proposed `ScanJob` omitted the exact accepted revision selector and pinned configuration/analyzer context; retry after pre-resolution failure had no immutable commit.                                                                                                   | A future retry could resolve a moved ref or silently use a changed analyzer build. No runtime DB exists.                                                                                     | Added selector, configuration hash and analyzer version/build to `ScanJob`; pinned retries reuse commit/build, while pre-resolution failure requires a new key. DB-02 tests cover moved refs, analyzer changes and unresolved selectors. | Human approval of this rule before DB-02.          |
| `DBR-005` - P2, **CONFIRMED design mismatch; corrected**          | `packages/symbol-indexer/src/index.ts` throws `INVALID_ENCODING` before producing a snapshot, while the logical dictionary allowed an invalid-UTF-8 `SourceFile` with nullable UTF-16 length.                                                                                | A published semantic file could claim a fact for input that the current analyzer rejects; no runtime DB exists.                                                                              | Restricted `SourceFile` to strictly decoded UTF-8 inputs with required UTF-16 length. Record `INVALID_ENCODING` as a terminal `ScanJob` error and create no snapshot evidence. Add a DB-02 negative test.                                | No DB implementation; correction is pre-migration. |
| `DBR-002` — P2, **RISK**                                          | Logical model includes four test entities; no test indexer/query runtime exists; reusable test contracts are present.                                                                                                                                                        | Including optional tables in the first schema adds migration/constraint surface without current code-only V0 use.                                                                            | Keep model/contracts; gate persistence until optional test behavior is accepted. DB-02 scope review and tests only when that capability enters scope.                                                                                    | Product scope decision at DB-02 gate.              |
| `DBR-003` — P2, **RISK**                                          | `docs/architecture.md` defines lock order, `FOR SHARE`/`FOR UPDATE`, generation checks and advisory retention locks but no SQL exists.                                                                                                                                       | Semantics may be sound on paper but races, deadlocks, retries or restore gaps could invalidate publication/recovery.                                                                         | No runtime patch in this review. Execute multi-connection tests in DB-04 and isolated restore/privilege tests in DB-06.                                                                                                                  | Requires DB-02 approval and DB-04/06 gates.        |
| `API-001` — P2, **CONFIRMED** documentation gap                   | Before this review there was no canonical operation/route inventory; contracts in `packages/contracts` do not imply HTTP handlers.                                                                                                                                           | Consumers could misread planned test/diagnostic/path contracts as API endpoints or mistake viewer offsets/errors for shared query behavior.                                                  | Added `docs/api/inventory.md`; route/status tests stay in `tests/viewer.test.ts` and `tests/viewer-browser.ts`.                                                                                                                          | No product decision.                               |
| `API-002` — P3, **RISK**                                          | Viewer duplicates neighbor-result parsing after trace-engine validation (`scripts/viewer.ts` route vs `packages/trace-engine/src/index.ts`).                                                                                                                                 | Small extra CPU/validation maintenance, with no reproduced defect.                                                                                                                           | Keep as boundary defense; reconsider only with profiling or a single shared transport-validation owner. Existing parity tests.                                                                                                           | None.                                              |
| `API-003` - P2, **CONFIRMED documentation gap; corrected**        | The initial inventory described runtime status but did not map every operation row to its owning implementation file.                                                                                                                                                        | Reviewers could not directly trace a contract or route to its runtime owner.                                                                                                                 | Added contract schema/parser, trace-engine, CLI, demo/evaluation and viewer file/function ownership crosswalks to `docs/api/inventory.md`. Recheck route/schema mapping when it changes.                                                 | No product decision.                               |
| `SEC-001` — P2, **RISK only if scope expands**                    | Viewer has a local random token but no user/repository authorization model; it is loopback-only and ephemeral today.                                                                                                                                                         | Exposing these handlers remotely or multi-user would allow client-selected IDs without an authorization system. No current external exposure found.                                          | Do not expose viewer. Before a persistent API, add object-level authorization, quotas, query timeouts, cancellation, least privilege and negative auth tests.                                                                            | Separate future API authorization gate.            |
| `VERIFY-001` — P2, **CONFIRMED local run failure; reruns passed** | Initial baseline `pnpm check` reported 246/247 tests; one CLI case exceeded 10 seconds. The isolated case passed in 4.23 seconds and the final full suite passed 247/247. Prior hosted same-tree Windows/Ubuntu CI passed.                                                   | A single full run exposed timing sensitivity under suite load; no correctness failure reproduced and no test timeout/assertion was changed.                                                  | Keep the failure visible in review evidence; retain the focused and full rerun results. If it recurs, profile the CLI test/process cost rather than raising the timeout without evidence.                                                | No product decision.                               |

No P0 finding or confirmed runtime security defect was established.

## G. Documentation changes

- `docs/architecture.md`: corrected logical provenance ownership, added
  `ScanInputFile`, clarified that Git OIDs/modes remain outside semantic
  identity, and linked the audit/inventory.
- `docs/decisions/0001-analysis-identity-and-source-retention.md`: records the
  per-request provenance recommendation, alternatives, idempotency retry
  behavior, failure modes and required validation while retaining proposed
  status.
- `docs/api/inventory.md`: canonical inventory for shared contracts, public
  TS/CLI operations and only the actual viewer routes; documents validation,
  errors, bounds, compatibility, tests and no-OpenAPI decision.
- `docs/reviews/architecture-api-db-readiness.md`: evidence and gate report,
  including implementation truth, DB integrity and concurrency review, cache
  recovery, security, findings and roadmap.
- `README.md`: links the two canonical new docs.

No requirement lifecycle, semantic gold label, package, lockfile, runtime
source, service, endpoint, migration or database dependency was changed. No
duplicate `contracts.md` or machine-readable inventory was added; no CI parity
is claimed. The associated GitHub Issue, scoped branch and Draft PR track this
documentation-only delivery; no merge or repository-setting change is included.

## H. Verification evidence

| Verification                                                              | Result                                                                                                                                                                                                                               | Evidence tier / limitation                                                                                          |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `git fetch origin --prune`; `git diff HEAD origin/main --exit-code`       | Fetch succeeded; code tree identical; clean initial worktree                                                                                                                                                                         | Repository state, not code validation                                                                               |
| `pnpm req:validate`                                                       | Pass; `{"valid":true,"count":26}`                                                                                                                                                                                                    | Local baseline                                                                                                      |
| `pnpm arch:check`                                                         | Pass; four packages, zero errors                                                                                                                                                                                                     | Local baseline                                                                                                      |
| `pnpm check`                                                              | Fresh run on 2026-11-04 passed: format, lint, requirements, architecture, build, typecheck, and all 247 tests across 19 files                                                                                                        | Local final-tree evidence. A prior run timed out once under the full-suite Windows load; no assertion was weakened. |
| Focused `tests/investigate-cli.test.ts` case                              | 1 passed, 21 skipped; 4.23 seconds                                                                                                                                                                                                   | The case that timed out under full-suite load passed independently                                                  |
| `pnpm test:browser`                                                       | Fresh run on 2026-11-04 passed pinned todo `REFERENCES`, tinyexec `CALLS`, follow/back, uncertainty, evidence and safe-rendering workflow                                                                                            | Local browser integration with installed Playwright browser                                                         |
| `pnpm eval:semantic`                                                      | Fresh run on 2026-11-04 passed; 22 declarations/30 gold calls; 13 exact correct of 13 predicted exact; 0 wrong targets, 0 missed resolvable, 0 evidence mismatches; unresolved 4/17 eligible; unsupported 13                         | Corpus authored by Codex and not independently reviewed; narrow supported denominator only                          |
| `pnpm eval:external`                                                      | Fresh run on 2026-11-04 passed both gates. tinyexec: 2/13 calls eligible, 1 exact, 1 unresolved, 11 unsupported. ts-node-todo: 4/35 eligible, 1 exact, 3 unresolved, 31 unsupported. No wrong/missed targets or evidence mismatches. | Pinned sources; labels not independently reviewed. This confirms narrow-scope behavior, not general accuracy.       |
| `pnpm security:check`                                                     | Fresh native pnpm audit on 2026-11-04 passed: no known vulnerabilities found                                                                                                                                                         | The request required network access to npm's advisory service; no advisory was suppressed.                          |
| `git diff --check`                                                        | Pass on 2026-11-04                                                                                                                                                                                                                   | Local documentation diff; lockfile remains unchanged                                                                |
| Hosted Windows/Ubuntu Actions                                             | Passed on `bb90d48ca553905450cb72e3a3de42ed79e23592`, tree identical to base `origin/main` merge SHA                                                                                                                                 | [Run 41659066690](https://github.com/hungthinh1104/CodeThread/actions/runs/41659066690); not attached to merge SHA  |
| PostgreSQL migrations, SQL constraints, concurrency, cache backup/restore | Not run; implementation does not exist                                                                                                                                                                                               | No DB integration evidence                                                                                          |
| Independent semantic labeling / user study                                | Not performed                                                                                                                                                                                                                        | External labels remain unreviewed; no accuracy/generalization/comprehension claim                                   |

## I. Roadmap and recommendation

1. **Gate 0 — Foundation and current local workflow:** already integrated; rerun
   local checks and continue fixing verification flakiness only if reproduced as
   a genuine defect.
2. **Gate 1 — Architecture/API inventory reconciled:** complete as local review
   documentation; human review should confirm provenance ownership and optional
   test-table gate.
3. **Gate 2 — CT-EVAL-001A candidate:** after independent human review of this
   audit, continue with the bounded IDE/text/visual comprehension comparison
   using the current in-memory viewer. Decide from measured tasks whether
   durable cross-session history/cache reuse is required. This milestone is a
   candidate only; it is not started by this audit. `READY_FOR_APPROVAL` is not
   authorization.
4. **Gate 3 — DB-02, if approved:** create database package, pin compatible
   PostgreSQL 18/Drizzle/`pg`, implement reviewed schema/migration, and add
   negative fresh-database integrity tests, including reuse of one semantic
   result across multiple Git acquisitions.
5. **Gate 4 — DB-03/04:** smallest storage/query adapter followed by
   publication, concurrency, retries, cancellation and retention failure tests.
6. **Gate 5 — DB-05/06:** workload benchmarks, privileges, upgrade and isolated
   database-plus-cache restore drill.
7. **Gate 6 — persistent application API:** only after DB gates and object
   authorization are satisfied; add OpenAPI if stable HTTP consumers justify it.
   Do not create a service just to fill the architecture diagram.

## J. Decision required

DB-02 remains unapproved. Before it starts, the user must explicitly decide
whether persistent historical snapshots/cache serve the next product or research
objective and approve the reconciled provenance/idempotency design. This
review's GO means the architecture/API audit is ready for independent human
review; it does not authorize DB-02 or a merge.

CT-EVAL-001A is the next candidate after that review; it is not implemented
here. No backend, database, durable source cache or persistent API has been
implemented.
