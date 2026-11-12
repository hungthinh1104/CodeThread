# CT-REALWORLD-001 blind source-review packet

Use this worksheet to independently check the frozen task prompts and their
source-grounded answers. It intentionally contains no expected labels and no
CodeThread prediction results. It is a label review, not a participant study; no
participant data belongs in this file.

## Freeze and source identity

- Frozen packet commit: b20b57f9ae85cee7982d659f2d6c3f79ff081c5e
- tasks.json SHA-256:
  f5a9c52556d96ae70b90d5482efd3593b00fa68a596353e0a9d67709300f9e75
- repositories.json SHA-256:
  de14e354a9d2151f74736ab827cb746a534967b8f241f6dc427928aa59828de9

Use only the listed Git commits as source. Do not run their scripts, tests,
package managers, or dependency installation. Static relationships do not prove
runtime execution or passing assertions.

| Repository | Pinned commit                            | Source                                                                                             |
| ---------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Hono       | f6fbaf0299c48eea9e656e03e2ffe7ac755e8823 | [Pinned Hono tree](https://github.com/honojs/hono/tree/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823)   |
| Zod        | 19c40d2072288b4cafec851e9d056a72a88e5973 | [Pinned Zod tree](https://github.com/colinhacks/zod/tree/19c40d2072288b4cafec851e9d056a72a88e5973) |
| Pinia      | 4817135a25431172d363bd928476db7cdbf875c4 | [Pinned Pinia tree](https://github.com/vuejs/pinia/tree/4817135a25431172d363bd928476db7cdbf875c4)  |

## Blinding instructions

1. The reviewer must not have authored the task labels. Record a reviewer alias
   and review date outside the repository; do not add personal data here.
2. Before completing the answer form, use only this packet and the pinned source
   trees. Do not inspect labels, CodeThread outputs, profile results, or the run
   report. If an item has already been exposed to predictions, mark it
   compromised and do not count it as independently reviewed.
3. Derive each answer directly from source. Record separate occurrences
   separately, even when they share a target. Record relation kind, exact source
   ranges, lexical owner where supported, target declaration when exact, and
   uncertainty or unsupported syntax.
4. Preserve the completed answers separately with a timestamp before comparing
   them with the frozen labels. Record disagreements; do not silently change the
   task bank. Any correction requires a reasoned, versioned update and new
   source review.

This packet supports a blinded audit of labels that were frozen before the
retained repository-profile runs. It does not turn the AI-authored labels into
independently authored gold until a reviewer completes and records the review.

## Frozen prompts

### Hono

#### hono-01-header-language-path

Trace detectFromHeader in src/middleware/language/language.ts. Identify its
direct call to the named header parser and report whether the later
normalizeLanguage call has an indexed exact function target. Include both
call-site and declaration evidence; do not infer execution.

#### hono-02-accept-parser-form

From parseAcceptLanguage, follow the call that parses the header. Find the
declaration form of parseAccept and report whether a named-function CALLS edge
can be exact.

#### hono-03-color-fallback

Trace the non-Cloudflare fallback in getColorEnabledAsync. Report the direct
named function it calls and show the occurrence and declaration evidence. Keep
the dynamic import distinct from a static CALLS edge.

#### hono-04-jwt-signing

For signing in src/utils/jwt/jws.ts, identify the direct helper calls that
select the algorithm and prepare the private key. Give one exact occurrence and
declaration location per helper.

#### hono-05-jwt-public-key-occurrences

In importPublicKey, locate each direct conversion through exportPublicJwkFrom.
Preserve the two source occurrences separately even though both resolve to the
same declaration.

### Zod

#### zod-01-local-reference-decoding

Within Zod v4 JSON Schema conversion, follow resolveRef to the helper that
decodes a local JSON Pointer segment. Report the exact direct relationship with
pinned source evidence.

#### zod-02-canonical-key-recursion

Trace the recursive canonicalization in canonicalKey. Report both direct
self-call sites as separate occurrences with the same exact target declaration.

#### zod-03-local-ref-conversion-branch

Follow the local $ref branch in convertBaseSchema. Identify the direct helper
that resolves the ref and the direct helper that converts the resolved schema,
keeping their call sites distinct.

#### zod-04-public-json-schema-entrypoint

From the public fromJSONSchema entrypoint, identify the direct version detector
and conversion helper. Show both call sites and declaration locations in the
selected Zod v4 project context.

#### zod-05-object-extension-helper

Compare extend and safeExtend in Zod v4 core utilities. Report the direct helper
call each makes to build the combined shape, preserving each call occurrence.

### Pinia

#### pinia-01-recursive-hydration-merge

Trace mergeReactiveObjects during nested state hydration. Report its direct
recursive call, then identify whether target.add passed to forEach has an exact
repository source method target. Do not treat a built-in method reference as an
execution claim.

#### pinia-02-options-store-setup

Follow options-store construction from createOptionsStore into its setup-store
helper. Report the exact direct call and both source locations.

#### pinia-03-store-creation-occurrences

Inside the useStore function declared by defineStore, distinguish normal
creation from hot-reload creation. Report both createSetupStore and both
createOptionsStore call occurrences separately.

#### pinia-04-patch-subscription-boundary

Trace the subscription notification from the named $patch implementation into
triggerSubscriptions. Then inspect the callback invocation inside
triggerSubscriptions and report the boundary of what the static source
establishes.

#### pinia-05-object-literal-install-owner

In createPinia, inspect the install method returned on the Pinia object. Report
whether its devtools calls can be attributed directly to createPinia or to an
indexed class-method owner; do not reparent them to the enclosing function.

## Independent answer form

Complete one row per task before comparing answers with the frozen labels. Add
additional occurrence rows in the separate response when a prompt asks for
multiple sites.

| Task ID                               | Answer and relation kind/status | Site and declaration evidence (path, range, source quote) | Uncertainty and static-evidence boundary | Reviewer confidence (1–5) |
| ------------------------------------- | ------------------------------- | --------------------------------------------------------- | ---------------------------------------- | ------------------------: |
| hono-01-header-language-path          |                                 |                                                           |                                          |                           |
| hono-02-accept-parser-form            |                                 |                                                           |                                          |                           |
| hono-03-color-fallback                |                                 |                                                           |                                          |                           |
| hono-04-jwt-signing                   |                                 |                                                           |                                          |                           |
| hono-05-jwt-public-key-occurrences    |                                 |                                                           |                                          |                           |
| zod-01-local-reference-decoding       |                                 |                                                           |                                          |                           |
| zod-02-canonical-key-recursion        |                                 |                                                           |                                          |                           |
| zod-03-local-ref-conversion-branch    |                                 |                                                           |                                          |                           |
| zod-04-public-json-schema-entrypoint  |                                 |                                                           |                                          |                           |
| zod-05-object-extension-helper        |                                 |                                                           |                                          |                           |
| pinia-01-recursive-hydration-merge    |                                 |                                                           |                                          |                           |
| pinia-02-options-store-setup          |                                 |                                                           |                                          |                           |
| pinia-03-store-creation-occurrences   |                                 |                                                           |                                          |                           |
| pinia-04-patch-subscription-boundary  |                                 |                                                           |                                          |                           |
| pinia-05-object-literal-install-owner |                                 |                                                           |                                          |                           |

After saving the completed form, compare each occurrence, owner, target,
relation kind, non-exact status, evidence range, and static-evidence boundary
against the frozen labels. Record agreement, disagreement, and adjudication
without overwriting the independent response.
