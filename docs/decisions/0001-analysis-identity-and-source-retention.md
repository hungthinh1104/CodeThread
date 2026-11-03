# Analysis identity and local source retention

Status: proposed for DB-01 approval.

Problem: commit SHA or current working-tree text cannot uniquely identify an
indexed result or preserve exact evidence after a repository changes location.
Constraints are local committed Git inputs, reproducibility, private source and
multiple analyzer/configuration versions.

Choose a unique repository/source-fingerprint/analyzer-build/configuration
tuple, separate operational scan requests, and a verified local
content-addressed cache for source and analysis manifests. PostgreSQL stores
relational identities and evidence metadata. Git commit/tree identity and
per-path blob/mode provenance belong to the acquisition request (`ScanJob` and
its selected-input rows), not to the reusable semantic snapshot or its
`SourceFile` rows. A successfully published request must prove its selected
path/hash manifest and configuration hash match the semantic result it
references. Each `ScanJob` retains the exact accepted caller revision selector,
configuration hash, and analyzer version/build chosen at request acceptance,
separately from the immutable resolved Git commit/tree. Its request hash commits
to the caller intent: repository identity, exact selector, UTF-8-byte-sorted
selected paths, and canonical configuration hash. Analyzer build belongs to
semantic identity and is pinned on the job for retries, but does not change the
hash of a replayed caller request.

A repeated idempotency key with the same request hash returns the original
logical job before resolving a selector again; a different hash conflicts. A
retry after commit resolution uses the stored commit and pinned analyzer build,
after the caller re-presents matching request intent. If revision resolution
failed before any commit was pinned, that job cannot be retried safely; a new
request with a new key is required. If the pinned analyzer build is unavailable,
the retry fails explicitly instead of using the current build. The canonical
conventions and dictionary are owned by `../architecture.md`.

Alternatives were commit-only identity with original-Git-object retrieval, and
storing whole source repositories in relational rows. The former loses
availability under repository deletion/GC and omits configuration identity; the
latter increases database size and backup coupling without improving source
semantics. Storing one commit/blob identity directly on a deduplicated semantic
snapshot or source-file row was also rejected: different commits, object
formats, or executable-bit modes can produce the same semantic source identity,
so one snapshot row cannot truthfully own every acquisition's provenance.

Tradeoffs: cache storage, coordinated retention/backup and canonicalization
become explicit responsibilities. Failure modes include missing/corrupt objects,
hash omissions, implicit ambient dependencies and inconsistent configuration
manifests. Fail closed on source mismatch; never substitute working-tree
content.

Validation requires changed/equivalent-input identity vectors, tests that two
acquisitions can reuse one semantic snapshot while preserving distinct commit
and blob provenance, Unicode/hash tests, cache durability/retrieval checks,
repository-removal cases and a database-plus-cache restore drill. Foundation
validates structural identity and positions only; cache and database behavior
are not implemented in DB-01. This reconciliation remains a proposed DB-01
design change until approved; it has no migration or runtime implementation.
