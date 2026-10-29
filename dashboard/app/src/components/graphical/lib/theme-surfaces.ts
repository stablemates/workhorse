import { colorWithOpacity } from "./dialkit-color.js";
import { resolveShadowDefinition } from "./theme-model.js";
import type {
  ColorKey,
  ColorMode,
  ComponentId,
  ComponentShadow,
  ShadowDefinition,
  ThemeDefinition,
} from "./theme-model.js";

/** Decorative light is separate from elevation and from the palette's transparent tokens. */
export type SurfaceDetails = {
  edgeColor: ColorKey;
  light: SurfaceLighting;
  dark: SurfaceLighting;
};
type SurfaceLighting = {
  highlight: number;
  shade: number;
  gradientTop: number;
  gradientBottom: number;
  recessedShade: number;
};
export type SurfaceRelief = 'raised' | 'recessed';

/** Material lighting belongs to controls; containers and popups keep flat fills. */
export function componentSurfaceRelief(
  component: ComponentId,
  part = 'control',
): SurfaceRelief | undefined {
  if (
    ['input', 'combobox', 'autocomplete', 'number-field'].includes(component) &&
    ['input', 'control'].includes(part)
  )
    return 'recessed';
  if (
    ['button', 'select', 'checkbox', 'radio', 'switch', 'toggle'].includes(
      component,
    ) &&
    ['control', 'trigger', 'thumb'].includes(part)
  )
    return 'raised';
  if (component === 'slider' && part === 'thumb') return 'raised';
  return undefined;
}

export function resolveSurfaceDetails(
  theme: ThemeDefinition,
  mode: ColorMode,
  relief: SurfaceRelief = 'raised',
  buttonStroke?: number,
) {
  const lighting = theme.surfaceDetails?.[mode];
  if (!lighting)
    return { backgroundImage: 'none', shadow: 'none', shadowLayers: [] };
  const white =
    theme.colors[mode][mode === 'light' ? 'neutral-1' : 'neutral-10'];
  const black =
    theme.colors[mode][mode === 'light' ? 'neutral-10' : 'neutral-1'];
  const light = (opacity: number) => colorWithOpacity(white, opacity / 100);
  const dark = (opacity: number) => colorWithOpacity(black, opacity / 100);
  const shadowLayers: ComponentShadow[] = [];
  const layer = (
    y: number,
    blur: number,
    spread: number,
    opacity: number,
    highlight: boolean,
  ) => {
    const definition: ShadowDefinition & { clipToBorder?: boolean } = {
      type: 'box',
      position: 'inside',
      x: 0,
      y,
      blur,
      spread,
      opacity,
      color: highlight
        ? { light: 'neutral-1', dark: 'neutral-10' }
        : { light: 'neutral-10', dark: 'neutral-1' },
      ...(buttonStroke !== undefined && { clipToBorder: true }),
    };
    shadowLayers.push(definition);
    return resolveShadowDefinition(theme, mode, definition);
  };
  if (buttonStroke !== undefined) {
    // Paint the bevel on an inset layer. Painting it on the button itself puts
    // the white highlight beneath its translucent stroke and washes out the edge.
    const bevelShadow =
      buttonStroke > 0
        ? relief === 'recessed'
          ? [
              layer(1, 2, 0, lighting.recessedShade, false),
              layer(-1, 0, 0, lighting.highlight / 3, true),
            ].join(', ')
          : [
              layer(1, 0, 0, lighting.highlight, true),
              layer(-1, 0, 0, lighting.shade, false),
              layer(0, 0, 1, lighting.highlight / 4, true),
            ].join(', ')
        : 'none';
    return {
      backgroundImage:
        relief === 'recessed'
          ? `linear-gradient(180deg, ${dark(lighting.gradientBottom)} 0%, ${light(lighting.gradientTop / 2)} 100%)`
          : `linear-gradient(180deg, ${light(lighting.gradientTop)} 0%, ${dark(lighting.gradientBottom)} 100%)`,
      shadow: 'none',
      bevelShadow,
      shadowLayers,
    };
  }
  const shadow =
    relief === 'recessed'
      ? [
          layer(1, 2, 0, lighting.recessedShade, false),
          layer(-1, 0, 0, lighting.highlight / 2, true),
        ].join(', ')
      : [
          layer(1, 0, 0, lighting.highlight, true),
          layer(-1, 0, 0, lighting.shade, false),
        ].join(', ');
  return relief === 'recessed'
    ? {
        backgroundImage: `linear-gradient(180deg, ${dark(lighting.gradientBottom)} 0%, ${dark(0)} 55%)`,
        shadow,
        shadowLayers,
      }
    : {
        backgroundImage: `linear-gradient(180deg, ${light(lighting.gradientTop)} 0%, ${light(0)} 48%, ${dark(lighting.gradientBottom)} 100%)`,
        shadow,
        shadowLayers,
      };
}
