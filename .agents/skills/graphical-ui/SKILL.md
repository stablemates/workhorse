---
name: graphical-ui
description: Use whenever asked to create or edit an interface in a project with Graphical guidance, even when the request does not mention Graphical. Build with existing theme tokens and prefer existing components, including for new screens, layouts, and responsive states. Theme conversion and codebase drift audits have separate workflows.
---

# Build with Graphical

The requested UI should feel native to the app: existing tokens, familiar components, and intact behavior. Apply this skill even when the user does not mention Graphical. A new interface request does not imply whole-app conversion, normalization, or expansion of the theme.

Read the project root `GUI.md` for the shared token and component rules, then `gui/interface-judgment.md` and `gui/foundations.md` for composition and styling. Locate them from the project root, not relative to this installed skill.

## Use the app’s actual vocabulary

Locate the active theme definitions, mode wiring, shared components, and a nearby example of the requested UI. Inspect declarations and consumers before choosing an unfamiliar token or variant. The generated `gui/themes.md` is a snapshot; deliberate local customizations take precedence.

Read `gui/theme-contract.md` when changing assignments or simplifying shared styles. Preserve established values and relationships while consolidating equivalent roles; a cleanup request does not authorize a new scale.

Read `gui/base-ui.md` for Base UI or `gui/custom-components.md` for custom markup and other primitive libraries. For initial adoption, follow `GUI.md` and graphical-convert.

Read `gui/components.md` and the exact specification linked for the active theme and each component being implemented. Preserve the supplied structure, parts, variants, states, modes, named assignments, and resolved styles, including the user’s exported edits. Use those details to implement reusable components; global tokens, a similar preset, or unmodified library defaults are not a substitute. Additional primitives without a specification use the existing foundations and remain an explicit coverage gap. Honor the saved setup selection in `GUI.md`, including full component implementation when selected, while respecting a narrower explicit user request.

When the full-component download includes `components/graphical/`, use the actual supplied source through `components/graphical/index.ts`; do not reconstruct those components from specifications. Follow `gui/base-ui.md` to import `styles.css` once and connect `GraphicalProvider` to the captured `theme` and actual color mode. Preserve the bundled runtime and user’s component edits. Add only missing `@base-ui/react`, `motion`, and `lucide-react` packages under the consumer’s version policy, and configure fonts/icons separately. The default guidance-only download adds no source or runtime dependencies; implement only the components needed by an authorized UI task.

For required fonts or icons, follow `gui/assets.md` and the theme’s **Font and icon setup**. The asset guide owns the licensed-font file request, fallback decision, and setup; honor known answers and existing assets.

## Compose with existing roles

Use only existing theme tokens or verified aliases for theme-controlled styling. Verify selected tokens, variants, parts, and states instead of guessing names or inserting raw fallback values. `gui/theme-contract.md` distinguishes structural layout choices from theme values.

Prefer existing components and supported variants, then compositions of available primitives. Add a component only for a missing capability, using existing tokens and preserving accessibility. New layouts can reuse the app’s controls and typography roles.

Preserve requested content and behavior. Apply the composition and removal guidance in `gui/interface-judgment.md`; each element should contribute useful information or an action. Custom markup may express application structure while existing primitives retain accessibility and interaction behavior.

Keep relevant responsive, empty, loading, error, disabled, and interaction states coherent with the current UI. Trace inherited typography and portal scopes so theme/mode changes reach the actual consumers. A body font change does not necessarily reach brand headings or popup text.

For authored React animation, use Motion for React (`motion/react`) and the theme’s motion values. Springs use `visualDuration` and `bounce`; preserve primitive lifecycles and reduced motion under `gui/foundations.md` and `gui/base-ui.md`.

If no existing token fits a required role, report the theme gap and continue independent work. Change the theme only when requested, at its owning source.

## Finish

Check that changed consumers use the intended definitions, simplification preserves their values and relationships, and required distinctions remain intact. Review unnecessary overrides and redundant composition under the shared references. Follow `gui/verification.md` and the host’s policy for affected checks; source inspection does not establish rendered fidelity or line breaks.

Report what changed, which existing roles or patterns it uses, component coverage and usable import paths, what was verified, and unresolved theme, asset, or fidelity gaps. Do not claim component setup is complete when only tokens or dependencies were installed, or claim rendered equivalence from source inspection.
