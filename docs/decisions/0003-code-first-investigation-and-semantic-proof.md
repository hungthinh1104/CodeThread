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

## CT-INDEX-001B method references

For method properties passed as call arguments, record a `REFERENCES` edge only
when the TypeScript checker selects one body-bearing source method declaration.
The edge is tied to the full occurrence and declaration evidence. It does not
assert a function value at runtime, a call, successful framework registration or
execution. Keep computed access, accessors, overloads, ambiguous and missing
targets unresolved or unsupported. Preserve `CALLS` as the default graph query
kind; mixed traversal requires explicit relation-kind selection and retains the
edge kind on each path segment.

The alternative of treating callback-looking values as calls or framework
handlers was rejected because static property typing cannot establish runtime
receiver identity, registration outcomes or dispatch. Risks include incomplete
manifests hiding assignments, overrides changing runtime dispatch and compiler
errors obscuring member identity. Evidence for this slice is limited to the
three pinned todo routes and focused adversarial fixtures; general TypeScript
reference accuracy remains unproven.
