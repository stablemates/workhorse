---
name: graphical-convert
description: Apply a supplied Graphical theme to an existing app or interface. Map existing visual roles to the requested theme while preserving behavior, useful structure, and intentional customizations. Use for planning or implementing scoped theme adoption, including partially converted apps.
---

# Convert an interface to Graphical

A successful conversion makes the requested screens and components express the agreed theme through the app’s existing styling system. Equivalent roles share definitions; meaningful distinctions, application behavior, and supported local customizations survive. Updated global tokens alone are not completion.

Follow a planning-only request without editing source. A request to implement conversion authorizes the scoped implementation and its follow-up repairs; do not add approval rounds for routine mappings.

## Establish scope and target

Read the project root `GUI.md`, `gui/theme-contract.md`, `gui/foundations.md`, `gui/components.md`, and the relevant theme in `gui/themes.md`. Follow their links to the exact specification for each selected theme/component, including structure, behavior, named assignments, and resolved styles for parts, variants, states, and modes; global values alone do not describe the component conversion. Preserve exported edits rather than approximating them with a similar preset, documentation-demo styles, or unmodified library defaults. Locate these from the app root; if the guidance has not been added yet, follow the project setup steps in `GUI.md`. Do not invent a theme, registry URL, or package source when the required artifact is missing.

Inspect the styling system, shared components and their consumers, mode wiring, and existing customizations. Use an explicit scope already supplied by the user, including the saved full-component setup selection in `GUI.md`. That selection authorizes applying the theme to the existing app and implementing all supported Base UI components without another scope question; honor any narrower explicit request. Otherwise ask once how to apply the theme, explaining the reach of shared changes:

- **Convert the whole app** — update existing shared components and their usage across screens.
- **Convert selected areas** — identify pages or components to convert, accounting for shared definitions used elsewhere.
- **Keep the current UI for now** — retain the guidance for future work without changing existing runtime styles.

Carry the answer into conversion and audit without asking again. Resolve unnamed selected areas before editing. For guidance-only setup, finish with where the guidance lives and stop without applying global tokens or component changes.

Use `gui/theme-contract.md` to distinguish conversion from simplification: conversion defines the supplied token vocabulary in the host app; simplification preserves established values and relationships. Neither authorizes inventing additional theme choices.

## Map roles in context

Read [mapping examples](references/mapping-examples.md), including the shadcn guidance when applicable. Trace representative consumers through tokens, aliases, utilities, shared components, inheritance, and local overrides to the effective declaration. Include screen typography, navigation, repeated surfaces, and popups as well as named library controls. Identify where a shared change reaches beyond the requested scope.

Map by purpose, hierarchy, density, and state, preserving the contextual relationships in `gui/theme-contract.md`. Equal values need not share a role; a resolved sample need not be the owning value. Keep confirmed mappings, supported exceptions, and unresolved gaps distinct. Existing library defaults alone do not establish an intentional exception, and a mapping must not erase a required distinction.

Include the asset requirements from `gui/assets.md` and the target theme’s **Font and icon setup** in the mapping. During implementation, follow that guide’s licensed-font file request and fallback decision; planning only records the requirement.

For planning, deliver the mappings, affected shared definitions, gaps, and relevant checks without implementing. For implementation, continue with known mappings; ask only about missing decisions that materially affect the result.

## Apply the intended result

Keep one owning definition for each shared decision in the existing theme system. Prefer adapting existing shared components and variants, updating their consumers so old overrides do not defeat the requested treatment. Compose available primitives for missing capabilities. Apply effective assignments for the relevant variants, sizes, parts, states, and modes, including complete typography, spacing, surfaces, borders, shadows, and motion. Keep theme/mode changes live in portals and independently styled text roles.

For a full-component download, integrate the actual bundled `components/graphical/` source rather than reconstructing the library from specifications. Use its public `index.ts` exports, import `styles.css` once, and connect `GraphicalProvider` to the captured `theme` document and app color mode under `gui/base-ui.md`. Preserve the user’s component edits and the shared runtime while adapting existing consumers. Install only missing `@base-ui/react`, `motion`, and `lucide-react` packages according to the receiving project’s version policy; configure assets separately. For guidance-only setup, source and runtime dependencies are not included, and implementing components still requires a scoped UI request.

For selected areas, contain both token and component changes using supported scopes or variants. If isolation is unavailable, resolve that scope conflict before changing unrelated screens. Remove superseded styles only after confirming their consumers are covered.

Preserve routing, data, handlers, refs, form values, keyboard interactions, accessible names, and state distinctions. Keep the receiving primitive library and dependency versions, ranges, overrides, and lockfile choices. Add only genuinely missing packages under the app’s package-manager and version policy; validate APIs against installed versions. Read `gui/base-ui.md` for Base UI or `gui/custom-components.md` for adaptations. Incompatible APIs and unmapped roles are explicit gaps, not permission to silently replace dependencies or invent tokens.

Use `gui/interface-judgment.md` for composition and `gui/foundations.md` for typography, wrapping, surfaces, and motion. Preserve requested content and useful structure while removing redundant styling; theme adoption is not a reason to embellish the interface.

## Verify and report

Finish implementation with the included `graphical-audit` skill, using the agreed target, mappings, and supported exceptions. Find and fix remaining conversion gaps within that scope. This pass is part of the conversion; do not ask for approval again or broaden it to unrelated areas.

Follow `gui/verification.md` and the host’s review policy. Confirm that intended definitions reach actual consumers, including their relevant states and modes. Check behavior affected by component wiring changes; distinguish source checks from visual review.

Report coverage as **converted**, **already matches**, **intentionally preserved**, or **blocked**, with evidence or a reason. Use **already matches** only after comparing relevant specifications, assignments, modes, and states. For full-library setup, include usable component import paths and additional primitives without an exported specification. Name uninspected scope, asset substitutions, and unresolved fidelity gaps; do not claim completion while required components remain blocked or unreviewed, or when only tokens or dependencies were installed. Distinguish source verification from rendered equivalence. Group remaining issues by their owning source so work can continue without repeating discovery.
