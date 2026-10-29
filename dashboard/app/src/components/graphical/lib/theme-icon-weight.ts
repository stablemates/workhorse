import type { ThemeDefinition } from "./theme-model.js";
import { hugeiconsHasStroke, type HugeiconsVariant } from "./hugeicons-options.js";

type IconTheme = Pick<ThemeDefinition, 'iconFamily' | 'iconWeight'>;

const namedWeights = [
  { value: '300', label: 'Light' },
  { value: '400', label: 'Regular' },
  { value: '500', label: 'Bold' },
];
const familyWeights = {
  Phosphor: [{ value: '200', label: 'Thin' }, ...namedWeights],
  Central: [
    { value: '300', label: '1' },
    { value: '400', label: '1.5' },
    { value: '500', label: '2' },
  ],
  Lucide: Array.from({ length: 9 }, (_, index) => ({
    value: String(200 + index * 50),
    label: `${1 + index * 0.25}px`,
  })),
};

/** Filled Phosphor, Lucide, and Hugeicons have no independent weight variants. */
export function iconWeightOptions(
  family: ThemeDefinition['iconFamily'],
  style: ThemeDefinition['iconStyle'],
  hugeiconsVariant?: HugeiconsVariant,
) {
  if (family === 'Hugeicons' && hugeiconsVariant)
    return hugeiconsHasStroke(hugeiconsVariant) ? familyWeights.Lucide : [];
  if (style === 'filled' && family !== 'Central') return [];
  return familyWeights[
    family === 'Hugeicons' ? 'Lucide' : (family ?? 'Lucide')
  ];
}

export function resolveIconWeight(
  family: IconTheme['iconFamily'],
  weight: number,
) {
  if (!family || family === 'Lucide' || family === 'Hugeicons')
    return Math.max(200, Math.min(600, weight));
  if (family === 'Phosphor' && weight < 300) return 200;
  return weight < 400 ? 300 : weight < 500 ? 400 : 500;
}

/** Separate authored icon weight from typography; reset it in nested theme scopes. */
export function themeIconWeightVariables(theme: IconTheme) {
  const weight =
    theme.iconWeight === undefined
      ? undefined
      : resolveIconWeight(theme.iconFamily, theme.iconWeight);
  return {
    '--theme-icon-stroke-width':
      weight === undefined
        ? 'initial'
        : theme.iconFamily === 'Central'
          ? (weight - 100) / 200
          : weight / 200,
    '--theme-icon-thin-display':
      weight === undefined ? 'initial' : weight < 300 ? 'inline' : 'none',
    '--theme-icon-light-display':
      weight === undefined
        ? 'initial'
        : weight >= 300 && weight < 400
          ? 'inline'
          : 'none',
    '--theme-icon-regular-display':
      weight === undefined
        ? 'initial'
        : weight >= 400 && weight < 500
          ? 'inline'
          : 'none',
    '--theme-icon-bold-display':
      weight === undefined ? 'initial' : weight >= 500 ? 'inline' : 'none',
  };
}

/** Keep typography-driven defaults until an icon weight is explicitly authored. */
export function iconWeightVariables(weight: number) {
  const bounded = Math.min(900, Math.max(300, weight));
  return {
    '--icon-stroke-width': `var(--theme-icon-stroke-width, ${bounded / 200})`,
    '--icon-light-display': `var(--theme-icon-light-display, ${bounded < 400 ? 'inline' : 'none'})`,
    '--icon-regular-display': `var(--theme-icon-regular-display, ${bounded >= 400 && bounded < 500 ? 'inline' : 'none'})`,
    '--icon-bold-display': `var(--theme-icon-bold-display, ${bounded >= 500 ? 'inline' : 'none'})`,
  };
}
