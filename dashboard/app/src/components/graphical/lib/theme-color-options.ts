import { colorFormat, formatColor, parseColor } from "./dialkit-color.js";
import { NEUTRAL_KEYS, type ThemeDefinition } from "./theme-model.js";

export const NEUTRAL_TONES = ['warm', 'neutral', 'cool'] as const;
export type NeutralTone = (typeof NEUTRAL_TONES)[number];

export function themeNeutralTone(theme: ThemeDefinition): NeutralTone {
  if (theme.neutralTone) return theme.neutralTone;
  const color = parseColor(theme.colors.light['neutral-3']);
  if (!color || color.c < 0.005) return 'neutral';
  return color.h >= 180 && color.h <= 300 ? 'cool' : 'warm';
}

/** Edit the concrete neutral ramp in both modes, retaining its lightness steps. */
export function setThemeNeutralTone(
  theme: ThemeDefinition,
  neutralTone: NeutralTone,
): ThemeDefinition {
  const colors = { ...theme.colors };
  for (const mode of ['light', 'dark'] as const) {
    colors[mode] = { ...colors[mode] };
    // Grove's charcoal surfaces need only a hint of warmth or coolness.
    const tintStrength = theme.name === 'Grove' && mode === 'dark' ? 1 / 3 : 1;
    for (const key of NEUTRAL_KEYS) {
      const original = colors[mode][key];
      const color = parseColor(original);
      if (!color) continue;
      // White and black remain endpoints; the tint is strongest in the middle.
      const taper = Math.min(1, color.l / 0.15, (1 - color.l) / 0.15);
      colors[mode][key] = formatColor(
        {
          ...color,
          c:
            (neutralTone === 'warm'
              ? 0.018
              : neutralTone === 'cool'
                ? 0.012
                : 0) *
            tintStrength *
            Math.max(0, taper),
          h: neutralTone === 'warm' ? 85 : 255,
        },
        colorFormat(original),
      );
    }
  }
  return { ...theme, neutralTone, colors };
}

export function setThemePrimaryAction(
  theme: ThemeDefinition,
  primaryActionColor: 'neutral-10' | 'color-1',
): ThemeDefinition {
  return { ...theme, primaryActionColor };
}
