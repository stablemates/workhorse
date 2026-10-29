import { NEUTRAL_KEYS, type ColorMode } from "./theme-model.js";

export const PALETTE_FOREGROUNDS = NEUTRAL_KEYS;
export type PaletteForeground = (typeof PALETTE_FOREGROUNDS)[number];
export function isPaletteForeground(value: string): value is PaletteForeground {
  return (PALETTE_FOREGROUNDS as readonly string[]).includes(value);
}
export type EditableNeutralKey =
  | 'neutral-2'
  | 'neutral-3'
  | 'neutral-4'
  | 'neutral-5'
  | 'neutral-6'
  | 'neutral-7'
  | 'neutral-8'
  | 'neutral-9';

export type ThemeColorPalette = {
  id: string;
  name: string;
  description: string;
  /** Color 1 is primary; Colors 2–4 are its secondary companions. */
  colors: Record<ColorMode, readonly [string, string, string, string]>;
  primaryForeground: Record<ColorMode, PaletteForeground>;
  neutrals?: Partial<
    Record<ColorMode, Partial<Record<EditableNeutralKey, string>>>
  >;
};

export type PaletteCatalog = Record<
  'atlas' | 'grove',
  readonly ThemeColorPalette[]
>;

export type PaletteChange = {
  themeId: keyof PaletteCatalog;
  paletteId: string;
  mode: ColorMode;
  target:
    | 'color-1'
    | 'color-2'
    | 'color-3'
    | 'color-4'
    | EditableNeutralKey
    | 'primary-foreground';
  value: string;
};
