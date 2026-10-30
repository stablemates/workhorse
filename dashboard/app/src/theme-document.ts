import { theme as graphicalTheme } from "./components/graphical/theme.js";
import type {
  FontDefinition,
  FontKey,
  ThemeDocument,
} from "./components/graphical/lib/theme-model.js";

/**
 * A font of the theme, with a fallback that the dashboard loads at the end of its stack.
 *
 * The Timeless Grotesk files are not in the repository yet. `assets/fonts/README.md` describes how
 * to add them. Until then each stack falls back to Geist, not to the generic sans-serif font.
 */
function withFallback(key: FontKey): FontDefinition {
  const font = graphicalTheme.theme.fonts[key];
  const family = font.family.replace(/,\s*sans-serif$/, "");
  return {
    ...font,
    family: `${family}, "Geist Variable", ui-sans-serif, system-ui, sans-serif`,
  };
}

/**
 * The Graphical theme document that the dashboard uses.
 *
 * Mantine and the Graphical controls both read this document, so both show the same font stack.
 * Only the font families differ from `components/graphical/theme.ts`.
 */
export const dashboardThemeDocument: ThemeDocument = {
  ...graphicalTheme,
  theme: {
    ...graphicalTheme.theme,
    fonts: {
      ui: withFallback("ui"),
      brand: withFallback("brand"),
      editorial: withFallback("editorial"),
      data: withFallback("data"),
    },
  },
};
