# Analysis identity and local source retention

Status: proposed for DB-01 approval.

Problem: commit SHA or current working-tree text cannot uniquely identify an
indexed result or preserve exact evidence after a repository changes location.
Constraints are local committed Git inputs, reproducibility, private source and
multiple analyzer/configuration versions.

Choose a unique repository/source-fingerprint/analyzer-build/configuration
tuple, separate operational scan requests, and a verified local
content-addressed cache for source and analysis manifests. PostgreSQL stores
relational identities and evidence metadata. The canonical conventions and
dictionary are owned by `../architecture.md`.

Alternatives were commit-only identity with original-Git-object retrieval, and
storing whole source repositories in relational rows. The former loses
availability under repository deletion/GC and omits configuration identity; the
latter increases database size and backup coupling without improving source
semantics.

Tradeoffs: cache storage, coordinated retention/backup and canonicalization
become explicit responsibilities. Failure modes include missing/corrupt objects,
hash omissions, implicit ambient dependencies and inconsistent configuration
manifests. Fail closed on source mismatch; never substitute working-tree
content.

Validation requires changed/equivalent-input identity vectors, Unicode/hash
tests, cache durability/retrieval checks, repository-removal cases and a
database-plus-cache restore drill. Foundation validates structural identity and
positions only; cache and database behavior are not implemented in DB-01.
