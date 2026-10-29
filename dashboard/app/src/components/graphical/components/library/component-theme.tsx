'use client';

import { IconTheme } from "./icon.js";
import { componentRadius } from "../../lib/component-radius.js";
import { iconWeightVariables } from "../../lib/theme-icon-weight.js";
import { useReducedMotion } from 'motion/react';
import {
  motionCurveFromVariables,
  motionDuration,
  resolveMotionTransition,
} from "../../lib/theme-motion.js";

import {
  createContext,
  createElement,
  useContext,
  useMemo,
  type CSSProperties,
  type ElementType,
  type ReactNode,
  type ComponentProps,
} from 'react';
import {
  getComponentParts,
  resolveComponentPartStyle,
  type ComponentPartId,
} from "../../lib/component-parts.js";
import {
  componentBoxShadow,
  withFocusBorder,
  previewCssVariables,
  DEFAULT_DOCUMENT,
  type ComponentId,
  type ComponentState,
  type ComponentStyle,
  type ThemeDocument,
  type ColorMode,
} from "../../lib/theme-model.js";

export type PartAppearances = Partial<
  Record<ComponentPartId, Partial<Record<ComponentState, ComponentStyle>>>
>;
const ThemeContext = createContext<{
  appearances: PartAppearances;
  variables: CSSProperties;
  component?: ComponentId;
  resolveComponent?: (component: ComponentId) => PartAppearances;
} | null>(null);
export const APPEARANCE_STATES: ComponentState[] = [
  'rest',
  'hover',
  'focus',
  'open',
  'highlighted',
  'selected',
  'checked',
  'indeterminate',
  'pressed',
  'readonly',
  'valid',
  'invalid',
  'loading',
  'complete',
  'low',
  'high',
  'disabled',
];
export function resolvePartAppearances(
  document: ThemeDocument,
  mode: ColorMode,
  component: ComponentId,
): PartAppearances {
  return Object.fromEntries(
    getComponentParts(component).map((part) => [
      part.id,
      Object.fromEntries(
        APPEARANCE_STATES.map((state) => [
          state,
          resolveComponentPartStyle(document, mode, component, part.id, state),
        ]),
      ),
    ]),
  );
}

/** Cache each referenced component independently of the containing specimen. */
export function createAppearanceResolver(
  document: ThemeDocument,
  mode: ColorMode,
) {
  const cache = new Map<ComponentId, PartAppearances>();
  return (component: ComponentId) => {
    if (!cache.has(component))
      cache.set(component, resolvePartAppearances(document, mode, component));
    return cache.get(component)!;
  };
}

/** A library theme scope also reaches portals through React context. No editor provider is required. */
export function ComponentTheme({
  appearances,
  variables,
  component,
  resolveComponent,
  children,
}: {
  appearances: PartAppearances;
  variables: CSSProperties;
  component?: ComponentId;
  resolveComponent?: (component: ComponentId) => PartAppearances;
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({ appearances, variables, component, resolveComponent }),
    [appearances, variables, component, resolveComponent],
  );
  return (
    <ThemeContext value={value}>
      <IconTheme variables={variables}>{children}</IconTheme>
    </ThemeContext>
  );
}
export function appearanceVariables(
  states: Partial<Record<ComponentState, ComponentStyle>>,
): CSSProperties {
  const result: Record<string, string | number> = {};
  for (const name of APPEARANCE_STATES) {
    const s = states[name] ?? states.rest;
    if (!s) continue;
    const icon = iconWeightVariables(s.fontWeight);
    const properties = {
      background: s.background,
      opacity: s.opacity ?? 1,
      filter: s.blur ? `blur(${s.blur}px)` : 'none',
      'backdrop-filter': s.backdropBlur ? `blur(${s.backdropBlur}px)` : 'none',
      'background-image': s.backgroundImage ?? 'none',
      bevel: s.bevelShadow ?? 'none',
      'bevel-content':
        s.bevelShadow && s.bevelShadow !== 'none' ? '""' : 'none',
      color: s.foreground,
      radius: componentRadius(s),
      'inner-radius': componentRadius(s, s.borderWidth),
      shadow: componentBoxShadow(s),
      'border-shadow': componentBoxShadow({ ...s, shadow: 'none' }),
      // A transparent zero layer composes with one-sided dividers; `none` cannot.
      elevation: s.shadow === 'none' ? '0 0 0 0 transparent' : s.shadow,
      top: `${s.paddingTop}px`,
      bottom: `${s.paddingBottom}px`,
      x: `${s.paddingX}px`,
      left: `${s.paddingLeft ?? s.paddingX}px`,
      right: `${s.paddingRight ?? s.paddingX}px`,
      gap: `${s.gap}px`,
      font: s.fontFamily,
      size: `${s.fontSize}px`,
      weight: s.fontWeight,
      'icon-stroke-width': icon['--icon-stroke-width'],
      'icon-light-display': icon['--icon-light-display'],
      'icon-regular-display': icon['--icon-regular-display'],
      'icon-bold-display': icon['--icon-bold-display'],
      line: `${s.lineHeight}px`,
      'letter-spacing': `${s.letterSpacing ?? 0}em`,
      control: `${s.controlSize}px`,
      edge: s.borderColor,
      'edge-width': `${s.borderWidth}px`,
      'border-authored': s.borderAuthored ? 1 : 0,
    };
    for (const [property, value] of Object.entries(properties))
      result[`--ui-${name}-${property}`] = value;
    if (name === 'checked' || name === 'indeterminate') {
      const focused = withFocusBorder(s, states.focus);
      result[`--ui-${name}-focused-shadow`] = componentBoxShadow(focused);
      result[`--ui-${name}-focused-edge`] = focused.borderColor;
      result[`--ui-${name}-focused-edge-width`] = `${focused.borderWidth}px`;
      result[`--ui-${name}-focused-inner-radius`] = componentRadius(
        focused,
        focused.borderWidth,
      );
    }
  }
  const focusOutline = (states.focus ?? states.rest)?.focusOutline;
  if (focusOutline) result['--focus-ring-outline'] = focusOutline;
  return result as CSSProperties;
}
const defaultVariables = previewCssVariables(DEFAULT_DOCUMENT.theme, 'light');
/** Live motion tokens follow the same React scope as styles, including portals. */
export function useThemeMotion(role: 'small' | 'large' = 'small') {
  const theme = useContext(ThemeContext);
  const reduced = useReducedMotion() === true;
  const curve = motionCurveFromVariables(
    (theme?.variables ?? defaultVariables) as Record<string, string | number>,
    role,
  );
  return {
    curve,
    disabled: reduced || motionDuration(curve) === 0,
    transition: resolveMotionTransition(curve, reduced),
  };
}
const defaults = new Map<ComponentId, PartAppearances>();
function defaultAppearances(component: ComponentId) {
  if (!defaults.has(component))
    defaults.set(
      component,
      resolvePartAppearances(DEFAULT_DOCUMENT, 'light', component),
    );
  return defaults.get(component)!;
}
export function usePartAppearance(
  component: ComponentId,
  part: ComponentPartId,
  state: ComponentState = 'rest',
) {
  const theme = useContext(ThemeContext);
  const appearances =
    theme?.component && theme.component !== component && theme.resolveComponent
      ? theme.resolveComponent(component)[part]
      : theme?.appearances[part];
  return (appearances ?? defaultAppearances(component)[part])?.[state];
}
export function usePartStyle(
  component: ComponentId,
  part: ComponentPartId,
): CSSProperties {
  const theme = useContext(ThemeContext);
  const appearances =
    (theme?.component && theme.component !== component && theme.resolveComponent
      ? theme.resolveComponent(component)[part]
      : theme?.appearances[part]) ?? defaultAppearances(component)[part];
  const variables = theme?.variables ?? defaultVariables;
  return useMemo(
    () => ({ ...variables, ...appearanceVariables(appearances ?? {}) }),
    [variables, appearances],
  );
}

/** Structural portal containers need theme variables without a component surface. */
export function themeContainer<C extends ElementType>(
  Base: C,
  structure: string,
): C {
  const classes = (value?: string) =>
    [structure, value].filter(Boolean).join(' ');
  function ThemedContainer(props: ComponentProps<C>) {
    const theme = useContext(ThemeContext);
    const { className, style, ...rest } = props as {
      className?: string | ((state: unknown) => string | undefined);
      style?: CSSProperties | ((state: unknown) => CSSProperties | undefined);
    };
    const variables = theme?.variables ?? defaultVariables;
    return createElement(Base, {
      ...rest,
      className:
        typeof className === 'function'
          ? (state: unknown) => classes(className(state))
          : classes(className),
      style:
        typeof style === 'function'
          ? (state: unknown) => ({ ...variables, ...style(state) })
          : { ...variables, ...style },
    });
  }
  ThemedContainer.displayName = `Themed(${structure})`;
  return ThemedContainer as unknown as C;
}

/** Preserve Base UI's complete prop/ref/render contracts while adding token styles. */
export function themePart<C extends ElementType>(
  Base: C,
  component: ComponentId,
  part: ComponentPartId,
  structure = '',
): C {
  const classes = (value?: string) =>
    ['ui-part', structure, value].filter(Boolean).join(' ');
  function ThemedPart(props: ComponentProps<C>) {
    const style = usePartStyle(component, part);
    const {
      className,
      style: consumerStyle,
      ...rest
    } = props as {
      className?: string | ((state: unknown) => string | undefined);
      style?: CSSProperties | ((state: unknown) => CSSProperties | undefined);
    };
    // Base UI's style/className state callbacks are not DOM prop getters.
    // Resolve them at the primitive boundary instead of flattening them in mergeProps.
    return createElement(Base, {
      ...rest,
      'data-ui-part': part,
      'data-ui-component': component,
      className:
        typeof className === 'function'
          ? (state: unknown) => classes(className(state))
          : classes(className),
      style:
        typeof consumerStyle === 'function'
          ? (state: unknown) => ({ ...style, ...consumerStyle(state) })
          : { ...style, ...consumerStyle },
    });
  }
  ThemedPart.displayName = `Themed(${component}.${part})`;
  return ThemedPart as unknown as C;
}
