# CodeThread visual system — Technical Editorial / Warm Graphite

Status: **CT-WORKSPACE-001A candidate**, not an approved general product UI. See
Issue #37 and [component contracts](./components.md).

## Intent

Source-first, evidence-backed local code comprehension. No AI-chat styling, neon
accents, decorative gradients, universal cards or speculative widgets. Pinned
source and its uncertainties dominate the interface; a graph is a tool, not
decoration. Tests are optional evidence, not the default navigation.

## Source of truth

- Backend owns repository, revision, scan, project, snapshot, graph, evidence
  and semantic facts.
- Feature services adapt validated contracts and guard request identity, not
  semantic inference.
- Domain view components map typed statuses to accessible text and interaction.
- Primitives own presentation only; the theme owns color/spacing only.
- **Never equate** successful scan lifecycle, complete analysis coverage, exact
  relation resolution and nontruncated graph query. These are independent
  dimensions.

## Tokens

Canonical local viewer values live in `scripts/viewer.css`; tokens are prefixed
`--ct-`. The current viewer uses legacy variable aliases for compatibility.

| Role       | Token             | Light     | Dark      |
| ---------- | ----------------- | --------- | --------- |
| canvas     | `--ct-canvas`     | `#f4f3ef` | `#151a1a` |
| surface    | `--ct-surface`    | `#fffefa` | `#202625` |
| raised     | `--ct-raised`     | `#eceee9` | `#2b3431` |
| ink        | `--ct-ink`        | `#1f2726` | `#e7ece9` |
| muted      | `--ct-muted`      | `#5e6966` | `#a7b4ae` |
| border     | `--ct-border`     | `#d9ddd7` | `#35413d` |
| accent     | `--ct-accent`     | `#21685d` | `#86c5ae` |
| focus      | `--ct-focus`      | `#315cc6` | `#90afff` |
| calls      | `--ct-calls`      | `#356b8b` | `#91bfe0` |
| references | `--ct-references` | `#915d43` | `#e1af90` |
| error      | `--ct-error`      | `#a52a23` | `#ff9b92` |

Use IBM Plex Sans and IBM Plex Mono only if locally installed; offline system
sans/mono fallbacks are mandatory. No remote font request. Spacing: 4/8/12/16/24
px; radii: 4/8 px; no large shadows. Always represent status with words in
addition to visual styling.

## Composition direction

Desktop: context header → Explorer (file/symbol) + main source/trace switcher +
contextual Evidence Inspector. Source and evidence precede graph. At constrained
width collapse Inspector into accessible drawer. A real pinned investigation is
the first validation screen; the existing two-column loopback viewer is not a
complete product frontend.

## Design QA

Test 1440, 1280, 768 CSS pixels, 200% zoom, keyboard-only, theme light/dark,
long Unicode path, many edges, graph truncation, missing source, incorrect
snapshot identity and network races. Normal text, muted text, link/accent,
semantic labels and focus token must reach ≥4.5:1 against the intended primary
surface. Token contrast checks do not replace screenshot/accessibility audits.
No unsupported visual claims; no fabricated source facts.

A component becomes shared only after two demonstrated contexts or one stable
platform-wide primitive contract. Do not build a speculative library before the
first real vertical slice.
