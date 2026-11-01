# Semantic fixture policy

These sources and annotations are hand-authored before the resolver. They are
contract/evaluation inputs, not analyzer output. Source hashes pin exact bytes;
line/column spans and occurrence expectations were authored from the text.
Authorship: Codex, 2026-11-01. Independent review: not yet performed.

The initial capability supports named function bodies, direct identifier calls,
local bindings and relative named imports/aliases, including recursion. Calls
outside a named function body have no fabricated owner. Re-exports, overloads,
type-only value uses, non-identifier calls and absent external packages are
unsupported; missing bindings are unresolved and conflicting implementations are
ambiguous. Module/file coverage beyond these capabilities is not analyzed.

Annotations enumerate call sites independently of the implementation. A source
hash, explicit range and expected result must agree before evaluation. An
unsupported site must never count as an exact relationship. Invalid input and
resource-limit cases are exercised separately from semantic accuracy.

`determinism.json` is a generated checksum of the whole canonical output for
cross-platform comparison. It is not an expected semantic label. Update it only
after reviewing an intentional analyzer/build-identity change and rerunning the
independent gold evaluation.
