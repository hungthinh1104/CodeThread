# CodeThread architecture and DB-01 design

This document defines the Foundation and proposed database design for the local,
single-developer V0. It is a logical design, not evidence that PostgreSQL
enforces these rules. Production migrations and persistence behavior start only
after DB-01 approval. Requirement lifecycle is not execution status.

## 1. Product and ownership

The investigation flow is repository revision → source file/module/symbol or
supported entry point → supported relationships → related declarations → exact
source and provenance. No test is required. Optional test analysis adds
behavior, setup/actions/mocks/conditions/assertions and code-to-test navigation.
Linear and graphical views consume the same projection. Independent evaluation
compares IDE baseline, textual trace and an information-equivalent visual trace.
No comprehension benefit is claimed by implementation tests.

Current packages:

| Owner              | Behavior                                                                                                        | Dependencies                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| code-model         | Source ranges, analysis identity components, evidence and resolution validation, semantic projection primitives | Zod only; no filesystem, database, UI, Jest or NestJS dependency |
| contracts          | Runtime-validated read requests/projections, scoped cursors, bounds, trace reference validation                 | code-model and Zod                                               |
| symbol-indexer     | Bounded manifest validation, isolated TypeScript extraction and retained source                                 | code-model, pinned TypeScript and explicitly allowed Node APIs   |
| trace-engine       | Source-verified, bounded in-memory graph exploration                                                            | code-model, contracts and Node crypto; no compiler or filesystem |
| Foundation scripts | Requirements and package-boundary verification                                                                  | Node, TypeScript API, YAML and Ajv                               |

Data flows from source ingestion/semantic extraction → code model →
tracing/query behavior → transport/presentation. Code dependencies point from
consumers toward the framework-independent model; the model never imports its
extractors. Future code dependency direction is transport → application
orchestration → semantic modules. Symbol/test indexers produce code-model facts;
trace-engine consumes facts, not framework AST internals. Database owns
adapters, not semantic rules. API uses contracts rather than exposing Drizzle
rows. UI uses contracts/API rather than the database. No Next.js backend
duplicates Fastify/application rules.

`arch:check` checks source imports/re-exports, literal dynamic imports,
import-type references, declared dependencies, package cycles and public-root
imports. It rejects CommonJS and nonliteral dynamic imports in these packages.
Its explicit ownership allowlist must change deliberately when real modules are
introduced. It is a source architecture guard, not a sandbox for running
analyzed repositories.

## 2. Canonical language

**Repository:** a locally registered Git source lineage, with an identity that
does not change when its location moves. A matching remote URL alone does not
merge two registrations automatically.

**Source revision:** the resolved immutable Git commit and tree. Branch names
are input selectors, never durable snapshot identities.

**Analysis identity:** repository + source fingerprint + analyzer
version/build + canonical analysis configuration hash. Two configurations at one
commit can produce different indexed snapshots.

**RepositorySnapshot:** one indexed analysis result, mutable only while staging.
Published snapshots remain readable historically even when inactive.

**ScanJob:** one idempotent request and its operational progress. It is separate
from the shared analysis result that multiple requests may reuse.

**Exact resolution:** a source-level semantic target established by a supported
extractor. It does not prove a runtime call. An unresolved site is retained as a
site with diagnostics, not converted into an exact edge.

**SourceEvidence:** a typed, extractor-attributed span in immutable source
bytes. It supports a fact without proving the fact executed.

**Coverage:** complete, partial, not_analyzed or unsupported relative to a
versioned declared capability and source scope. Complete does not mean all
language behavior is known.

**TestStep:** syntax/semantic information attached to one test, including
contextual hooks. Its phase and syntax ordinal do not establish runtime order.

## 3. Conceptual and logical models

RepositorySnapshot, SourceFile, CodeSymbol, CodeRelation, SourceEvidence and
Diagnostic form the code-comprehension core. TestCase/TestStep/TestCodeLink are
an optional extension. Existing test-oriented read projections remain reusable;
they are not the sole future investigation API. The logical database proposal
remains unimplemented and must be reviewed against the semantic proof before
DB-02.

```mermaid
erDiagram
    Repository ||--o{ RepositorySnapshot : owns
    Repository ||--o{ ScanJob : requests
    AnalysisConfiguration ||--o{ RepositorySnapshot : configures
    RepositorySnapshot ||--o{ SourceFile : indexes
    RepositorySnapshot ||--o{ SnapshotCapability : declares
    RepositorySnapshot ||--o{ Diagnostic : reports
    SourceFile ||--o{ SourceEvidence : locates
    SourceFile ||--o{ CodeSymbol : declares
    SourceFile ||--o{ TestCase : declares
    TestCase ||--o{ TestStep : contextualizes
    TestStep ||--o{ TestCodeLink : originates
    CodeSymbol ||--o{ CodeRelation : originates
    CodeSymbol o|--o{ CodeRelation : resolves_target
    CodeSymbol o|--o{ TestCodeLink : resolves_target
    CodeRelation ||--|{ RelationEvidence : supported_by
    TestCodeLink ||--|{ TestLinkEvidence : supported_by
    SourceEvidence ||--o{ RelationEvidence : supports
    SourceEvidence ||--o{ TestLinkEvidence : supports
```

SnapshotCapability is a capability/coverage association, not a status lookup
table. Its real purpose is to distinguish complete test extraction from, for
example, partial semantic linking in the same snapshot. Minimum-one support
multiplicities are publication invariants; foreign keys alone do not establish a
nonempty join.

```mermaid
erDiagram
    Repository {
        uuid id PK
        text local_locator
        bigint desired_generation
        uuid desired_scan_job_id FK
        uuid active_snapshot_id FK
    }
    AnalysisConfiguration {
        text hash PK
        integer format_version
        text compiler_version
        text resolver_policy_version
    }
    RepositorySnapshot {
        uuid id PK
        uuid repository_id FK
        text source_fingerprint
        text git_commit_oid
        text git_tree_oid
        text analyzer_version
        text analyzer_build_hash
        text configuration_hash FK
        text state
        text coverage
        uuid writer_job_id FK
        bigint writer_epoch
        timestamptz writer_lease_until
    }
    ScanJob {
        uuid id PK
        uuid repository_id FK
        uuid snapshot_id FK
        text idempotency_key
        text request_hash
        bigint generation
        text state
        integer attempt
        text activation_result
    }
    SnapshotCapability {
        uuid snapshot_id PK,FK
        text capability_key PK
        text capability_version
        text coverage
        bigint eligible_count
        bigint analyzed_count
        bigint excluded_count
    }
    SourceFile {
        uuid snapshot_id PK,FK
        uuid id PK
        text path
        text content_hash
        text git_blob_oid
        integer git_mode
        bigint byte_length
        bigint utf16_length
        text encoding
        text role
        text coverage
    }
    SourceEvidence {
        uuid snapshot_id PK,FK
        uuid id PK
        uuid file_id FK
        text content_hash FK
        bigint start_utf16
        bigint end_utf16
        integer start_line
        integer start_column
        integer end_line
        integer end_column
        text extractor_name
        text extractor_version
        text kind
    }
    CodeSymbol {
        uuid snapshot_id PK,FK
        uuid id PK
        uuid file_id FK
        text canonical_key
        text name
        text kind
        uuid declaration_evidence_id FK
    }
    CodeRelation {
        uuid snapshot_id PK,FK
        uuid id PK
        uuid source_symbol_id FK
        uuid target_symbol_id FK
        text canonical_key
        text kind
        text resolution
        uuid site_evidence_id FK
        uuid primary_diagnostic_id FK
    }
    RelationEvidence {
        uuid snapshot_id PK,FK
        uuid relation_id PK,FK
        uuid evidence_id PK,FK
    }
    TestCase {
        uuid snapshot_id PK,FK
        uuid id PK
        uuid file_id FK
        text canonical_key
        text name
        text_array suite_path
        uuid declaration_evidence_id FK
        text parameterization
        text case_key
    }
    TestStep {
        uuid snapshot_id PK,FK
        uuid id PK
        uuid test_id FK
        uuid parent_step_id FK
        text canonical_key
        text kind
        text phase
        integer syntax_ordinal
        uuid source_evidence_id FK
    }
    TestCodeLink {
        uuid snapshot_id PK,FK
        uuid id PK
        uuid test_id FK
        uuid step_id FK
        uuid target_symbol_id FK
        text canonical_key
        text kind
        text resolution
        uuid site_evidence_id FK
        uuid primary_diagnostic_id FK
    }
    TestLinkEvidence {
        uuid snapshot_id PK,FK
        uuid link_id PK,FK
        uuid evidence_id PK,FK
    }
    Diagnostic {
        uuid snapshot_id PK,FK
        uuid id PK
        uuid file_id FK
        uuid source_evidence_id FK
        text code
        text severity
        text message
    }
    Repository ||--o{ RepositorySnapshot : repository_id
    Repository ||--o{ ScanJob : repository_id
    AnalysisConfiguration ||--o{ RepositorySnapshot : configuration_hash
    RepositorySnapshot ||--o{ SourceFile : snapshot_id
    RepositorySnapshot ||--o{ SnapshotCapability : snapshot_id
    RepositorySnapshot o|--o{ ScanJob : eventual_result
    SourceFile ||--o{ SourceEvidence : snapshot_file_hash
    SourceFile ||--o{ CodeSymbol : snapshot_file
    SourceFile ||--o{ TestCase : snapshot_file
    TestCase ||--o{ TestStep : snapshot_test
    TestStep ||--o{ TestCodeLink : snapshot_test_step
    SourceEvidence ||--o{ CodeSymbol : declaration
    SourceEvidence ||--o{ TestCase : declaration
    SourceEvidence ||--o{ TestStep : source
    CodeSymbol ||--o{ CodeRelation : source
    CodeSymbol o|--o{ CodeRelation : nullable_target
    CodeSymbol o|--o{ TestCodeLink : nullable_target
    CodeRelation ||--o{ RelationEvidence : relation
    TestCodeLink ||--o{ TestLinkEvidence : link
    SourceEvidence ||--o{ RelationEvidence : evidence
    SourceEvidence ||--o{ TestLinkEvidence : evidence
    RepositorySnapshot ||--o{ Diagnostic : snapshot
    Diagnostic o|--o{ CodeRelation : primary_diagnostic
    Diagnostic o|--o{ TestCodeLink : primary_diagnostic
```

### Data dictionary and cardinalities

All graph/test/evidence identifiers are opaque application-assigned UUIDs. Their
composite `(snapshot_id, id)` key establishes scope. Content/canonical keys
provide logical uniqueness; a UUID alone does not establish semantic identity.
Timestamps are UTC `timestamptz`; API locations are integers within JavaScript's
safe range. SQL `bigint` generation counters are never transported as unsafe
JSON numbers.

| Entity / owner                                | Required data and uniqueness                                                                                                                                                                                                                                                                      | Nullable data / deletion                                                                                                                                                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository / source lifecycle                 | UUID; locator; generation ≥ 0; timestamps. One registered lineage owns many snapshots/jobs.                                                                                                                                                                                                       | Desired job and active snapshot are nullable; each must belong to this repository. Moving the locator preserves identity. Repository deletion is explicit maintenance, never a query side effect.                                       |
| AnalysisConfiguration / indexing lifecycle    | Lowercase SHA-256 PK; format/compiler/resolver versions; verified canonical configuration object in cache. It can be shared by snapshots.                                                                                                                                                         | No mutable configuration payload. Referenced configurations and cache manifests are protected; unreferenced ones are maintenance candidates.                                                                                            |
| RepositorySnapshot / indexing lifecycle       | Repository, source fingerprint, commit/tree OIDs, analyzer version/build digest, configuration hash, state, coverage, creation time. UNIQUE over repository + fingerprint + analyzer version/build + configuration hash; UNIQUE(repository_id, id) for scoped pointers.                           | Publication time is absent in staging. Writer job/lease absent before ownership and after failed cleanup. Published state and payload freeze. Active/in-use snapshots cannot be purged.                                                 |
| ScanJob / indexing lifecycle                  | Repository, nonempty bounded idempotency key, request hash, generation, state, attempt and timestamps. UNIQUE(repository_id, idempotency_key), UNIQUE(repository_id, generation), UNIQUE(repository_id, id).                                                                                      | Result snapshot, terminal error code and activation outcome absent until available. Snapshot reference must match repository. Retain jobs while needed for idempotency; explicit expiry is required before deleting keys.               |
| SnapshotCapability / indexing lifecycle       | Snapshot + capability key PK; capability version, coverage, nonnegative eligible/analyzed/excluded counts. analyzed + excluded ≤ eligible; completeness validated against the declared scope.                                                                                                     | No nullable structural fields. Frozen with snapshot; deleted only during guarded whole-snapshot purge.                                                                                                                                  |
| SourceFile / source ingestion                 | Snapshot, file UUID, exact case-preserved Git path, SHA-256 raw content hash, Git blob OID/mode, byte/UTF-16 lengths, UTF-8 encoding, source/test/declaration/config role and coverage. UNIQUE(snapshot_id, path COLLATE C); UNIQUE(snapshot_id, id, content_hash) supports evidence consistency. | Unsupported/invalid UTF-8 files have a SourceFile identity with nullable UTF-16 length and an encoding diagnostic; they cannot support text evidence. Content metadata is otherwise required. Whole-snapshot purge only.                |
| SourceEvidence / extraction                   | Snapshot, UUID, file ID/content hash composite FK, half-open UTF-16 offsets, one-based coordinates, extractor name/version and static_source kind. Row bounds: 0 ≤ start ≤ end. File bounds and coordinate agreement checked against cache at publication.                                        | No guessed source, nullable provenance or unverified content hash. Retained with the snapshot.                                                                                                                                          |
| CodeSymbol / symbol-indexer                   | Snapshot, UUID, file ID, canonical key, display name/kind and declaration evidence. UNIQUE(snapshot_id, canonical_key). Range/path projections derive from the declaration evidence/file.                                                                                                         | No unresolved placeholder symbols. Initial declarations have one authoritative evidence span; projection evidenceIds contains that span. Merged declarations requiring unsupported identity semantics remain diagnostic cases.          |
| CodeRelation / trace-engine                   | Snapshot, UUID, source symbol, occurrence key, relation kind, resolution and call-site evidence. UNIQUE(snapshot_id, canonical_key), not source/target uniqueness. Evidence join contains the site and supporting records.                                                                        | Target exists iff resolution=exact. Primary diagnostic required otherwise; exact rows have no primary diagnostic. Composite FKs scope all references.                                                                                   |
| RelationEvidence / trace-engine               | Snapshot + relation ID + evidence ID composite PK/FKs. One occurrence can have several supporting spans, one span can support several facts.                                                                                                                                                      | No nullable endpoint or JSON evidence-ID list. Publication requires ≥ 1 row and the site attachment.                                                                                                                                    |
| TestCase / test-indexer                       | Snapshot, UUID, file ID, occurrence key, display name, suite path, declaration evidence and none/static/dynamic parameterization. UNIQUE(snapshot_id, canonical_key).                                                                                                                             | case_key is null for an ordinary test or unresolved/template parameterization. Only safely extracted literal rows receive case keys; dynamic rows are never executed or invented.                                                       |
| TestStep / test-indexer                       | Snapshot, UUID, test ID, occurrence key, source evidence, kind, phase, nonnegative syntax ordinal. UNIQUE(snapshot_id, test_id, id) and UNIQUE(snapshot_id, canonical_key).                                                                                                                       | Parent step optional; FK(snapshot_id, test_id, parent_step_id) keeps containment inside one test. Publication checks containment cycles. Contextual hooks may share original evidence across tests without implying repeated execution. |
| TestCodeLink / trace-engine                   | Snapshot, UUID, test/step ownership, occurrence key, kind, resolution and site evidence. FK(snapshot_id, test_id, step_id) references the step owner.                                                                                                                                             | Target iff exact; primary diagnostic otherwise. No guessed production target. Several sites to the same symbol remain distinct.                                                                                                         |
| TestLinkEvidence / trace-engine               | Snapshot + link ID + evidence ID PK/FKs, with site attachment required at publication.                                                                                                                                                                                                            | Explicit typed join; no polymorphic reference that escapes a foreign key.                                                                                                                                                               |
| Diagnostic / extractor or lifecycle validator | Snapshot, UUID, stable code, info/warning/error severity and bounded message.                                                                                                                                                                                                                     | Optional file and evidence; evidence requires a file and must match it. Source-free repository diagnostics are allowed. No arbitrary cross-entity pointer or sensitive source payload in messages.                                      |

Additional execution runs, runtime events, AI answers, embeddings and generic
artifact registries are deliberately absent. Core structural data is relational.
Optional JSONB may describe nonauthoritative extractor details; it cannot
replace identities, FKs, occurrences, provenance or required configuration
manifests.

Required same-file constraints supplement the snapshot keys: SourceEvidence has
UNIQUE(snapshot_id,id,file_id). CodeSymbol and TestCase declaration references
use FK(snapshot_id,declaration_evidence_id,file_id), and Diagnostic's optional
evidence uses the equivalent scoped file reference. A snapshot's writer job must
belong to its repository; a staging writer cannot borrow another repository's
job or epoch. Primary diagnostic references are scoped, while additional file
diagnostics are retrieved independently. Symbol/step evidence arrays include
their explicit primary declaration/source reference and may include auxiliary
evidence from other files. Primary anchors and call sites have file/range
checks; auxiliary evidence is not forced into the primary file. Relation/link
attachments are plural.

## 4. Identity, source and evidence conventions

Resolve the selected commit to its full Git object ID and tree using argument
arrays and a fixed repository boundary. Read Git object content without checkout
filters or hooks. Submodules, symlinks and Git LFS pointer files are unsupported
until explicit capabilities define their retained content and boundaries; do not
treat their referents as ordinary tracked source.

The source fingerprint is SHA-256 over a versioned canonical manifest containing
the full commit/tree OIDs and selected Git paths, modes and raw content hashes.
Different committed revisions have different snapshot identities even when their
indexed files match; identical raw blobs still deduplicate in the cache. Include
source, tests, tsconfig references, package/lock manifests and every analysis
input in the declared scope; retain exclusions and reasons. The commit/tree OIDs
remain provenance and are not the sole analysis identity. Paths use POSIX
separators, preserve case and Unicode bytes, and are compared deterministically
without locale normalization.

AnalysisConfiguration's verified canonical cache document contains explicit
compiler/extractor versions, supported capability versions, effective compiler
options, include/exclude policy, resolver policy and resolution-input hashes.
Canonicalization recursively sorts object keys, preserves meaningful array
order, uses UTF-8 and rejects nonfinite/undefined values. Its format version is
explicit. The compiler's standard libraries belong to analyzer identity.
External declaration inputs must be retained/fingerprinted; ambient host
node_modules or current working-tree files cannot silently influence analysis.
Missing dependencies remain diagnosed unresolved inputs. Static indexing never
installs them automatically.

The in-memory proof accepts caller-supplied bytes, not a Git revision. Its
versioned source fingerprint hashes the UTF-8-byte-ordered path, raw SHA-256 and
byte length for each supplied file. Its configuration hash covers the explicit
fixed profile; its build fingerprint covers the analyzer, code model, compiler
and allowlisted library contents. A repository UUID and these components form a
deterministic proof snapshot UUID. Snapshot-local file/entity UUIDv8 values
derive from SHA-256 descriptors and duplicate identities fail validation. This
proof identity makes no commit/tree or published-database claim; reconcile its
manifest format with the Git-provenance proposal before DB-02.

Snapshot-local canonical keys use a versioned kind plus SHA-256 of an anchor
descriptor. Symbols anchor to supported canonical declarations; test keys
include suite/declaration location and any static parameter case key.
Step/link/relation descriptors include their owning test/symbol, site span and
occurrence kind. Target/display-name changes are payload changes, not a reason
to collapse a site. A duplicate key with a different payload is an integrity
error; do not use silent ON CONFLICT DO NOTHING to conceal nondeterministic
extraction.

Raw source bytes are preserved, including BOM and CRLF. Decode UTF-8 strictly
and preserve the BOM in the decoded string. Positions follow the TypeScript line
map: zero-based UTF-16 offsets and half-open [start,end), with one-based
line/column. CRLF is one line break, and columns count UTF-16 code units, not
bytes or graphemes. The executable position validator is cross-checked against
TypeScript's API. Standalone range schemas validate shape; only content-aware
validation and hash verification establish agreement with a particular immutable
file.

`createSourcePositionIndex(source)` owns a private line-start array for one
immutable string. Callers control its lifetime: O(source length) construction,
O(line count) retained map and O(log line count) positioning. The returned
object is frozen and exposes no mutable map or global cache. Range validation
uses the same structural checks and two indexed lookups. Existing convenience
interfaces retain their behavior; bulk consumers should reuse a per-file index.
The opt-in `pnpm bench:positions` compares 3,000 lookups and 3,000 validations
on deterministic 100/6,000-line CRLF/Unicode inputs, including index
construction in the indexed total. It checks results against TypeScript outside
timing, warms 25 lookups, repeats three times and reports individual timings,
medians, dataset hashes, environment and Git state. Small/large synthetic
improvements justify the explicit indexed bulk API; no ingestion pipeline exists
here to measure. Raw measurements belong to review evidence, not fixed CI
budgets.

### Content-addressed cache

The cache root is outside analyzed checkouts and synchronized working folders by
default: the user's local application cache directory under CodeThread. An
explicit CODETHREAD_CACHE_DIR override must be an absolute private directory
with verified containment. No source cache is populated by Foundation.

Cache keys are SHA-256 digests, never caller-supplied paths. Store
source/config/ manifest objects under a private local cache root outside
database tables. A future ingestion adapter writes a temporary object inside
that root, verifies its raw hash/length, flushes and atomically renames on the
same filesystem. Reject symlink/reparse escapes; verify containment using
resolved paths. The original repository can subsequently move without
invalidating retained evidence.

Before publication, all required objects and the complete manifest must be
durable and verified. A crash before database commit may leave unreferenced
cache objects; it must not leave a published snapshot pointing to an unwritten
object. Source retrieval verifies the raw hash before decoding/slicing. Missing,
corrupted or unsupported content returns an explicit typed error, with no
working-tree fallback. Excerpt text contains exactly the evidence span, capped
at 65,536 UTF-16 units; larger spans return EVIDENCE_TOO_LARGE instead of silent
elision.

## 5. Integrity enforcement matrix

| Invariant / requirement               | SQL responsibility in DB-02                                                                     | Transaction/application responsibility and evidence                                                                           |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1. Identity / CT-DB-001               | Analysis-tuple uniqueness; nonnull format/version/hash columns                                  | Canonical manifests and configuration hashes; changed-input and equivalent-input vectors                                      |
| 2. Isolation / CT-DB-002              | Composite scoped FKs/keys for every owned reference; repository-scoped active/result pointers   | Response scope validation; negative writes and scoped query tests on real PostgreSQL                                          |
| 3. Published immutability / CT-DB-003 | DML guards on snapshot children and referenced configuration; separate operational state        | Parent-row locking prevents validation/write races; negative INSERT/UPDATE/DELETE tests after publication                     |
| 4. Atomic publication / CT-DB-004     | Published-state read predicates and transactional pointer update                                | Validate minimum evidence joins, coverage counts, source availability, ownership and cycles; concurrent reader/rollback tests |
| 5. No fabrication / CT-DB-005         | CHECK exact iff target nonnull; unresolved primary diagnostic required; target and evidence FKs | Supported semantic resolver only; ambiguous/unsupported fixtures and false-positive evaluation                                |
| 6. Occurrences / CT-DB-006            | Canonical occurrence uniqueness, never endpoint-pair uniqueness                                 | Two independent spans retained; identical-key/different-payload rejection                                                     |
| 7. Evidence / CT-DB-007               | File/hash/snapshot composite FK, row bounds, nonnull extractor fields                           | Verify hash, UTF-8, full file bounds and coordinates; Unicode and corrupted-source cases                                      |
| 8. Static/runtime / CT-DB-008         | Initial evidence kind is static_source; no runtime/pass fields                                  | Typed static projections; hooks/assertions/mocks described without execution claims                                           |
| 9. Idempotency / CT-DB-009            | Repository/key uniqueness; one shared analysis tuple                                            | Canonical request comparison and explicit IDEMPOTENCY_CONFLICT; concurrent requests                                           |
| 10. Stale activation / CT-DB-010      | Monotonic generation, scoped pointer FK and writer epoch                                        | Locked compare-and-swap; stale completion and fenced-writer tests                                                             |

CHECK cannot enforce cross-table conditions, minimum join membership or
publication completeness. PostgreSQL's CHECK limitation and nullable-FK rules
are explicit in the
[PostgreSQL 18 constraint reference](https://www.postgresql.org/docs/18/ddl-constraints.html).
Use MATCH SIMPLE for nullable `(snapshot_id,target_id)` FKs: MATCH FULL would
reject the intentional nonnull snapshot/null target pair. A separate resolution
CHECK determines when the target is mandatory. Foreign keys do not automatically
index referencing columns; index choices require workload evidence.

## 6. Staging, concurrency and publication

Snapshot states are staging → published or staging → failed. An explicit fenced
retry may reset a failed unpublished result to staging. Published payloads never
return to staging. Inactive is a pointer relationship, not a mutable content
state. ScanJob states are requested, running, validating, succeeded, failed and
cancelled. Its separate activation_result is activated or superseded after
successful publication/reuse. A plain idempotent request returns the existing
job, including failures; explicit retry is a separate action. Only failed jobs
can restart, preserving generation/payload and incrementing attempt. Cancelled
jobs remain cancelled; a new intent requires a new key. Neither an old retry nor
a reused result can silently reclaim a superseded generation.

1. In a short request transaction, lock Repository, look up the repository/key,
   and compare request_hash. Identical requests reuse the existing
   job/generation; conflicts fail. A new key increments desired_generation and
   creates the desired job atomically. Job payload includes the resolved commit
   and canonical requested analysis inputs. A failed newer request does not
   silently restore older intent.
2. Find/create the unique analysis tuple. A published match can be reused
   without reindexing. A staging match has one writer_job_id, lease and
   monotonically increasing writer_epoch; other jobs wait for/reuse its result
   rather than write concurrently. No worker queue is required by this design.
3. Each bounded write batch locks the snapshot parent FOR SHARE, checks staging,
   writer identity, lease and supplied epoch, then writes transactionally.
   Parent mutation guards reject published children. Writer takeover obtains FOR
   UPDATE, advances the epoch, and atomically clears/restarts partial staging
   data before accepting another writer. Every old-token batch and publication
   must fail.
4. Publication locks Repository → Snapshot → ScanJob in that order. Write
   batches do not acquire repository locks while holding snapshot locks.
   Takeover, cancellation and maintenance follow the same ordering when both are
   needed. Under FOR UPDATE, validate all declared invariants and source
   readiness; lock exclusion prevents another child batch from changing the
   validated payload.
5. In the same transaction, mark the snapshot published and the job succeeded.
   Activate only if Repository.desired_generation equals this job's generation
   and its desired job still matches. Otherwise retain a valid inactive
   historical snapshot and mark activation superseded. Commit makes
   publication/pointer changes visible together. A waiting newer job referencing
   the same shared snapshot performs its own generation-checked activation.
6. Readers always resolve an active pointer once and carry the explicit snapshot
   ID throughout the request. Public queries reject staging/failed snapshots.
   Multi-query projections use a read-only READ COMMITTED transaction. First
   acquire a shared transaction advisory retention lock for the snapshot; only
   in the next SQL statement check published existence and read payloads.
   Immutability plus exclusive-purge exclusion keeps subsequent payload reads
   consistent. Hold the shared lock through bounded cache access, then
   commit/rollback; no reader lease table or session lock is needed. If purge
   won before the lock, the later existence check reports the missing snapshot
   instead of reading stale metadata.

FOR SHARE, rather than FOR KEY SHARE alone, prevents a non-key publication
update from racing a child write. Cross-row guards belong to reviewed SQL and
explicit transaction entry points, not application conventions alone. See
PostgreSQL's [locking](https://www.postgresql.org/docs/18/explicit-locking.html)
and [isolation](https://www.postgresql.org/docs/18/transaction-iso.html)
references.

Writer interruption leaves staging invisible. Retry reuses the logical job,
increments its attempt, claims a new epoch and restarts only its staging result.
If another request already published the shared analysis, reuse it. Expired
leases do not authorize blindly rewriting published content. Failure/error codes
and attempt history are operational data; they must not mutate an immutable
payload. Fencing and publication guards are DB-04 acceptance scenarios, not
implemented concurrency guarantees in Foundation.

### Retention and recovery

Default retention is manual, with no automatic deletion. Source/graph readers
use a shared transaction advisory lock keyed by a domain-prefixed 64-bit hash of
the snapshot UUID; a hash collision causes conservative contention, not unsafe
deletion. The narrow maintenance entry point acquires the exclusive counterpart
before rechecking intent and deleting anything. Its lock order is Repository →
retention advisory lock → Snapshot → ScanJob. Readers never acquire repository
row locks after their shared retention lock. Timeout/cancellation ends the
transaction and releases its locks; keep no pooled connection with an open
transaction.

The purge refuses active/desired snapshots, writer-owned staging and retained
idempotency references, and cannot proceed while a reader holds shared
protection. It first removes an eligible whole snapshot in a maintenance
transaction, then marks unreferenced cache objects for delayed mark/sweep. Never
recursively delete the original source repository. Individually deleting
published child records is forbidden; maintenance purge uses a separate
privileged path and preserves foreign-key integrity.

Cache-object sweeping is offline maintenance in V0: pause new scan requests,
drain indexing/publication and cache writes, then rebuild the live hash set from
all retained snapshots, staging inputs and configuration manifests before
deleting any object. Do not introduce online object GC without a writer/GC
coordination protocol and race tests. Snapshot read protection alone does not
prevent an orphan object from being reused by a concurrently publishing scan.

Backups include a database dump plus the exact referenced content/config
manifests and cache objects. Pin the retained snapshot set while creating this
bundle. Restore into isolation, verify all hashes/references, then run
representative queries and source checks before considering it usable. A
database dump alone does not recover source evidence. DB-06 owns the actual
restore drill; see the
[PostgreSQL backup reference](https://www.postgresql.org/docs/18/backup.html).

## 7. Read contracts and query access patterns

`@codethread/contracts` is the executable interface source. Inputs are validated
before querying; projections are validated before transport. IDs identify
entities, never filesystem paths. The future API validates the loopback access
boundary and rejects snapshots/entities outside the selected repository. There
is no arbitrary SQL or filesystem-reading endpoint.

Every response has snapshotId, evidenceBasis=static, declared coverage, applied
limits, truncated and truncationReasons. Partial coverage and result truncation
are independent. Per-site resolution remains visible. Response validation
rejects cross-snapshot entities, dangling graph endpoints, missing supporting
trace references, incorrect test ownership and cyclic step containment.

### Result validation boundaries and 0.0.0 compatibility

Public root exports are preserved. Intrinsic schemas now live in `schemas.ts`;
request-aware result checks live in `results.ts`, sharing typed integrity
checks. No package or runtime dependency cycle is introduced.

Repository-local consumers must supply the new required fields:
CodeSymbol.declarationEvidenceId, TestStep.sourceEvidenceId, Diagnostic.filePath
(nullable with fileId), and QueryMeta.coverageByCapability. UUIDs normalize to
lowercase; paths and canonical keys preserve their original case. Primary
evidence IDs must appear in supporting evidence arrays. Declarations match their
evidence file/range; call sites are contained by their owning declaration or
step. Evidence for one file cannot claim different content hashes or paths in a
projection.

coverageByCapability has one to thirty-two versioned keys, such as
declarations.v1, relationships.v1 and optional test_behavior.v1. States are
complete, partial, not_analyzed and unsupported. If every capability has the
same state, aggregate coverage is that state; otherwise it is partial.
Truncation remains independent, and relation resolution remains
exact/ambiguous/unresolved/unsupported. These metadata checks do not
independently prove that an extractor's classifications are true; the future
semantic evaluator supplies that evidence.

Consumers with a request must use parseListTestsResult,
parseRelatedProductionSymbolsResult, parseFindTestsForSymbolResult,
parseGetDiagnosticsResult, parseGetTestTraceResult,
parseGetSourceEvidenceResult, parseGraphNeighborsResult or
parseFindSymbolPathsResult. These parse the request and response and reject
mismatched snapshots, selections or applied limits. Related/reverse parsers
additionally require bounded supporting steps (≤1000) and evidenceRefs (≤5000),
checking ownership, known containment cycles and call sites. Generic schemas
intentionally do not guess unavailable request-specific context.

Paged results strictly advance from the incoming cursor using UTF-8 byte order
for paths/keys and numeric UTF-16 offsets. A continuation must match the
normalized request scope/filter and the final returned tuple. Diagnostic
ordering uses its explicit path, or empty path/offset zero for source-free
diagnostics. These guards prevent invalid pagination positions; complete SQL
query coverage remains DB-03 verification work.

Neighbor result validation uses bounded breadth-first reachability in the
requested direction. Edges come from an expanded frontier (distance < applied
depth); unknown targets supply no adjacency and are retained only as
outgoing/bidirectional sites. Returned path graphs contain the union of their
simple directed paths plus roots, not unrelated visited components. Empty paths
still require valid roots. Cycles are valid neighbor graph data; parallel call
occurrences remain separate records. Truncation never authorizes dangling
endpoints or disconnected returned remnants.

Source batches return exactly the requested IDs in request order, including
typed unavailability. Structural validation, matching excerpt length and
consistent metadata do not authenticate source bytes. The future source adapter
must verify raw hashes, UTF-8 and immutable cache identity before returning
available excerpts. The in-memory proof verifies its private manifest copies and
excerpts; a durable cache adapter, SQL query implementation and runtime
observation do not exist here.

| Contract                    | Inputs/defaults                                                                    | Projection and SQL access pattern                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ListTests                   | Snapshot, optional text/filePath/suite filters; limit 50, max 200; cursor          | Select tests joined to declaration evidence/files within one published snapshot. Text is a bounded literal case-insensitive substring, with LIKE metacharacters escaped; suite filter is an exact suite-path component. Order path COLLATE C, start_utf16, canonical_key. Fetch limit+1 for continuation.                                                                              |
| GetTestTrace                | Snapshot/test; ≤500 steps, ≤200 symbols, ≤1000 combined links/production relations | Return one test plus step/link/symbol/relation/evidence/diagnostic dictionaries. Test declaration is included first; bulk-select bounded steps, then links and only admitted symbol endpoints, then bounded induced production relations and support. Total ≤5000 evidence refs and ≤200 diagnostics. Omit complete supported units when a budget prevents closure; report truncation. |
| GetRelatedProductionSymbols | Snapshot/test; page 50, max 200                                                    | Select distinct exact linked production symbols in source order. Retrieve their site links in a separate bulk query using admitted symbol IDs, preserving occurrences. Combined link budget 1000; explicit truncation if more sites exist. Unresolved sites remain in the trace/diagnostics rather than a fabricated symbol list.                                                      |
| FindTestsForSymbol          | Snapshot/symbol; page 50, max 200                                                  | Reverse exact TestCodeLink target lookup, distinct tests in declaration source order. Bulk-select at most 1000 supporting occurrences. Include matching test/step/evidence IDs; do not claim transitive relatedness from a direct-link query.                                                                                                                                          |
| GetSourceEvidence           | Snapshot and 1–100 unique evidence IDs                                             | One scoped evidence/file lookup plus cache batch reads. Return one item per requested ID in input order: verified exact excerpt or typed EVIDENCE_NOT_FOUND, SOURCE_UNAVAILABLE, HASH_MISMATCH, INVALID_ENCODING or EVIDENCE_TOO_LARGE. Never accept paths as an alternative.                                                                                                          |
| GetDiagnostics              | Snapshot; optional severity/code/fileId; page 50, max 200                          | Scoped select with optional source evidence/file join. Sort empty path/offset 0 for source-free diagnostics, otherwise path COLLATE C, start offset, then diagnostic ID.                                                                                                                                                                                                               |
| GraphNeighbors              | Snapshot/root, outgoing/incoming/both, depth 2 (max 5), ≤200 nodes                 | Deterministic bounded breadth-first expansion; scope every frontier join to snapshot. Retain site-level parallel relations and diagnostics. At most 1000 relations, 5000 support refs, 200 diagnostics and 10000 examined relations.                                                                                                                                                   |
| FindSymbolPaths             | Snapshot/from/to; directed depth 2 (max 5), ≤200 visited nodes, ≤20 paths          | Deterministic bounded search over exact outgoing relations, with per-path visited symbols and a global work budget of 10000 examined relations. Return paths as symbol/relation ID sequences with support dictionaries. No repeated symbol within a path; a root-to-itself path may contain zero edges. Hitting depth/work/result budgets is explicit.                                 |

There is no backend or SQL adapter in this batch. These are required SQL shapes
for DB-03 verification, not performance observations. Add no unbounded recursive
query: an outer LIMIT alone need not bound recursive work, sorting or joins. Cap
each frontier, total examined relations, rows, depth and statement duration;
report QUERY_TIMEOUT instead of presenting an interrupted result as complete.

Pagination uses a versioned base64url UTF-8 JSON cursor with snapshot, query
kind, canonical filter key, fixed source-v1 ordering and last path/offset/key.
Related lookups include the selected test/symbol in the filter key. Tokens are
strictly validated and canonical, not authorization credentials or signed proof.
No offset pagination. Request limits may change between pages without changing
selection. Paginated responses include nextCursor; a next page is a result_limit
truncation, while null with truncation can also mean a non-page support budget
was exhausted.

Trace and graph assembly must not return dangling edges when truncating.
Unresolved sites retain null targets and their source/diagnostic refs.
Presentation may label such a site as unresolved; it cannot invent a production
symbol. Order is syntax position, not claimed execution order. Linear and
graphical views receive the same facts and disclosure; layout coordinates are
not persisted semantic evidence.

Bound database statement counts independently of result cardinality: ListTests,
diagnostics and evidence use ≤3 scoped statements each; reverse/related lookups
use ≤4; a trace uses ≤8 bulk statements. Graph expansion uses at most two
statements per depth plus two support statements. Avoid a query per
node/evidence record. Set transaction-local timeouts and cancellation in DB-03;
choose latency budgets after DB-05 baselines. Batch limits are safety bounds,
not measured performance SLAs.

Query errors are INVALID_REQUEST, INVALID_CURSOR, SNAPSHOT_NOT_FOUND,
SNAPSHOT_NOT_PUBLISHED, ENTITY_NOT_FOUND, SOURCE_UNAVAILABLE, HASH_MISMATCH,
RESOURCE_LIMIT and QUERY_TIMEOUT. Ingestion/publication additionally needs typed
IDEMPOTENCY_CONFLICT, WRITER_FENCED, SOURCE_NOT_READY and INTEGRITY_VIOLATION.
Do not log source excerpts, credentials or connection strings in errors.

## 8. Reproducible scalability methodology

| Scale  | Symbols | Relations |  Tests |
| ------ | ------: | --------: | -----: |
| Small  |   2,000 |    10,000 |    200 |
| Medium |  25,000 |   150,000 |  2,000 |
| Large  | 100,000 | 1,000,000 | 10,000 |

DB-05 will generate relational fixtures using a published fixed seed, explicit
generator version and checksum. Include multiple snapshots, repeated sites,
skewed high-degree symbols, cycles, unresolved sites, shared hook evidence,
parameterized declarations and partial coverage. Generate endpoints only from
the same snapshot; control distributions and evidence sizes explicitly. The
large scale is a proposed workload, not a supported-capacity guarantee.

Record hardware/OS/storage, PostgreSQL patch/container digest, configuration,
dataset seed/checksum, application/analyzer revision, command, pool size,
concurrency and warm/cold policy. Run warmup separately; collect ≥100 timed
repetitions per query shape across independent processes where practical. Report
p50/p95 with sample counts and methodology; do not mix warm/cold or include
warmup samples. Use EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON), row estimates,
buffers and actual rows. Measure batch write throughput, DB/source-cache size,
peak memory, concurrent reads, write contention, publication latency and cleanup
cost. Verify query results as well as timing. Run write/destructive benchmarks
only against disposable databases.

Required uniqueness indexes are integrity mechanisms. Candidate performance
indexes include tests(snapshot,file,declaration position), reverse
links(snapshot, target,test), relations(snapshot,source/target,site),
diagnostics(snapshot,severity, code), evidence(snapshot,file) and child FK
indexes needed for purge. Measure baseline plans before introducing nonessential
indexes; compare read benefit, write amplification and size. No partitions,
Redis, graph store, materialized views or vector extension is justified by this
design alone. Set acceptance budgets only after baseline measurement and retain
raw plans/results outside canonical docs.

## 9. Security, migration and compatibility risks

- Native pnpm 12.16.1 audit reads the project portion of the multi-document
  lockfile. `security:check` is a separate network-dependent CI step; a service
  failure is unavailable security evidence, while an advisory finding is a
  dependency vulnerability. Neither is suppressed or converted to success. Three
  exact parent-scoped minimatch 11.0.1 overrides address
  [GHSA-g3hv-75wg-m249](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249)
  through ESLint 10.14.0, config-array 0.23.5 and typescript-estree 8.72.1.
  These parents request major 10: the deliberate major-version substitution
  remains a compatibility risk despite public-consumer glob/parser regressions,
  full checks and strict engine/peer installation. Reassess/remove overrides
  when parents accept a patched release. Application exploitability has not been
  demonstrated; this is development-tool exposure.
- Keep PostgreSQL/API local by default. The future HTTP boundary must protect
  against cross-origin requests, DNS rebinding and unauthorized local source
  reads; loopback binding by itself is insufficient. Team authentication/tenancy
  is out of V0 scope, not a promise that shared deployment is already safe.
- Ingestion has explicit byte/file/depth/time/memory budgets, declared as
  analysis configuration. It reads Git objects and verified cached inputs
  without invoking repository scripts, hooks, package managers or tests. Source
  comments remain untrusted data; no automatic AI upload occurs.
- Maintain separate migration-owner, indexing-writer, read-only query and
  guarded maintenance privileges. Application roles cannot disable triggers, own
  tables or run DDL. Least-privilege role behavior requires DB-06 verification.
- DB-02 must review generated Drizzle SQL for composite FK null handling, check
  nullability, evidence joins, cyclic DDL dependencies and parent-row DML
  guards. Generated ORM definitions alone do not prove SQL integrity. Add FKs in
  migration order where Repository/Snapshot/Job pointers form a DDL cycle.
- Configuration/source cache formats are versioned and immutable. A new
  analyzer, compiler, capability or identity algorithm creates a new analysis
  identity. Future projection changes need contract/version compatibility
  review; no deployed API exists to migrate in this batch.
- Large cascades, vacuum bloat, lock waits, stale leases, deadlocks, cache disk
  loss, partial backups and restoration without guards are explicit risks.
  Review migration SQL, bound pools/timeouts and retry only retryable
  transaction failures. Do not silently repair historical rows or weaken
  constraints to pass checks.

## 10. Worked design reviews

These are reasoned examples to be tested against real PostgreSQL in DB-02–DB-06.
They are not simulated measurements or claims of implemented persistence.

| Scenario                                                | Expected design behavior                                                         | Required later evidence                                      |
| ------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Snapshot A link points at snapshot B symbol             | Composite target FK rejects it, even if the UUID exists elsewhere                | Negative INSERT and projection isolation test                |
| Same production endpoints called at offsets 10 and 70   | Two occurrence keys and support rows survive; no endpoint-pair deduplication     | Persist/requery both spans and reverse occurrences           |
| Identical repository/key/payload submitted concurrently | One job/generation, other caller reuses it                                       | Independent connections and explicit commit ordering         |
| Same key reused for another commit                      | Request hash mismatch produces IDEMPOTENCY_CONFLICT; generation does not advance | Negative conflict transaction and unchanged intended pointer |
| Generation 1 finishes after generation 2 was requested  | Gen 1 may publish inactive; it cannot activate, even if gen 2 later fails        | Out-of-order completion with pointer assertion               |
| Writer epoch 4 pauses, epoch 5 takes over               | Epoch 4 batches/publication are fenced; only reset staging is writable           | Multi-connection lease/takeover test                         |
| Process dies during a batch or publication              | Transaction rolls back; previous active snapshot remains; staging is invisible   | Kill/rollback and concurrent reader test                     |
| Repository disappears after indexing                    | Verified retained cache serves identical source bytes                            | Remove disposable original checkout and compare hashes/spans |
| Referenced cache object is missing/corrupted            | Source error is explicit; working-tree text is never substituted                 | Missing/corrupt cache and restore drill                      |
| Test extraction complete but linking unsupported        | Capability report and trace coverage are partial/unsupported; no guessed targets | Coverage publication validation and unsupported fixtures     |
| A graph or evidence budget is reached                   | Keep a closed admitted subgraph and explicit truncation; no dangling target      | Query regression on high-degree fixture                      |
| Retention races a reader or desired snapshot            | Shared read protection blocks purge; intent checks still apply                   | Advisory retention lock and maintenance contention test      |

## 11. Exit gates and the DB-02 handoff

Foundation acceptance is a frozen clean-clone installation, formatting/lint,
registry validation, boundary checks, build, typecheck and focused regressions.
Prepared Windows/Linux Actions workflows do not constitute hosted CI evidence.
Always report the exact tested revision and distinguish local clone checks from
hosted results, even when they use the same SHA. Schema tests do not establish
PostgreSQL, analyzer or study correctness.

DB-01 is ready for user review when this model, dictionary, invariant ownership,
query contracts, source lifecycle, worked failures, workload method and two
significant ADRs are complete and internally consistent. User approval is the
phase gate. Outstanding empirical evidence belongs to the next work packages.

After explicit approval, the first DB-02 task is:

1. Verify exact stable PostgreSQL 18, Drizzle ORM/Kit and pg compatibility.
   Create the database package with real schema behavior and disposable local
   Compose; keep migration and runtime roles separate.
2. Translate this reviewed logical model into Drizzle schema and reviewed
   initial SQL migration, including scoped FKs, occurrence uniqueness,
   resolution checks, declared capability counts and immutable-publication
   guards. Review SQL lock and trigger behavior, including child writes racing
   publication.
3. Prove fresh creation and negative integrity cases on real isolated
   PostgreSQL. Cover cross-snapshot references, evidence hashes, unresolved
   targets, duplicate occurrences and published mutation attempts. Do not claim
   query/concurrency performance or restore readiness from fresh migration
   tests.
4. Report SQL/constraint differences from this design and actual evidence before
   accepting DB-02. DB-03 implements minimal storage/query adapters, DB-04 tests
   concurrency/failure recovery, DB-05 benchmarks, and DB-06 audits upgrades,
   privileges, restore and overall database readiness.

Do not begin a full backend until DB-06 passes its agreed evidence gate.
Frontend and optional AI remain later phases.

## 12. Bounded in-memory semantic proof

ADR-0003 permits CT-INDEX-001A before DB-02. `analyzeManifest` accepts a
repository UUID, explicit `COMPILER_PROFILE`, and caller-supplied files with
POSIX paths, raw UTF-8 bytes and claimed SHA-256 hashes. It copies the buffers,
rejects unsafe/case-equivalent paths, verifies hashes and strict UTF-8, and
preserves BOM/line endings. It returns immutable model facts and a source
reader; the reader returns defensive copies and checks content and positions. No
Git commit or durable cache provenance is inferred from the supplied bytes.

The profile pins TypeScript 6.0.3, ES2023, ESNext/Bundler resolution, forced
module detection, strict checking, no JavaScript, no emit, no ambient types and
the ES2023 compiler-library closure. Unsupported options fail. The CompilerHost
serves only the virtual manifest and pinned library closure, checks the
toolchain library real paths and records hashes in the analyzer build identity.
Relative imports resolve through TypeScript's resolver against that host. Bare
packages, escaping references, missing dependencies and ambient node_modules do
not become source inputs. The TypeScript toolchain is trusted; the virtual host
is an input boundary, not an operating-system sandbox.

The proof extracts named function declarations with bodies and direct identifier
calls, including nested named functions, local calls, named relative imports,
aliases and recursion. Each declaration's primary evidence spans the complete
declaration, while call ownership is restricted separately to the nearest
supported function body. Calls in parameter initializers, file scope, arrows,
function expressions or methods have evidence and diagnostics but no invented
function owner. Calls to type-only values, re-exports, overloads, default or
namespace imports, external packages, computed/property calls and dynamic
imports are unsupported. Missing bindings are unresolved; conflicting function
implementations are ambiguous. A binding written elsewhere or affected by a
compiler error cannot produce an exact relation. Named imports serve resolution;
import and reference occurrence facts remain unimplemented. Static exactness is
not a runtime observation.

The `declarations.v1` and `relationships.v1` coverage fields are partial because
their broader domains are not fully implemented. `named_functions.v1` describes
the named-function subset; `direct_calls.v1` describes supported calls and is
partial/unsupported when analysis or unsupported cases prevent completeness.
Import occurrences, reference occurrences and test behavior are `not_analyzed`.
Coverage, target resolution and graph truncation are independent
classifications. Decorator syntax receives a source-anchored unsupported
diagnostic; runtime framework wiring and constructor relationships remain
`not_analyzed`.

The public analysis boundary allows twenty files, 256 KiB per file, 2 MiB total,
2,000 named function declarations with bodies and 5,000 call sites. Compiler
diagnostics and unsupported decorator occurrences are each capped at 10,000. A
parent starts a short-lived child, clears inherited Node injection settings,
enforces a ten-second maximum deadline and limits the V8 heap to at most 512
MiB; callers may request lower limits. The child verifies the actual V8 heap
ceiling. The heap limit does not bound total RSS. IPC is bounded. Malformed
source, invalid inputs, resource exhaustion, timeout and compiler failure return
typed failures rather than empty successful graphs. These limits are
proof-of-concept safety bounds, not scalability guarantees.

`createInvestigation` copies facts, verifies retained raw source hashes and
positions, and builds source-ordered occurrence indexes. Neighbors use bounded
breadth-first search in the requested direction. Paths are simple directed paths
with a bounded examined-edge budget; cycles and parallel occurrences remain
valid graph data. Result projections are checked by the request-aware contract
parsers and retain only closed units with required evidence and diagnostics.
Evidence batches return exact verified excerpts or typed unavailability;
excerpts over 65,536 UTF-16 units are explicitly unavailable.

The source-pinned corpus is manually annotated independently of analyzer output.
Its labels are authored, not independently reviewed. `eval:semantic` reports all
predicted and expected occurrence counts, evidence mismatches, precision, recall
and unresolved/ambiguous rate with explicit denominators. Rejected-input cases
are reported separately; empty denominators are unavailable. Repeated manifest
orderings must produce identical canonical facts. Passing the declared sample
does not establish arbitrary-repository accuracy, runtime behavior or
comprehension improvement. CT-INDEX-001 remains broader than this slice.
