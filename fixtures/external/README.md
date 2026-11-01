# External semantic evaluation inputs

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
- Excluded: all other repository files, including `config/express.ts`,
  `config/knex.ts`, `config/logger.ts`, `config/passport.ts`, all controllers,
  all models, `routes/auth.router.ts`, `routes/user.router.ts`, `server.ts`,
  tests and configuration. Express and other bare dependencies are unavailable.
- Investigation questions: Does `routes` directly call the selected `todoRouter`
  declaration, and where? Which other calls in `routes` remain unresolved or
  unsupported? Can the tool trace from `routes` to the handler declarations
  referenced inside `todoRouter`?

The selected routes exercise a useful cross-file application investigation,
callbacks, property calls and missing modules. Results describe only these
files, not the complete application.
