import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { createHugeiconsRenderer } from "./components/graphical/components/library/hugeicons-renderer.js";
import { IconRendererProvider } from "./components/graphical/components/library/icon.js";

/**
 * The free Hugeicons pack has one variant. The theme selects it in `components/graphical/theme.ts`,
 * so a request for another variant means that the theme and the installed pack disagree.
 */
const freeVariant = "stroke-rounded";

const hugeicons = createHugeiconsRenderer({
  loadCatalog: async (variant) => {
    if (variant !== freeVariant) {
      throw new Error(`The free Hugeicons pack has no ${variant} variant`);
    }
    return { ...(await import("./hugeicons-catalog.js")) };
  },
  // The renderer gives the size, accessibility, and stroke-width style. Forward each of them.
  renderGlyph: (icon, { ref: _ref, strokeWidth, style, ...props }) => (
    <HugeiconsIcon
      icon={icon}
      {...props}
      style={strokeWidth === undefined ? style : { strokeWidth, ...style }}
    />
  ),
});

/** Draws each icon of the Graphical components with the installed Hugeicons pack. */
export function DashboardIconRenderer({ children }: { children: ReactNode }) {
  return <IconRendererProvider renderIcon={hugeicons.renderIcon}>{children}</IconRendererProvider>;
}
