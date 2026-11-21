# CT-SEMANTIC-TRUST-013 source annotation worksheet

Use the listed source trees and their compiler configuration to annotate every
occurrence owned by each declaration. Record your answers before looking at any
labels, CodeThread output or scoring reports. Git source can be inspected as
text. Keep application scripts and dependency installation out of the review.

| Scope ID                     | Owner in the pinned source                                                                                                                                                                          | Compiler context                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `ufo-with-query`             | [`src/utils.ts:348–353`](https://github.com/unjs/ufo/blob/f06c800d0c59f2a4a1b9ba65eb6cb61a84419be6/src/utils.ts#L348-L353)                                                                          | `tsconfig.json`                        |
| `ufo-url-append`             | [`src/url.ts:117–132`](https://github.com/unjs/ufo/blob/f06c800d0c59f2a4a1b9ba65eb6cb61a84419be6/src/url.ts#L117-L132)                                                                              | `tsconfig.json`                        |
| `sourcemaps-memoized-search` | [`packages/trace-mapping/src/binary-search.ts:96–123`](https://github.com/jridgewell/sourcemaps/blob/b7600158f4de012d246b7834a73c7c2190e75136/packages/trace-mapping/src/binary-search.ts#L96-L123) | `packages/trace-mapping/tsconfig.json` |

## Source and compiler inputs

The supplied review inputs identify the commit, each regular source blob and
configuration file, and the project context. Use the pinned TypeScript 6.0.3
compiler context with the admitted repository metadata and compiler libraries.
Repository-installed dependencies and ambient machine types are outside that
context. Inspect declarations in other source files as needed. Record the file,
byte hash and full UTF-16 span of each anchor. Start line and column are
one-based, and end positions are exclusive.

## Annotation instructions

1. Walk the complete owner body. Record every call expression, including nested
   calls that start at the same position, and every property or indexed access
   used as a call argument. Record constructor expressions too. Stop assigning
   sites to this owner at a nested function, method or callback. Keep parameter
   initialization separate from the body.
2. For each site, give its exact source excerpt and lexical owner. Record the
   relation kind and direction from the owner to the selected declaration, when
   supported by the source. A method used as a value and an invocation require
   separate judgments. Record any site with no applicable relationship.
3. For an exact claim, supply the full target declaration anchor and explain how
   the declaration was selected in this compiler context. For an uncertain case,
   record unresolved, ambiguous or unsupported and its source rationale. Record
   exclusions and disputes with source evidence. Keep the claims static.
4. Save the completed answers separately with the packet digest, scope ID,
   reviewer alias and review date. Record prior exposure as none, labels only,
   predictions or unknown. Confirm whether you authored any existing labels.
5. After freezing the response, reconcile it against existing annotations with a
   maintainer. Preserve original responses. For a disagreement, record competing
   anchors, the rationale and the adjudicator's decision or pending status.

| Scope ID | Site file, hash, span and excerpt | Lexical owner anchor | Kind and direction | Status and target anchor | Source rationale or exclusion |
| -------- | --------------------------------- | -------------------- | ------------------ | ------------------------ | ----------------------------- |
|          |                                   |                      |                    |                          |                               |
