# Code-first investigation and an in-memory semantic proof

Status: accepted, 2026-11-01, by the remediation request and confirmed
decisions.

Problem: the original test-first journey made Jest a prerequisite for
understanding code, and database-first sequencing delayed proof of the central
semantic behavior. The intended product supports files, modules, symbols and
entry points, with tests as optional supporting evidence. The existing official
thesis title remains academic metadata.

Choose a code-first investigation model and a bounded, in-memory Compiler API
proof as the next independent milestone before DB-02. This supersedes mandatory
test-first navigation and the original requirement to finish database
implementation before any semantic proof. It does not authorize that proof in
the remediation itself.

Retain the two current packages and test-related schemas. Generic graph,
evidence and resolution concepts remain framework-independent. Data flow from
extractors to model to querying to presentation differs from code dependency
arrows, which point toward stable model/contract definitions. Persistence is an
adapter.

Alternatives were preserving test-first identity, deleting all test models, or
building a scanner/backend/UI immediately. The first excludes valuable code
entry points; deletion wastes reusable behavior; immediate expansion hides
semantic defects behind more infrastructure.

Tradeoffs: internal 0.0.0 contracts and fixtures change together, and the
logical database proposal must be reconciled with observed semantic needs before
DB-02. ADRs 0001/0002 retain their identity, cache and publication proposals and
their unapproved persistence gates. Full backend, frontend and AI gates remain
intact.

Validate with consistent product/requirement wording, public contract
regressions and the separately implemented source-pinned semantic proof. Tests
cannot establish that source analysis or comprehension improvement already
exists.
