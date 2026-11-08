# ADR-0004: Safe local Git source adapter

Status: accepted for CT-SOURCE-001, 2026-11-03.

## Decision

The existing textual investigation CLI may acquire source from one explicitly
selected revision in a standard local Git checkout. The caller supplies the
repository UUID and literal `.ts` paths. The adapter resolves the revision once,
reads commit/tree/blob objects by object ID, verifies object type, size and
identity, computes raw-source SHA-256 hashes, then hands the resulting manifest
to the existing analyzer and session. Git commit/blob IDs are displayed and
retained as acquisition provenance outside the analyzer's manifest identity.

CT-COMP-001 adds an optional metadata-only browse path over the same resolved
commit. It reads bounded verified commit/tree objects to list candidate `.ts`
paths, but reads no blobs until selection. The browser applies explicit file,
tree, visit, entry, byte and time bounds; an incomplete inventory cannot be used
for module-wide selection. A successful selection is handed back as the full
commit ID, so ref movement during browsing does not change the source.

Selection is all-or-error. Only regular blob modes `100644` and `100755` are
admitted. Dirty working-tree contents are ignored. The adapter does not crawl
the working tree, infer dependencies, check out files, hydrate LFS pointers,
follow symlinks or read submodules.

## Trust boundary and failure modes

The host Git executable is resolved to an absolute path outside the analyzed
repository and invoked with structured arguments and `shell: false`. Child Git
settings are rebuilt from a small environment allowlist; inherited Git
directory/object overrides, tracing, global/system configuration, prompts,
replacement objects, optional locks and lazy fetching are disabled. Git's
ownership checks remain enabled. Repository-controlled hooks, filters, scripts,
package managers and tests are not invoked by object reads.

This boundary assumes that the developer trusts the local Git executable and the
repository's `.git` metadata. It does not make Git safe against a malicious
repository configuration or a compromised executable. Git documents that
repository configuration can invoke commands and warns about operating on
untrusted repository metadata:
[Git security](https://git-scm.com/docs/git#_security). For this reason, bare
repositories, linked worktrees, symlinked `.git` directories, alternate object
stores and unsupported object layouts fail closed. Missing/corrupt objects,
malformed tree records, unsafe paths, resource limits, timeout and cancellation
produce typed failures. No failure starts an analysis session or falls back to
working-tree files.

## Alternatives considered

- **Read working-tree paths:** rejected because dirty files can diverge from the
  requested revision and symlink/path behavior broadens the filesystem trust
  boundary.
- **Use `git show <revision>:<path>`:** rejected because revision/path parsing
  and pathspec semantics are harder to constrain, and a per-path command does
  not provide the same explicit binary tree traversal and object verification.
- **Enumerate an unbounded tree or source closure:** rejected because a broad
  traversal adds work and exposure without a demonstrated need. CT-COMP-001
  permits a bounded, tree-object-only candidate inventory for explicit user
  navigation; it does not read unselected source blobs or infer imports.
- **Create a Git crawler or source-cache service:** deferred because the current
  product needs only a selected-file handoff into the already implemented
  in-memory analyzer. Persistence, dependency closure and background services
  belong to later reviewed work.

## Evidence and remaining risk

Disposable-repository regressions exercise real commits, refs, object reads,
dirty working trees, unusual literal paths, binary tree framing, missing and
corrupt objects, symlink/gitlink modes, content hashes, metadata-only discovery,
shared-subtree visit limits and selected-session handoff. The acceptance suite
also injects inherited Git overrides and tracing. These tests establish behavior
for the tested Git versions and fixtures; they do not prove safety for hostile
local Git metadata, compromised Git installations, remote/promisor retrieval,
linked worktrees, alternate object stores or every filesystem. Database
provenance persistence and coordinated source-cache backup remain unimplemented.
