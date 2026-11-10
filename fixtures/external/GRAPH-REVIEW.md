# CT-VERIFY-001 external graph review packet

## Review status

This packet is prepared for an independent reviewer. No independent review has
been completed, and the existing labels remain unreviewed. The two cases below
are narrow static source claims; they do not establish runtime behavior,
framework registration, library-wide accuracy, or comprehension value.

Review against the immutable upstream revisions and file hashes below. The
checked-in copies are under fixtures/external/; no upstream repository code
needs to be executed and no dependencies need to be installed.

## Pinned source set

| Case         | Upstream revision                        | Source file                                                                                                                       | Bytes | SHA-256                                                          |
| ------------ | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----: | ---------------------------------------------------------------- |
| tinyexec     | 4a2aca1cf11943445c7bae6c767086a8c61291ef | [src/env.ts](https://github.com/tinylibs/tinyexec/blob/4a2aca1cf11943445c7bae6c767086a8c61291ef/src/env.ts)                       | 1,722 | 3e592708f39d6542112a8c4726854d0af38b311366d2ce913f4148cce7589bb5 |
| ts-node-todo | c64bdfaf3f36a3fde88fba8191ad0a98d4acbc8c | [routes/index.ts](https://github.com/vunb/ts-node-todo/blob/c64bdfaf3f36a3fde88fba8191ad0a98d4acbc8c/routes/index.ts)             | 1,710 | e361911be0b6b29857eb8eac273de29fb4b3980f324f7326b582a141d5732531 |
| ts-node-todo | c64bdfaf3f36a3fde88fba8191ad0a98d4acbc8c | [routes/todo.router.ts](https://github.com/vunb/ts-node-todo/blob/c64bdfaf3f36a3fde88fba8191ad0a98d4acbc8c/routes/todo.router.ts) |   395 | a698ded96d38c6afb4f7eb6d385ae8add0ec3340eb7aa29a979540147a074442 |

Coordinates are one-based UTF-16 line and column positions with an exclusive
end. Source copies and call annotations are hash-checked by the external corpus
loader.

## Reviewer worksheet

Complete this section from the pinned source before comparing it with the
expected annotations below.

| Case         | Call-site span and text | Enclosing owner | Target declaration | Relation kind and direction | Evidence sufficient? | Uncertainty or disagreement |
| ------------ | ----------------------- | --------------- | ------------------ | --------------------------- | -------------------- | --------------------------- |
| tinyexec     |                         |                 |                    |                             |                      |                             |
| ts-node-todo |                         |                 |                    |                             |                      |                             |

## Expected source-backed graph claims

These expectations were authored from the pinned bytes and are the current
evaluation oracle. They are included for reconciliation after the independent
worksheet is complete. They are not an independent review.

### tinyexec

- Owner: computeEnv, src/env.ts:59:1-77:2.
- Call occurrence: getPathFromEnv(envWithDefault), src/env.ts:73:45-73:75.
- Expected target: getPathFromEnv, src/env.ts:18:1-36:2.
- Expected relation: exact static CALLS, directed from computeEnv to
  getPathFromEnv, supported by the call-site span and both declaration spans.
- The call is nested inside addNodeBinToPath(...). The outer call remains
  unresolved in this selected input because compiler errors overlap its target
  declaration when Node inputs are unavailable. Do not merge the nested and
  outer occurrences or treat the graph as evidence of execution.

### ts-node-todo

- Owner: routes, routes/index.ts:9:1-63:2.
- Call occurrence: todoRouter(), routes/index.ts:42:20-42:32.
- Expected target: todoRouter, routes/todo.router.ts:4:1-17:2.
- Expected relation: exact static CALLS, directed from routes to todoRouter,
  supported by the call-site span and both declaration spans.
- authRouter() and userRouter() are outside the selected source set and remain
  unresolved in this experiment. Calls inside todoRouter that use external
  Express values do not establish controller calls, route registration, or
  runtime behavior.

## Review checklist and record

- [ ] Verify the upstream commit and SHA-256 for each source file.
- [ ] Locate each complete call occurrence and its enclosing function.
- [ ] Confirm the complete target declaration anchor and the call's direction.
- [ ] Confirm CALLS is the appropriate static relation kind.
- [ ] Confirm evidence identifies the actual pinned call and declaration bytes.
- [ ] Keep nested calls, unresolved sites, unsupported sites, and exclusions
      distinct; do not infer execution.
- [ ] Record every disagreement with a source anchor and a short rationale.

| Review field                          | Entry   |
| ------------------------------------- | ------- |
| Reviewer                              |         |
| Review date                           |         |
| Independence / relevant experience    |         |
| Reviewed corpus and revision          |         |
| Disagreements or unresolved questions |         |
| Disposition                           | PENDING |

The package is ready for review; the labels must not be called independently
reviewed until a human completes and records this section.
