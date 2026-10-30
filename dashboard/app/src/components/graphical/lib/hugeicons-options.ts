/** Hugeicons publishes only these geometry/style combinations. */
export const HUGEICONS_VARIANTS = {
  'stroke-standard': { geometry: 'standard', style: 'stroke' },
  'solid-standard': { geometry: 'standard', style: 'solid' },
  'duotone-standard': { geometry: 'standard', style: 'duotone' },
  'stroke-rounded': { geometry: 'rounded', style: 'stroke' },
  'solid-rounded': { geometry: 'rounded', style: 'solid' },
  'duotone-rounded': { geometry: 'rounded', style: 'duotone' },
  'twotone-rounded': { geometry: 'rounded', style: 'twotone' },
  'bulk-rounded': { geometry: 'rounded', style: 'bulk' },
  'stroke-sharp': { geometry: 'sharp', style: 'stroke' },
  'solid-sharp': { geometry: 'sharp', style: 'solid' },
} as const;

export type HugeiconsVariant = keyof typeof HUGEICONS_VARIANTS;
export type HugeiconsGeometry =
  (typeof HUGEICONS_VARIANTS)[HugeiconsVariant]['geometry'];
export type HugeiconsStyle =
  (typeof HUGEICONS_VARIANTS)[HugeiconsVariant]['style'];

export const HUGEICONS_GEOMETRIES = [
  { value: 'standard', label: 'Standard' },
  { value: 'rounded', label: 'Rounded' },
  { value: 'sharp', label: 'Sharp' },
] as const;
export const HUGEICONS_STYLES = [
  { value: 'stroke', label: 'Outline' },
  { value: 'solid', label: 'Filled' },
  { value: 'duotone', label: 'Duotone' },
  { value: 'twotone', label: 'Twotone' },
  { value: 'bulk', label: 'Bulk' },
] as const;

export function isHugeiconsVariant(value: unknown): value is HugeiconsVariant {
  return typeof value === 'string' && Object.hasOwn(HUGEICONS_VARIANTS, value);
}

export function hugeiconsVariantFor(
  geometry: HugeiconsGeometry,
  style: HugeiconsStyle,
): HugeiconsVariant {
  const requested = `${style}-${geometry}`;
  if (isHugeiconsVariant(requested)) return requested;
  // Preserve filled or outlined construction when a geometry lacks a special style.
  return `${style === 'bulk' ? 'solid' : 'stroke'}-${geometry}`;
}

export function hugeiconsIconStyle(
  variant: HugeiconsVariant,
): 'filled' | 'outlined' {
  return hugeiconsHasStroke(variant) ? 'outlined' : 'filled';
}

export function hugeiconsHasStroke(variant: HugeiconsVariant) {
  return (
    HUGEICONS_VARIANTS[variant].style === 'stroke' ||
    HUGEICONS_VARIANTS[variant].style === 'duotone' ||
    HUGEICONS_VARIANTS[variant].style === 'twotone'
  );
}
