# Untitled — Separator specification

Read the [theme foundations](../../themes/untitled.md), [component index](../../components.md), and [Base UI integration guidance](../../base-ui.md). This specification captures the current theme's authored edits and the preview's resolved values. Preserve these choices when implementing this component; do not replace them with generic library styling or approximate them from the overall theme.

## Anatomy

Separator primitive with horizontal or vertical orientation and the supplied separator appearance.

## Layout and geometry

- Horizontal reference separator spans the container, has XXS spacing height and M spacing minimum width. Paint only a top inset edge plus elevation. Vertical orientation uses XXS width, at least L spacing height, stretches along its row, and paints only a leading inset edge plus elevation.
- Keep padding zero and background transparent. The spacing reserved around the visual line differs from stroke thickness; changing border width must not expand the structural gap.

## States and behavior

- Preserve semantic orientation and decorative presentation when requested. This part has no invented hover, click, focus, or selection behavior.

## Resolved specification

The JSON is design data, not a ready-made component. Each variant contains both modes, then parts and their supported states. `tokens` retains the named assignments; `style` contains the complete resolved appearance from the same resolver as the preview, including automatic foregrounds, per-corner radii, opacity, blur, focus treatment, and derived geometry. `css` contains the corresponding base CSS property values (camelCase property names; numeric dimensions are pixels except unitless properties).

Apply a part's relevant properties using its `properties` list and the anatomy/layout rules above. Text-only parts must not acquire a generic surface or padding simply because the base style object contains those fields. Keep themed properties linked to named tokens; use resolved values to reproduce and check derived treatments. `reference` identifies the immediate shared component and `source` its final owner, including the selected button variant. A button reference includes the referenced label's typography and foreground. Reuse that component so its refinements propagate consistently.

Compose shadow-based edges with elevation and separate inner bevels; native borders do not contribute to layout. Preserve the focus outline independently of checked, selected, and open fills. Reproduce the supported combined states described above rather than treating focus as an exclusive selection state. Structural widths can adapt to the receiving layout; authored spacing, typography, geometry, and surface treatments must remain intact.

```json
{
  "formatVersion": 1,
  "component": "separator",
  "label": "Separator",
  "structure": {},
  "parts": [{"id":"separator","label":"Separator","properties":["borderColor","borderWidth","shadows"],"states":["rest"]}],
  "variants": {
    "default": {
      "light": {
        "separator": {
          "rest": {"tokens":{"background":"none","foreground":"neutral-10","borderColor":"neutral-4","borderWidth":1,"radius":"zero","paddingTop":"zero","paddingBottom":"zero","paddingX":"zero","gap":"xs","textSize":"s","font":"ui","weight":"regular","controlSize":"l","shadow":"none","lineHeight":"s","letterSpacing":"l","shadows":{"light":[]}},"style":{"background":"transparent","opacity":1,"blur":0,"backdropBlur":0,"backgroundImage":"none","bevelShadow":"none","shadowLayers":[],"foreground":"#000000","borderColor":"#e7e7e7","borderWidth":1,"borderInset":false,"radius":0,"paddingTop":0,"paddingBottom":0,"paddingX":0,"paddingLeft":0,"paddingRight":0,"gap":8,"fontFamily":"\"Timeless Grotesk\", sans-serif","fontSize":14,"lineHeight":20,"letterSpacing":0.01,"fontWeight":400,"controlSize":24,"shadow":"none","borderAuthored":false},"css":{"--icon-stroke-width":"var(--theme-icon-stroke-width, 2)","--icon-light-display":"var(--theme-icon-light-display, none)","--icon-regular-display":"var(--theme-icon-regular-display, inline)","--icon-bold-display":"var(--theme-icon-bold-display, none)","opacity":"var(--component-presence-opacity, 1)","filter":"none","backdropFilter":"none","WebkitBackdropFilter":"none","--button-bevel-content":"none","--button-bevel-shadow":"none","--button-bevel-inset":"1px","--button-bevel-radius":"0px","backgroundColor":"transparent","backgroundImage":"none","color":"#000000","borderWidth":0,"borderStyle":"none","borderRadius":"0px","paddingTop":0,"paddingBottom":0,"paddingLeft":0,"paddingRight":0,"gap":8,"boxShadow":"0 0 0 1px #e7e7e7","fontFamily":"\"Timeless Grotesk\", sans-serif","fontSize":14,"fontWeight":400,"lineHeight":"20px","letterSpacing":"0.01em","height":"auto","minHeight":0}}
        }
      },
      "dark": {
        "separator": {
          "rest": {"tokens":{"background":"none","foreground":"neutral-10","borderColor":"neutral-4","borderWidth":1,"radius":"zero","paddingTop":"zero","paddingBottom":"zero","paddingX":"zero","gap":"xs","textSize":"s","font":"ui","weight":"regular","controlSize":"l","shadow":"none","lineHeight":"s","letterSpacing":"l","shadows":{"dark":[]}},"style":{"background":"transparent","opacity":1,"blur":0,"backdropBlur":0,"backgroundImage":"none","bevelShadow":"none","shadowLayers":[],"foreground":"#ffffff","borderColor":"#3d3d3d","borderWidth":1,"borderInset":false,"radius":0,"paddingTop":0,"paddingBottom":0,"paddingX":0,"paddingLeft":0,"paddingRight":0,"gap":8,"fontFamily":"\"Timeless Grotesk\", sans-serif","fontSize":14,"lineHeight":20,"letterSpacing":0.01,"fontWeight":400,"controlSize":24,"shadow":"none","borderAuthored":false},"css":{"--icon-stroke-width":"var(--theme-icon-stroke-width, 2)","--icon-light-display":"var(--theme-icon-light-display, none)","--icon-regular-display":"var(--theme-icon-regular-display, inline)","--icon-bold-display":"var(--theme-icon-bold-display, none)","opacity":"var(--component-presence-opacity, 1)","filter":"none","backdropFilter":"none","WebkitBackdropFilter":"none","--button-bevel-content":"none","--button-bevel-shadow":"none","--button-bevel-inset":"1px","--button-bevel-radius":"0px","backgroundColor":"transparent","backgroundImage":"none","color":"#ffffff","borderWidth":0,"borderStyle":"none","borderRadius":"0px","paddingTop":0,"paddingBottom":0,"paddingLeft":0,"paddingRight":0,"gap":8,"boxShadow":"0 0 0 1px #3d3d3d","fontFamily":"\"Timeless Grotesk\", sans-serif","fontSize":14,"fontWeight":400,"lineHeight":"20px","letterSpacing":"0.01em","height":"auto","minHeight":0}}
        }
      }
    }
  }
}
```

## Completion

Implement a reusable, importable component with the receiving project's supported primitive APIs. Compare every applicable part, variant, mode, and state with this specification, including inherited edits. Check geometry, typography, icons, compound states, portals, and motion under the project's review policy. Record actual checks and unresolved differences. Source/data checks establish specification parity, not rendered pixel parity; do not claim an exact visual match until it has been reviewed. Missing licensed assets and unsupported APIs are explicit gaps, never silent substitutes for the user's refinements.
