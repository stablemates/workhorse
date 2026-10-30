---
name: graphical-audit
description: Audit a Graphical app, feature, or change for theme drift, one-off styling, undefined tokens, and inconsistent component treatments. Confirm issues in context and recommend existing-theme mappings; apply repairs when requested. Use for finding or fixing styles that bypass the active theme.
---

# Audit Graphical theme drift

Find where the requested UI fails to express its intended theme, with evidence from actual definitions and consumers. Different values are not automatically drift, and fewer tokens are not automatically a better result.

An audit is read-only unless repairs are requested. “Audit and fix” authorizes confirmed fixes within scope without another approval per mapping. This is an evidence-based review, not a claim that a source search checks every rendered state.

## Establish the baseline

Resolve the requested screen, feature, change, or codebase scope. Read the app root `GUI.md`, `gui/theme-contract.md`, and `gui/foundations.md`; locate them from the project root, not this installed skill. Identify active themes, intentional customizations, aliases, primitives, and shared component conventions. Current source owns deliberate local changes; `gui/themes.md` is a reference snapshot.

For a conversion follow-up, use the agreed target, mappings, and supported exceptions, including the selected setup recorded in `GUI.md`. Read `gui/components.md` and compare each component against its exact linked theme/component specification: structure, behavior, parts, variants, modes, states, named assignments, and resolved styles. Check that exported edits survived implementation; matching global tokens or a similar preset is insufficient. Unconverted library defaults are not intentional customizations merely because they exist in source. An agreed conversion includes repairing its remaining gaps within scope.

For simplification, preserve established values and relationships under `gui/theme-contract.md`; assess duplicate ownership and unnecessary overrides rather than numerical conformity to the snapshot. Do not use an audit to redesign the app, flatten semantic roles, or introduce a new scale.

For a named change, inspect its diff and relevant consumers, separating introduced issues from existing ones. A scoped UI task does not imply a whole-codebase audit. For broad reviews, state the inspected coverage and what remains; sampling does not establish completeness.

## Confirm issues in context

Read [drift rules](references/drift-rules.md). Search relevant styles, utility configuration, component definitions, and local overrides, excluding generated output, dependencies, and unrelated assets. Locally owned vendor components may contain the cause and are not automatically exempt.

Treat matches as candidates. Trace effective declarations through aliases, cascade, inheritance, responsive conditions, modes, and states to their consumers. Verify both that a treatment contradicts the intended role and that the replacement exists and preserves its meaning. Preserve expressions, units, semantic aliases, and foreground/background relationships; value equality is insufficient evidence. Read the relevant component guide when integration is involved.

Check coverage beyond token definitions and named controls: headings, body text, navigation, repeated surfaces, and popup content can retain independent styling. A changed variable does not prove that compiled utilities or inherited fonts use it. Group repeated symptoms at the shared cause, including affected consumers and the reach of a proposed repair.

When the full-component source is included, verify that consumers use the supplied `components/graphical/index.ts` exports, `styles.css` is loaded once, and `GraphicalProvider` receives the captured theme and actual color mode. Check that the shared runtime, authored component edits, and portal styling remain connected. A reconstructed approximation is not equivalent to using the bundled source. Check only missing runtime dependencies were added under the app’s version policy; guidance-only installation should add no source or runtime dependencies. Preserve explicit app-level adaptations and report their effect rather than assuming the source guarantees a rendered match.

For font or icon issues, verify families, weights, aliases, icon exports, and fallback decisions against `gui/assets.md` and the theme’s **Font and icon setup**. A read-only audit reports gaps; authorized repairs follow the asset guide’s file-request and fallback policy. A fallback chosen under that policy is not theme drift.

Use `gui/interface-judgment.md` for composition findings and `gui/foundations.md` for wrapping. Keep them distinct from token drift and preserve requested content and necessary instructions. Intentional customizations, valid aliases, structural geometry, artwork, and data encodings need context, not blanket replacement.

## Report or repair

Use [the report format](references/report-format.md): scope, prioritized findings, existing-theme replacements, coverage, and verification. Cite current file/line evidence and explain the consequence. Separate genuine theme gaps or uncertain mappings from confirmed fixes; no findings is a valid result.

For authorized repairs, use verified existing tokens and prefer shared components and supported variants at the owning source. Preserve behavior, modes/states, intentional exceptions, and dependency choices. A missing suitable token is a theme gap, not permission to invent one. Complete independent fixes while leaving ambiguous mappings explicit, then reinspect the affected consumers under `gui/verification.md` and the host’s review policy.

Finish with what was found or fixed, component coverage and usable import paths, asset substitutions, unresolved fidelity gaps, and what was actually verified. Full-library setup requires implemented reusable modules, not only tokens or dependencies. Do not claim visual fidelity, rendered contrast, or complete coverage from source inspection.
