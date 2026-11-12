# External semantic evaluation inputs

The source-pinned graph claims have a separate
[independent reviewer packet](GRAPH-REVIEW.md). Existing labels remain
unreviewed until a human records a review there.

The following source subsets and questions were selected and annotated before
running CodeThread on them. Codex authored the labels on 2026-11-02 from the
upstream source; they have not been independently reviewed. Coordinates are
one-based UTF-16 line/column positions, with an exclusive end. Exact targets and
owners refer to complete declaration anchors, not analyzer-generated identities.
All call expressions in the selected files are annotated, including nested calls
with the same starting position. No upstream code was executed.

## tinyexec: environment handling in a process library

- Repository: https://github.com/tinylibs/tinyexec
- Revision: `4a2aca1cf11943445c7bae6c767086a8c61291ef`; MIT license retained in
  `tinyexec/LICENSE`.
- Selected: `src/env.ts` (1,722 bytes), SHA-256
  `3e592708f39d6542112a8c4726854d0af38b311366d2ce913f4148cce7589bb5`.
- Excluded: every other repository file, including `src/main.ts`,
  `src/non-zero-exit-error.ts`, `src/normalize.ts`, `src/stream.ts`, tests and
  build configuration. Bare `node:path` and `node:url` imports and Node types
  are unavailable to the isolated compiler profile.
- Investigation questions: What direct calls does `computeEnv` make? Which
  selected declaration calls `getPathFromEnv`, and what source justifies it?

This small environment-preparation module has local direct calls, property calls
and external platform dependencies. It is a source subset, not library coverage.

## ts-node-todo: application route wiring

- Repository: https://github.com/vunb/ts-node-todo
- Revision: `c64bdfaf3f36a3fde88fba8191ad0a98d4acbc8c`; MIT license retained in
  `todo/LICENSE`.
- Selected: `routes/index.ts` (1,710 bytes), SHA-256
  `e361911be0b6b29857eb8eac273de29fb4b3980f324f7326b582a141d5732531`; and
  `routes/todo.router.ts` (395 bytes), SHA-256
  `a698ded96d38c6afb4f7eb6d385ae8add0ec3340eb7aa29a979540147a074442`.
- Excluded from the original two-file manifest: all other repository files,
  including `config/express.ts`, `config/knex.ts`, `config/logger.ts`,
  `config/passport.ts`, all controllers, all models, `routes/auth.router.ts`,
  `routes/user.router.ts`, `server.ts`, tests and configuration. Express and
  other bare dependencies are unavailable.
- Investigation questions: Does `routes` directly call the selected `todoRouter`
  declaration, and where? Which other calls in `routes` remain unresolved or
  unsupported? Can the tool trace from `routes` to the handler declarations
  referenced inside `todoRouter`?

The selected routes exercise a useful cross-file application investigation,
callbacks, property calls and missing modules. Results describe only these
files, not the complete application.

### Verified closure inputs for the capability assessment

The original two-file gold set remains unchanged. The following additional
source bytes are pinned from the same `ts-node-todo` commit to separate missing
manifest inputs from unsupported syntax. The loader checks both raw SHA-256 and
the upstream Git blob object ID before analysis.

| Manifest path                    | Bytes | SHA-256                                                            | Upstream Git blob                          |
| -------------------------------- | ----: | ------------------------------------------------------------------ | ------------------------------------------ |
| `routes/auth.router.ts`          |   228 | `10394dda38710b099f969261aea34cee35031960f1e0e9cda1b3164eabb45ff3` | `397ac5a2c05307dc6bab2d28c511da303226cf6c` |
| `routes/user.router.ts`          |   289 | `b5c300467588f00f7a23dd970b71ff0fff42b1420a7bf031c7771111b711c28b` | `72bc9eae0f9a077e7836a4f983bdabec34a99343` |
| `config/passport.ts`             | 1,839 | `be8d28b84a3ac2632b905c5bec3b284c70c210d1a2d96015b1b7f469674d0c6c` | `746ec3004287c7d333e2beb44813706bc5dcd6df` |
| `controllers/todo.controller.ts` | 2,333 | `3d1a82e2db7af3c8af876ff445fce286517c3636ee571f4094ea22e9b48195c2` | `41be3af14444631c108724f261e77f3c0360c208` |
| `models/todo.ts`                 | 1,447 | `1e93beb954c55d2e2ca093264c8fcbe2a9d26d9591b3a0c8c846b4b60ad024ad` | `be04b61cd0ae1c766b27276536b7318f23115aea` |

This is a minimal experiment input set, not a claim that it is the application's
complete compiler or runtime dependency closure. In particular, Express,
Passport and other bare packages remain unavailable; no dependencies are
installed and no repository code is executed. The controller and model inputs
let the bounded analyzer check the three handler-shaped property expressions
against source declarations. The analyzer records these as static `REFERENCES`,
not calls or framework registration. The inputs do not change the external gold
labels; `references.v1` remains partial because only this narrow subset is
implemented.

## Whole-repository source and browser workflow evaluation

The repository corpora pin every regular tracked `.ts` blob, compiler/workspace
metadata, Git commit/tree objects, and license bytes. The loader checks source
SHA-256 and Git blob identity before analysis. It does not run upstream code,
tests, package scripts or dependencies.

| Repository                                                        | Pinned commit                              | Scope                  | Source bytes | License material                                              |
| ----------------------------------------------------------------- | ------------------------------------------ | ---------------------- | -----------: | ------------------------------------------------------------- |
| [unjs/ufo](https://github.com/unjs/ufo)                           | `f06c800d0c59f2a4a1b9ba65eb6cb61a84419be6` | 21 regular `.ts` files |       82,502 | `LICENSE` (1,078 bytes; SHA-256 is in `repository.json`)      |
| [jridgewell/sourcemaps](https://github.com/jridgewell/sourcemaps) | `b7600158f4de012d246b7834a73c7c2190e75136` | 53 regular `.ts` files |      286,449 | Five package `LICENSE` files, all hashed in `repository.json` |

`eval:external` reports total labels, scored cases and raw project observations
separately. Only labels fixed before predictions enter acceptance metrics. The
sourcemaps overload-related correction remains in `postPredictionCorrections`
for audit and is excluded from scored cases, exact denominators and the
closed-owner gate. Repository occurrences without a pre-prediction label remain
unscored; repeated occurrences in two TypeScript contexts are not silently
deduplicated into one semantic observation. Inventory, source coverage, context
completion and semantic coverage are independent fields. The expected source
labels are Codex-authored; no label set has independent human review.

`repository-workflows.json` pins five browser tasks on ufo and six on
sourcemaps. Together they exercise whole-repository symbol search, explicit
project-context selection, outgoing CALLS, occurrence and declaration evidence,
target follow with Back/Forward, source/context-status inspection, and paged
inventory display for a monorepo. The sourcemaps task anchors (commit
`b7600158f4de012d246b7834a73c7c2190e75136`) are specified from its pinned source
path, lines and SHA-256, then checked against the verified corpus bytes and the
browser projection.

These tasks were authored after analyzer predictions were observed. Their
eleven-task denominator is a workflow completion check, not a blind semantic
gold set. Browser task completion, source labels and total project occurrences
must be reported as separate counts. No human participant or comprehension
outcome is measured; the Codex-authored labels have not received independent
human review.
