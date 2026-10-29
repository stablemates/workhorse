# GUI — Untitled design language

This file contains the saved theme and instructions for using it. The **Theme values** sections are readable, editable JSON and can restore the theme in Graphical. The accompanying `gui/` references describe component structure, behavior, and resolved styles; `skills/` contains workflows for using them. The full-component selection also includes Graphical’s actual themed component source and runtime. The default theme-and-skills selection includes guidance only and adds no runtime source or dependencies.

## Start here

Keep `GUI.md` and `gui/` at the project root. The install command puts the three skills in `.agents/skills/`; for a ZIP, copy the folders from `skills/` there, preserving existing files and local edits. Add this pointer to the project’s active agent instructions without replacing them: “For UI work, follow GUI.md and use graphical-ui, graphical-convert, or graphical-audit as appropriate.” Agents with other conventions can read these files directly.

Inspect the app’s styling, shared components, and consumers before making changes. Honor the selected setup recorded below and any scope the user already gave. Otherwise ask once: **“How would you like to apply this theme?”**

- **Convert the whole app:** update shared components and their usage across screens.
- **Convert selected areas:** establish the pages or components and contain shared changes using the app’s existing mechanisms.
- **Keep the current UI:** install the guidance and instruction pointer, then stop without changing styles or runtime dependencies.

Wait for a missing scope choice before changing application styles. A component request does not authorize whole-app conversion. These rules apply equally to prompt, terminal, and ZIP setup.

## Apply the theme

Use `graphical-convert` for existing UI, including its shadcn mapping when relevant. Use `graphical-ui` for new UI and future interface edits, even when the user does not mention Graphical. New screens use the current design system by default.

Implement the chosen scope in the app’s existing styling system and shared components. Use the values below, [foundations](gui/foundations.md), and each relevant [component specification](gui/components.md). Preserve authored component edits across parts, variants, sizes, states, modes, and portals. Global tokens alone do not complete conversion; an approximate preset or unchanged library defaults do not replace the supplied specifications.

Preserve content, behavior, routing, public component APIs, and intentional local customizations. After deliberate customization, the app’s active definitions take precedence over this downloaded snapshot. Preserve dependency versions, ranges, overrides, and lockfiles. Add only missing packages using the project’s package manager and version policy; verify APIs against installed versions and report incompatibilities instead of silently migrating dependencies.

### Set up all Base UI components

An explicit request for all Base UI components, including a recorded selection below, authorizes theme conversion, asset setup, and reusable modules across the existing app. Proceed without another scope question, honoring any narrower scope already supplied.

Integrate the bundled Graphical components and theme runtime; use their actual source rather than reconstructing the library from specifications. Import the bundled stylesheet, connect the theme provider to the supplied document and the app’s active color mode, and expose usable component imports. Reuse or adapt compatible existing shared components without discarding their public APIs or behavior. Use the [component specifications](gui/components.md) to verify the selected edits and [Base UI guidance](gui/base-ui.md) for integration. Check the receiving version’s [official catalog](https://base-ui.com/llms.txt) for additional primitives; use the same foundations where source is not supplied and disclose that coverage gap. Installing source files or dependencies alone does not complete setup until the components and existing app use the selected theme.

The source lives in `components/graphical/`. Import components, `GraphicalProvider`, and `theme` through its `index.ts`; `theme.ts` contains the captured document with the user’s component customizations. Import `components/graphical/styles.css` once at the framework’s supported stylesheet entry. Wrap the intended scope with `GraphicalProvider document={theme} colorMode={colorMode}`, using the app’s real light/dark state. Keep the bundled shared runtime with the components so their resolver, motion, and portal behavior remain connected. Configure the selected icons with `IconRendererProvider` under [Base UI integration](gui/base-ui.md), and fonts with the app’s loader; artwork and font files are not included. Do not silently leave Lucide active when a different free pack was selected.

Add only missing `@base-ui/react`, `motion`, and `lucide-react` packages required by the bundled source, using the receiving project’s package manager and version policy. Preserve its installed framework, React, dependency ranges, overrides, and lockfile decisions. Adapt source to supported APIs or report concrete incompatibilities; do not silently replace package versions. Install the selected fonts and icon pack separately under the asset instructions below. Guidance-only installation adds none of these runtime dependencies.

Before running an install command, check the receiving app’s installed APIs and dependency constraints. The supplied runtime uses React 19 context/provider and ref APIs and is verified against Base UI 1.7; this is a compatibility baseline, not a version-pinning requirement. Existing React 18 apps need compatible context/provider and ref-forwarding adaptations, or a concrete blocker report. Never upgrade existing dependencies automatically to make the source work.

## Rules for UI work

- Locate the active theme, mode, shared components, and nearby patterns first. Use existing tokens or verified aliases; report missing choices instead of inventing theme values. Keep named references at use sites and literals in token definitions. Typography includes family, weight, size, line height, and letter spacing.
- Reuse components and variants, then compose available primitives. New components fill missing capabilities using existing tokens. Consolidate equivalent roles without changing established values unless requested.
- Keep interfaces minimal: useful titles, content, and actions; no decorative eyebrows, filler subtitles, slogans, or redundant explanations. Default wrapping text to `text-wrap: pretty`.
- Treat grid tracks, breakpoints, content widths, aspect ratios, and positioning as structural choices. Preserve meaningful data encodings and external widgets in context.
- Preserve keyboard focus, labels, form values, interaction states, and theme propagation into portals. Use composed box shadows for edges with zero native border width, retaining opacity and the theme’s stroke placement.
- Fonts and icon artwork are acquired separately. Follow the selected assets and official links below. Preserve font names, weights, fallback stacks, and icon style/weight. Use licensed files when supplied; ask for missing files or their location before a fallback decision, honoring an existing answer. Use the documented free fallback only for unavailable paid selections, disclose substitutions, and explain how to restore licensed assets. System fonts need no download; report unresolved or gated sources without silently substituting.

## Verify and hand off

Finish conversion with `graphical-audit`: find and fix gaps within the agreed scope. Report each component as converted, already matches, intentionally preserved, or blocked, with evidence or a reason. For full library setup, also list module import paths and catalog coverage. Report actual checks, substitutions, and remaining gaps; source inspection alone does not establish rendered equivalence. Follow the receiving project’s testing and browser-review policy. A small edit does not trigger an app-wide audit.

## Focused references

| Need                                                   | Read                                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------- |
| Token ownership, aliases, and deliberate theme changes | [Theme contract](gui/theme-contract.md)                                   |
| Hierarchy, composition, navigation, and controls       | [Interface judgment](gui/interface-judgment.md)                           |
| Colors, typography, spacing, effects, and motion       | [Foundations](gui/foundations.md)                                         |
| Asset installation and licensed fallbacks              | [Font and icon setup](gui/assets.md)                                      |
| Component anatomy, assignments, states, and modes      | [Component specifications](gui/components.md)                             |
| Primitives and existing libraries                      | [Base UI](gui/base-ui.md) · [Custom components](gui/custom-components.md) |
| Resolved CSS variables and component assignments       | [Theme references](gui/themes.md)                                         |
| Proportional checks                                    | [Verification](gui/verification.md)                                       |

| Task                                    | Skill               |
| --------------------------------------- | ------------------- |
| Build or edit UI with the current theme | `graphical-ui`      |
| Apply this theme to existing UI         | `graphical-convert` |
| Find and repair theme drift             | `graphical-audit`   |


## Selected setup for this download

The user selected **Install theme, skills, and all Base UI components**. The actual preview components, shared styling runtime, stylesheet, and current theme snapshot are included in `components/graphical/`. Use these files directly; do not recreate them from specifications. Follow [the component setup guide](gui/base-ui.md): import `components/graphical/styles.css` once, wrap the app with `GraphicalProvider` using the exported `theme`, and use the public components from `components/graphical/index.ts`. Apply the theme across existing app styles and components, preserving behavior and authored refinements. This is an explicit setup request: proceed without another conversion-scope question, honoring any narrower scope already supplied. Add only missing dependencies with the receiving package manager; preserve existing versions and report API incompatibilities. Install the chosen fonts and icons separately. Report component coverage, import paths, actual verification, and any visual or asset gaps. Copying files or installing Base UI alone is not completion.

In this repository, `components/graphical/` is `dashboard/app/src/components/graphical/`. `dashboard/app/src/ui.ts` re-exports its public entry.

## Fonts and icons

Follow [asset installation](gui/assets.md) when implementing this theme. Download and configure the selected free assets from their official sources; no font files or icon artwork are bundled. Weights below are the authored requests: load matching static faces or a variable range and report any unavailable weight. Register the exact family aliases below, or map the role tokens to the loader’s actual family.

| Selected font | Roles | Weights | Family stack | Setup |
| --- | --- | --- | --- | --- |
| <code>Timeless Grotesk</code> (free) | brand, ui, editorial, data | 400, 500, 600 | <code>"Timeless Grotesk", sans-serif</code> | Download and load [Timeless Grotesk](https://timeless.co/type) in the app. Use the vendor’s Grotesk cut; if using Timeless Sans variable files, pin STYL to 0, with ital 0 for upright or 100 for required italic faces. |

The Timeless Grotesk download needs an email form, so this repository does not include the files yet. Until they are added, the dashboard uses the stack `"Timeless Grotesk", "Geist Variable", ui-sans-serif, system-ui, sans-serif` (`dashboard/app/src/theme-document.ts`). `dashboard/app/src/assets/fonts/README.md` tells you where to put the files.

### Icons

Selected: [Hugeicons](https://hugeicons.com/docs/integrations/react/quick-start) free pack, outlined, variant `stroke-rounded` (the only variant in the free pack). This repository chose Hugeicons in place of the downloaded Lucide selection. React uses <code>@hugeicons/core-free-icons</code> and <code>@hugeicons/react</code>. `dashboard/app/src/graphical-icons.tsx` connects them to `IconRendererProvider`. The bundled source still imports <code>lucide-react</code> for its fallback artwork.

Preserve icon size, color, weight, style, and accessible names. Match the selected style only where the pack supports it; the free Hugeicons pack supplies `stroke-rounded` outlines only, so report a filled-style gap rather than claiming exact filled artwork. Keep existing package versions and add only missing packages using the receiving project’s package manager.

## Theme values

These sections contain the complete saved theme: both color modes, foundation values, and authored component edits. Import this GUI.md from Theme → Edit → Import theme to restore it. Shared palette catalogs and editor preferences are not part of the theme.

Lengths are pixels, letter spacing is em, motion durations are milliseconds, and opacity values are percentages. Text sizes, line heights, spacing, and radii render at the nearest whole pixel; the saved precision below preserves editing values. Color translucency defaults to 20% when omitted. Component edits use named tokens; the companion component specifications resolve inherited styles and behavior.

<!-- graphical-theme:start -->

### Identity

```json
{
  "format": "graphical-theme",
  "version": 1,
  "preset": "atlas",
  "schemaVersion": 2,
  "name": "Untitled"
}
```

### Colors

```json
{
  "colors": {
    "light": {
      "neutral-1": "#ffffff",
      "neutral-2": "#fbfbfb",
      "neutral-3": "#f4f4f4",
      "neutral-4": "#e7e7e7",
      "neutral-5": "#cdcdcd",
      "neutral-6": "#a1a1a1",
      "neutral-7": "#7d7d7d",
      "neutral-8": "#555555",
      "neutral-9": "#333333",
      "neutral-10": "#000000",
      "color-1": "#cf9148",
      "color-2": "#07376b",
      "color-3": "#c9b8f5",
      "color-4": "#ffe0b8",
      "success": "#00906c",
      "warning": "#ffea00",
      "error": "#fc032d"
    },
    "dark": {
      "neutral-1": "#000000",
      "neutral-2": "#202020",
      "neutral-3": "#2b2b2b",
      "neutral-4": "#3d3d3d",
      "neutral-5": "#565656",
      "neutral-6": "#838383",
      "neutral-7": "#ababab",
      "neutral-8": "#cfcfcf",
      "neutral-9": "#f4f4f4",
      "neutral-10": "#ffffff",
      "color-1": "#cf9148",
      "color-2": "#07376b",
      "color-3": "#c9b8f5",
      "color-4": "#ffe0b8",
      "success": "#00906c",
      "warning": "#ffea00",
      "error": "#fc032d"
    }
  },
  "primaryForeground": { "light": "neutral-2", "dark": "neutral-2" },
  "primaryActionColor": "neutral-10",
  "neutralTone": "neutral",
  "colorEmphasis": 52,
  "keyColorPalette": [
    "#ff5a00",
    "#ff9800",
    "#cf9148",
    "#d4b441",
    "#ffea00",
    "#abff5a",
    "#6dcc00",
    "#00c853",
    "#00906c",
    "#085e55",
    "#00b7c4",
    "#00e1f3",
    "#00afe8",
    "#0088ff",
    "#07376b",
    "#242424",
    "#5151fc",
    "#5100c0",
    "#a34cf3",
    "#e82cf2",
    "#ff6fff",
    "#ffc0ff",
    "#ff2c9c",
    "#ff2863",
    "#fc032d"
  ]
}
```

### Typography

```json
{
  "fonts": {
    "ui": {
      "family": "\"Timeless Grotesk\", sans-serif",
      "weights": { "regular": 400, "medium": 500, "heavy": 600 }
    },
    "brand": {
      "family": "\"Timeless Grotesk\", sans-serif",
      "weights": { "regular": 400, "medium": 500, "heavy": 600 }
    },
    "editorial": {
      "family": "\"Timeless Grotesk\", sans-serif",
      "weights": { "regular": 400, "medium": 500, "heavy": 600 }
    },
    "data": {
      "family": "\"Timeless Grotesk\", sans-serif",
      "weights": { "regular": 400, "medium": 500, "heavy": 600 }
    }
  },
  "text": {
    "xxs": { "size": 10, "lineHeight": 14 },
    "xs": { "size": 12, "lineHeight": 16 },
    "s": { "size": 14, "lineHeight": 20 },
    "m": { "size": 16, "lineHeight": 24 },
    "l": { "size": 24, "lineHeight": 32 },
    "xl": { "size": 36, "lineHeight": 40 },
    "xxl": { "size": 48, "lineHeight": 52 }
  },
  "letterSpacing": { "xs": -0.02, "s": -0.01, "m": 0, "l": 0.01, "xl": 0.02 }
}
```

### Spacing and corners

```json
{
  "spacing": {
    "zero": 0,
    "xxs": 4,
    "xs": 8,
    "s": 12,
    "m": 16,
    "l": 24,
    "xl": 32,
    "xxl": 48
  },
  "radius": {
    "zero": 0,
    "xs": 4.08,
    "s": 8.16,
    "m": 12.16,
    "l": 17.84,
    "xl": 27.52,
    "full": 9999
  },
  "buttonRadius": "s"
}
```

### Borders and effects

```json
{
  "border": { "none": 0, "s": 0, "m": 0, "l": 0 },
  "shadows": {
    "s": {
      "x": 0,
      "y": 2,
      "blur": 4,
      "spread": 0,
      "opacity": 0,
      "color": { "light": "neutral-10", "dark": "neutral-1" }
    },
    "m": {
      "x": 0,
      "y": 8,
      "blur": 24,
      "spread": 0,
      "opacity": 12,
      "color": { "light": "neutral-10", "dark": "neutral-1" }
    },
    "l": {
      "x": 0,
      "y": 16,
      "blur": 48,
      "spread": 0,
      "opacity": 0,
      "color": { "light": "neutral-10", "dark": "neutral-1" }
    }
  }
}
```

### Motion

```json
{
  "animation": {
    "duration": 160,
    "easing": [ 0.16, 1, 0.3, 1 ],
    "large": {
      "type": "easing",
      "duration": 280,
      "easing": [ 0.16, 1, 0.3, 1 ],
      "visualDuration": 0.36,
      "bounce": 0.3
    },
    "popupScale": 0.96,
    "pressDistance": 1,
    "type": "easing",
    "visualDuration": 0.2,
    "bounce": 0.2
  }
}
```

### Icons

No separate icon weight is set; icons follow the surrounding text weight.

```json
{ "iconFamily": "Hugeicons", "iconStyle": "outlined", "hugeiconsVariant": "stroke-rounded" }
```

### Component edits

```json
{
  "componentTokens": {
    "button:primary:rest": { "paddingTop": "s", "paddingBottom": "s", "paddingX": "l" },
    "button:secondary:rest": { "paddingTop": "s", "paddingBottom": "s", "paddingX": "l" },
    "button:outline:rest": { "paddingTop": "s", "paddingBottom": "s", "paddingX": "l" },
    "button:ghost:rest": { "paddingTop": "s", "paddingBottom": "s", "paddingX": "l" },
    "button:danger:rest": { "paddingTop": "s", "paddingBottom": "s", "paddingX": "l" },
    "input:default:rest": {
      "background": "neutral-3",
      "paddingTop": "s",
      "paddingBottom": "s",
      "paddingX": "m"
    },
    "select:default:rest": {
      "background": "neutral-3",
      "paddingTop": "s",
      "paddingBottom": "s",
      "paddingX": "m"
    },
    "combobox:default:rest": {
      "background": "neutral-3",
      "paddingTop": "s",
      "paddingBottom": "s",
      "paddingX": "m"
    },
    "autocomplete:default:part:popover:rest": { "radius": "s" },
    "autocomplete:default:part:input:rest": {
      "paddingTop": "s",
      "paddingRight": "s",
      "paddingBottom": "s",
      "paddingLeft": "s",
      "paddingX": "s"
    },
    "autocomplete:default:part:option:selected": {
      "paddingTop": "xs",
      "paddingRight": "xs",
      "paddingBottom": "xs",
      "paddingLeft": "xs",
      "paddingX": "xs"
    },
    "autocomplete:default:part:option:rest": {
      "paddingTop": "xs",
      "paddingRight": "xs",
      "paddingBottom": "xs",
      "paddingLeft": "xs",
      "paddingX": "xs"
    },
    "checkbox:default:part:control:rest": { "controlSize": "l" },
    "combobox:default:part:option:selected": {
      "paddingTop": "xs",
      "paddingRight": "xs",
      "paddingBottom": "xs",
      "paddingLeft": "xs",
      "paddingX": "xs"
    },
    "combobox:default:part:option:rest": {
      "paddingTop": "xs",
      "paddingRight": "xs",
      "paddingBottom": "xs",
      "paddingLeft": "xs",
      "paddingX": "xs"
    },
    "menu:default:part:option:selected": {
      "paddingTop": "xs",
      "paddingRight": "xs",
      "paddingBottom": "xs",
      "paddingLeft": "xs",
      "paddingX": "xs"
    },
    "menu:default:part:option:rest": {
      "paddingTop": "xs",
      "paddingRight": "xs",
      "paddingBottom": "xs",
      "paddingLeft": "xs",
      "paddingX": "xs"
    },
    "otp-field:default:part:input:rest": {
      "paddingTop": "xs",
      "paddingRight": "s",
      "paddingBottom": "xs",
      "paddingLeft": "s",
      "paddingX": "s"
    },
    "slider:default:part:track:rest": { "controlSize": "xl" },
    "slider:default:part:thumb:rest": { "controlSize": "l" },
    "switch:default:part:control:rest": { "controlSize": "xl" }
  },
  "componentVariants": {}
}
```

<!-- graphical-theme:end -->
