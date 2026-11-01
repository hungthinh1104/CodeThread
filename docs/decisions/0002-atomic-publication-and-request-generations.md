# Atomic publication with request generations

Status: proposed for DB-01 approval.

Problem: batch persistence, duplicate requests and out-of-order completion can
expose partial graphs or replace newer intended results. Constraints include one
PostgreSQL relational store, concurrent readers/scans and no premature job
service.

Choose shared unique analysis results, repository-scoped idempotent ScanJobs,
fenced staging writers and a repository generation check in the publication
transaction. Published payloads are immutable; activation is a separate scoped
pointer. Parent row locks and database mutation guards serialize child writes
with publication. Valid superseded results may remain published but inactive.

Alternatives were direct writes into an active graph, latest-completion-wins,
and one long transaction for the whole scan. Direct writes expose partial data;
completion order loses user intent; whole-scan transactions increase lock
duration, rollback cost and recovery coupling. An external queue would not
remove these database correctness obligations.

Tradeoffs: writer epochs, leases, request deduplication and lock ordering
require explicit SQL/transaction tests. Failure modes are stale tokens, lease
takeover races, deadlocks, invalid cleanup and activation of a reused result for
the wrong request. A failed newer request does not implicitly authorize an older
one.

Validation requires independent-connection tests for duplicate/conflicting
requests, interrupted writes, late publication, shared-result reuse, immutable
payload guards and active-reader retention. DB-01 supplies the protocol and
review scenarios; real concurrency and recovery evidence belongs to DB-04/DB-06.
