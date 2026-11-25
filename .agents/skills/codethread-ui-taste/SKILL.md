---
name: codethread-ui-taste
description:
  Review and refine CodeThread's existing viewer and Investigation Workspace UI.
  Use for layout, typography, density, responsive behavior, accessible
  interactions, and fixture-based visual verification.
---

# CodeThread UI taste

Follow [AGENTS.md](../../../AGENTS.md), the
[Warm Graphite design system](../../../docs/design/DESIGN.md), the
[component contracts](../../../docs/design/components.md), and the relevant
requirement.

- Put the verified source excerpt and its location first after selection. In
  Trace, keep the relationship list discoverable and reveal the diagram when
  requested. Keep the snapshot, range, relation status, coverage, truncation,
  and evidence availability readable in text.
- Use the existing type hierarchy, Warm Graphite roles, and spacing scale. Group
  a path, range, status, and its action. Common controls should stay
  recognizable and reachable on narrow screens. Keep long paths and hashes
  readable with reflow.
- Give users one clear action per state. Verify that an action reveals its
  result at the point of use and that transient panels preserve keyboard focus
  and restore it on close.
- Capture the same fixture before and after at 1440, 1280, 768, and 390 CSS
  pixels in both themes. Examine actual frames for empty, loading, partial,
  error, trace, and selected evidence states. Test keyboard operation, real
  browser zoom, long paths, and graph and list identity. Compare request counts
  and measured timings within the same runner.
- Tie each UI change to an observed task failure and a reproducible check.
  Follow existing component boundaries and use local system fonts and
  fixture-only evidence.

## Anti-AI-Slop & Editorial AI Guardrails

When reviewing or adding any optional AI capability (see
[ADR-0010](../../../docs/decisions/0010-evidence-bound-optional-ai.md) and
[evidence-bound-ai](../evidence-bound-ai/SKILL.md)), preserve CodeThread's
Technical Editorial / Warm Graphite identity:

- **Forbidden AI UI tropes:** Never add chat sidebars, conversation bubbles,
  floating assistant launchers, sparkle/magic icons, purple/neon/gradient AI
  accents, fake streaming typewriter animations, generic summary cards, or
  auto-invoked AI requests on symbol selection.
- **Source and verified facts always come first:** `Verified Source Excerpt`,
  exact `CALLS`/`REFERENCES`, coverage, truncation, and unknowns remain the
  primary surface. Optional AI output lives only in an explicit, on-demand
  disclosure or secondary editorial block and is hidden/disabled by default.
- **Strict visual and textual separation:** Render AI output with existing Warm
  Graphite tokens (`--ct-raised`, `--ct-border`, `--ct-ink`, `--ct-muted`)—never
  a separate brand palette. Always label it in plain words as generated,
  unverified static synthesis, display the model/snapshot provenance and
  verified citation count (`Citations verified: X/Y`), and surface rejected or
  ungrounded claims and typed failures explicitly.
- **Anchored to inspectable evidence:** Every AI claim must cite monospace
  evidence anchors (`path:line`) that jump directly to the corresponding
  verified excerpt in the Evidence Inspector. Never present AI text as proof of
  runtime execution or verified absence.

The upstream references inform hierarchy, spacing, and progressive disclosure
and the practice of checking rendered output. CodeThread defines the palette,
layout, and data rules.
[UX UI Design Taste](https://github.com/arez-xd/ux-ui-design-taste/blob/70c25e8258414a55cb8d09cee48c2ce9da4c1b3b/skills/design-taste/SKILL.md)
·
[Taste Skill browser review reference](https://github.com/Leonxlnx/taste-skill/blob/f6b76575f949707b4e3c37cd86cb44b0b98643e8/skills/taste-skill/SKILL.md)
