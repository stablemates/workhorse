# Theme ownership and resolution

The [theme reference](themes.md) supplies the project’s foundations, light/dark CSS values, and effective component assignments. The receiving app owns their implementation. Read [GUI.md](../GUI.md) first.

## Define the theme once

Use the app’s existing CSS variables, theme object, or token configuration as the owning source. For a requested theme conversion, define the supplied values there; for simplification of an existing theme, preserve its established values. Keep both modes together and retain the current mode selection mechanism. Reuse aliases that serve the same role. Literal values belong in definitions; components consume named references.

The per-theme component reference includes effective assignments with defaults and shared references resolved. Choose the relevant component, variant, part, state, and mode. Translate token names through the foundations: for example, an `m` padding assignment uses the theme’s M spacing, while an `xl` radius uses its XL radius. Font roles have their own weight mappings. Match the property’s vocabulary rather than treating the same name as one universal measurement.

Authored component assignments record project edits for reference. They can be partial; use the effective assignment tables when implementing components. These tables describe styling, not an importable component API. Preserve the receiving primitive’s anatomy, accessibility behavior, and supported state selectors.

Use the user’s theme name for visible labels and documentation. In a full-component download, `document.name` is that display name; `document.theme.name`, the resolver’s `--theme-name`, and existing runtime data attributes are internal style identities. Preserve those internal values even when they differ from the display name: components use them to select behavior such as tab indicators and control geometry. Do not rename them or override provider variables to match the project name. The effective component assignments describe the authored surface treatments. Apply the current mode and state when choosing fills, edge placement, typography, and shadows.

## Existing tokens and components

Ordinary UI work uses only the active theme’s existing tokens and verified aliases for theme-controlled styling. Do not invent theme choices or hide them behind new variables, raw values, or arbitrary utilities. Defining supplied tokens in the host’s syntax during conversion is allowed; it does not expand the supplied vocabulary. Preserve explicitly authored component values under [Foundations](foundations.md). Structural layout choices such as grid tracks, breakpoints, and content widths remain application decisions, not exceptions for arbitrary themed spacing or typography.

Prefer existing shared components and supported variants, then compositions of available primitives. Add a component only for a missing capability, using the same theme vocabulary and retaining accessibility and interaction behavior. A missing suitable token is a theme gap: report it and continue independent work rather than approximating its meaning or expanding the theme without a request.

## Preserve local ownership

After adoption, intentional changes in the app’s theme definitions and shared components take precedence over the downloaded snapshot. Inspect those definitions before changing a screen. Do not restore original values merely because they appear in the reference.

Simplification preserves the app’s existing design while reducing duplicate definitions and unnecessary overrides. Consolidate equivalent roles at their existing owner without rounding values, fitting them to a new scale, or replacing them with a preset. A shared definition may serve several semantic aliases; equal values alone do not make their roles interchangeable. A request to simplify styles does not authorize a visual redesign.

During initial or incomplete conversion, use the agreed target theme and component mappings as the baseline. Existing library defaults or unconverted styles are not evidence of intentional customization. Record a preserved exception only when supported by the user’s direction or an established product requirement; distinguish it from a component that still needs conversion.

A shared token change can affect many screens. For a single element, prefer another existing token or the relevant component variant. When the user requests a theme change, edit its shared definition and explain the affected scope. Do not invent a parallel scale to work around it.

Retain the app’s primitive library, focus, labels, keyboard interaction, values, mode behavior, and portalled theme scope. Use [Base UI](base-ui.md) for that library or [Custom components](custom-components.md) for another implementation.

## Resolve styles in context

Follow representative consumers to the declaration that actually owns their appearance, through aliases, inheritance, utilities, component variants, and local overrides. Record the relevant mode, state, responsive condition, and foreground/background relationship. A token name or a matching number is insufficient evidence of a mapping.

Preserve authored relationships such as `var()` references, `currentColor`, relative units, unitless line heights, and `calc()` or fluid expressions. Do not replace them with one resolved pixel or color sample. Resolve `rem` against the app’s actual root size when comparing values; distinguish a line-height ratio from a length. Zero spacing and full/pill radii, status colors, focus indicators, and category encodings can carry meaning that a nearest-value match would erase.

Choose mappings by role, hierarchy, density, and behavior. Keep useful distinctions and explain uncertain mappings while continuing independent work. The graphical-convert skill includes mapping examples for adapting an existing interface.

The result is complete when the requested UI consumes the intended definitions across its relevant states and modes. Inspect real headings, body text, controls, repeated surfaces, and popups: updating an unused variable or only a component’s accent color does not establish adoption. During simplification, those consumers should retain their existing values and relationships; during conversion, they should express the agreed theme and supported exceptions.

## Updates

A new download is another reference snapshot. Compare it with intentional local theme and component changes before adopting it. Preserve local agent instructions and skills. Editing Markdown alone does not change the app’s runtime styling.

Guidance-only downloads require no Graphical package, provider, source directory, or installer. Full-component downloads use the bundled source and provider described in [Base UI integration](base-ui.md). Preserve the receiving project’s dependencies and check any APIs against its installed versions. [Font and icon setup](assets.md) owns asset selection and fallback decisions; these do not expand a guidance-only, planning, or read-only audit request.

Letter spacing uses the independent `theme.letterSpacing` scale (`xs`, `s`, `m`, `l`, `xl`, in em). An optional component `letterSpacing` assignment selects one of those names; omission follows the text-size mapping in [Foundations](foundations.md). Preserve these references in every component state and portalled surface.
