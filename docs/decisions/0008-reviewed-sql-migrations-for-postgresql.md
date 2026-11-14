# ADR-0008: Reviewed SQL migrations for the PostgreSQL backend

Status: proposed for CT-DB-013 review, 2026-11-14.

## Context

The DB-02 local candidate needs versioned schema changes and database-enforced
invariants for immutable published data, scan fencing, retention privileges and
recovery. The initial architecture proposed Drizzle ORM/Kit; the candidate uses
checked-in SQL migrations applied by the backend migration runner.

## Proposal

Keep migration DDL and data changes as reviewed SQL files. The pinned TypeScript
runner discovers the ordered migration set, checks each file's checksum against
the migration ledger, and applies unapplied migrations transactionally. The
backend uses the PostgreSQL driver directly for parameterized application
queries; it does not add an ORM runtime or generate schema changes implicitly.

This keeps triggers, composite constraints, role grants and transactional
publication rules visible in the SQL reviewed for each migration. Schema edits
must update the canonical SQL and migration checksum path together. No code may
silently adopt a changed migration or repair historical rows to make a new
schema pass.

## Alternatives

- **Drizzle ORM and Kit:** retain as a viable option if typed schema access or
  generated migration workflows materially reduce maintenance cost. The current
  candidate's integrity rules still require review of the generated SQL and
  database behavior; ORM types alone do not establish those invariants.
- **Unversioned SQL or runtime schema creation:** rejected because it obscures
  migration order, exact contents and version/adoption state.

## Consequences and evidence

SQL changes remain directly inspectable, and the runner can pin migration
identity independently of application code. The cost is that query types,
migration authoring discipline and SQL review remain explicit responsibilities.
The candidate's migration tests and hosted PostgreSQL job are evidence for the
tested commit only. This proposal does not establish production readiness or
replace independent review of migration semantics.
