import { RADIUS_CORNERS } from "./component-radius.js";
import { configuredComponentReference } from "./component-references.js";
import { componentSurfaceRelief } from "./theme-surfaces.js";
import {
  CATALOG,
  isCatalogComponent,
  type CatalogPartId,
} from "./base-ui-catalog.js";
import {
  isAtlasTheme,
  componentBorderEdit,
  componentFocusOutline,
  componentKey,
  mergeComponentShadows,
  hasComponentBorderColorOverride,
  hasComponentForegroundOverride,
  resolveAutomaticForeground,
  resolveComponentTokens,
  resolveTokenStyle,
  type ButtonVariant,
  type ColorMode,
  type ComponentId,
  type ComponentState,
  type ComponentStyle,
  type ComponentTokens,
  type ThemeDocument,
  themePx,
} from "./theme-model.js";

export type ComponentPartId =
  | 'control'
  | 'label'
  | 'input'
  | 'popover'
  | 'option'
  | 'indicator'
  | 'thumb'
  | CatalogPartId;
export type ComponentProperty = keyof ComponentTokens;
export type ComponentPart = {
  id: ComponentPartId;
  label: string;
  properties: readonly ComponentProperty[];
  states: readonly ComponentState[];
};

const TEXT: ComponentProperty[] = [
  'foreground',
  'font',
  'textSize',
  'lineHeight',
  'weight',
  'letterSpacing',
];
const SURFACE: ComponentProperty[] = [
  'background',
  'backgroundOpacity',
  'opacity',
  'blur',
  'backdropBlur',
  'borderColor',
  'borderWidth',
  'radius',
  ...RADIUS_CORNERS,
  'shadow',
  'shadows',
];
const PADDING: ComponentProperty[] = [
  'paddingTop',
  'paddingBottom',
  'paddingX',
  'paddingLeft',
  'paddingRight',
];
const CONTROL_STATES: ComponentState[] = ['rest', 'hover', 'focus', 'disabled'];
const BUTTON_PARTS: ComponentPart[] = [
  {
    id: 'control',
    label: 'Control',
    properties: [...SURFACE, ...PADDING],
    states: CONTROL_STATES,
  },
  { id: 'label', label: 'Label', properties: TEXT, states: CONTROL_STATES },
];
const COMBOBOX_PARTS: ComponentPart[] = [
  {
    id: 'label',
    label: 'Label',
    properties: TEXT,
    states: ['rest', 'disabled'],
  },
  {
    id: 'input',
    label: 'Input',
    properties: [...SURFACE, ...PADDING, ...TEXT, 'gap'],
    states: CONTROL_STATES,
  },
  {
    id: 'popover',
    label: 'Popover',
    properties: [...SURFACE, ...PADDING, 'gap'],
    states: ['rest'],
  },
  {
    id: 'option',
    label: 'Option',
    properties: [...SURFACE, ...PADDING, ...TEXT],
    states: ['rest', 'highlighted', 'selected', 'disabled'],
  },
];

const FIELD_LABEL: ComponentPart = {
  id: 'label',
  label: 'Label',
  properties: TEXT,
  states: ['rest', 'disabled'],
};
const CHOICE_STATES: ComponentState[] = [...CONTROL_STATES, 'checked'];
const CONTROL_PARTS: Record<
  'input' | 'select' | 'checkbox' | 'switch',
  ComponentPart[]
> = {
  input: [
    {
      id: 'control',
      label: 'Input',
      states: [...CONTROL_STATES, 'invalid', 'valid', 'readonly'],
      properties: [...SURFACE, ...TEXT, ...PADDING],
    },
    FIELD_LABEL,
  ],
  select: [
    {
      id: 'control',
      label: 'Trigger',
      states: CONTROL_STATES,
      properties: [...SURFACE, ...TEXT, ...PADDING, 'gap'],
    },
    FIELD_LABEL,
    ...COMBOBOX_PARTS.filter(
      (part) => part.id === 'popover' || part.id === 'option',
    ),
  ],
  checkbox: [
    {
      id: 'control',
      label: 'Control',
      states: [...CHOICE_STATES, 'indeterminate'],
      properties: [...SURFACE, 'controlSize', 'gap'],
    },
    {
      id: 'indicator',
      label: 'Indicator',
      states: ['rest', 'checked', 'indeterminate', 'disabled'],
      properties: ['foreground'],
    },
    FIELD_LABEL,
  ],
  switch: [
    {
      id: 'row',
      label: 'Row',
      states: CHOICE_STATES,
      properties: [...SURFACE, ...PADDING, 'gap'],
    },
    {
      id: 'control',
      label: 'Track',
      states: CHOICE_STATES,
      properties: [...SURFACE, 'controlSize'],
    },
    {
      id: 'thumb',
      label: 'Thumb',
      states: CHOICE_STATES,
      properties: [...SURFACE],
    },
    FIELD_LABEL,
  ],
};

export function getComponentParts(
  component: ComponentId,
): readonly ComponentPart[] {
  const parts = isCatalogComponent(component)
    ? CATALOG[component].parts
    : component === 'button'
      ? BUTTON_PARTS
      : component === 'combobox'
        ? COMBOBOX_PARTS
        : CONTROL_PARTS[component];
  // oxlint-disable-next-line oxc/no-map-spread -- Builds the catalog once, from fresh objects.
  return parts.map((part) => {
    const properties: ComponentProperty[] = [...part.properties];
    if (!properties.includes('shadows')) properties.push('shadows');
    if (
      properties.includes('borderWidth') &&
      part.states.includes('focus') &&
      part.id !== 'row' &&
      part.id !== 'group' &&
      !(component === 'switch' && part.id === 'thumb')
    )
      properties.push('focusRing');
    return { ...part, properties };
  });
}

export function defaultComponentPart(component: ComponentId): ComponentPartId {
  if (isCatalogComponent(component)) return CATALOG[component].parts[0]!.id;
  return component === 'combobox' ? 'input' : 'control';
}

export function componentPartKey(
  component: ComponentId,
  variant: string,
  part: ComponentPartId,
  state: ComponentState,
) {
  return `${component}:${variant}:part:${part}:${state}`;
}

export function resolveComponentPartTokens(
  document: ThemeDocument,
  component: ComponentId,
  part: ComponentPartId,
  state: ComponentState = 'rest',
  variant: ButtonVariant | 'default' = 'default',
  mode: ColorMode = 'light',
): ComponentTokens {
  const definition = getComponentParts(component).find(
    (item) => item.id === part,
  );
  if (!definition) throw new Error(`Unknown ${component} part: ${part}`);
  const reference = configuredComponentReference(document, component, part);
  if (reference) {
    const source = resolveComponentPartTokens(
      document,
      reference.component,
      reference.part,
      state,
      reference.variant ?? 'default',
      mode,
    );
    if (reference.component !== 'button') return source;
    const label = resolveComponentPartTokens(
      document,
      'button',
      'label',
      state,
      reference.variant,
      mode,
    );
    return {
      ...source,
      foreground: label.foreground,
      font: label.font,
      textSize: label.textSize,
      lineHeight: label.lineHeight,
      letterSpacing: label.letterSpacing,
      weight: label.weight,
    };
  }
  if (!definition.states.includes(state)) state = 'rest';
  const base = resolveComponentTokens(document, component, 'rest', variant);
  if (isCatalogComponent(component)) {
    const authored = CATALOG[component].parts.find((item) => item.id === part)!;
    const authoredState = { ...authored.stateDefaults?.[state] };
    // Borderless controls need their own fill against the surrounding surface.
    // Keep this below authored edits so existing theme customizations stay literal.
    let atlasDefaults: Partial<ComponentTokens> = {};
    if (isAtlasTheme(document.theme)) {
      delete authoredState.shadow;
      if (
        authoredState.borderColor === 'error' ||
        authoredState.borderColor === 'success'
      )
        authoredState.background = `${authoredState.borderColor}-transparent`;
      if (component === 'menu' && part === 'popover')
        atlasDefaults = { radius: 'xs' };
      else if (component === 'slider' && part === 'thumb')
        atlasDefaults = {
          background:
            document.theme.primaryForeground?.[mode] ??
            (resolveAutomaticForeground(document.theme, mode, {
              background: 'color-1',
              foreground: 'neutral-1',
            }) === '#ffffff'
              ? mode === 'light'
                ? 'neutral-1'
                : 'neutral-10'
              : mode === 'light'
                ? 'neutral-10'
                : 'neutral-1'),
        };
      else if (component === 'radio' && part === 'control')
        atlasDefaults = {
          background: state === 'checked' ? 'color-1' : 'neutral-3',
        };
      else if (component === 'radio' && part === 'indicator')
        atlasDefaults = {
          background: mode === 'dark' ? 'neutral-10' : 'neutral-1',
        };
      else if (component === 'radio-group' && part === 'group')
        atlasDefaults = { gap: 'xxs' };
      else if (component === 'radio-group' && part === 'row')
        atlasDefaults = {
          paddingTop: 's',
          paddingBottom: 's',
          paddingX: 's',
          background:
            state === 'checked'
              ? 'neutral-3'
              : state === 'hover'
                ? 'neutral-3-transparent'
                : 'none',
        };
      else if (
        (component === 'autocomplete' || component === 'otp-field') &&
        part === 'input'
      )
        atlasDefaults = { background: 'neutral-3' };
      else if (
        component === 'number-field' &&
        (part === 'increment' || part === 'decrement')
      )
        atlasDefaults = { background: 'none', radius: 's' };
      atlasDefaults.shadow = part === 'popover' ? 'm' : 'none';
    }
    const popupDefaults: Partial<ComponentTokens> =
      mode === 'dark' &&
      part === 'popover' &&
      authored.defaults.background === 'neutral-1'
        ? { background: 'neutral-2' }
        : {};
    let groveDefaults: Partial<ComponentTokens> = {};
    if (
      document.theme.name === 'Grove' &&
      mode === 'dark' &&
      authored.defaults.background === 'neutral-1'
    )
      groveDefaults.background = 'neutral-2';
    // A divider needs a visible line even in themes whose surfaces have no strokes.
    const separatorDefaults: Partial<ComponentTokens> =
      part === 'separator'
        ? {
            borderWidth: document.theme.border.s || 1,
            borderColor: 'neutral-4',
          }
        : {};
    if (
      document.theme.name === 'Grove' &&
      component === 'preview-card' &&
      part === 'trigger'
    )
      groveDefaults.foreground = 'neutral-10';
    let menubarDefaults: Partial<ComponentTokens> = {};
    if (component === 'menubar') {
      if (
        part === 'group' &&
        ['Grove', 'Atlas', 'Lustre'].includes(document.theme.name)
      )
        menubarDefaults = {
          background: 'none',
          borderColor: 'none',
          borderWidth: 'none',
          shadow: 'none',
          radius: 'zero',
          paddingTop: 'zero',
          paddingBottom: 'zero',
          paddingX: 'zero',
          gap: 'xxs',
        };
      if (part === 'trigger') {
        menubarDefaults = {
          background: 'none',
          borderColor: 'none',
          borderWidth: 'none',
          shadow: 'none',
          radius: 's',
          paddingTop: 'xs',
          paddingBottom: 'xs',
          paddingX: 's',
          weight: 'regular',
        };
        delete authoredState.borderColor;
        if (state === 'hover' || state === 'open')
          authoredState.background = 'neutral-3';
      }
    }
    if (document.theme.name === 'Grove' && component === 'tabs') {
      if (part === 'list') {
        groveDefaults = {
          background: 'none',
          radius: 'zero',
          borderColor: 'neutral-4',
          borderWidth: 's',
          paddingTop: 'zero',
          paddingBottom: 'zero',
          paddingX: 'zero',
          gap: 'l',
        };
      } else if (part === 'trigger') {
        groveDefaults = {
          background: 'none',
          foreground: 'neutral-6',
          borderColor: 'none',
          borderWidth: 'none',
          radius: 'zero',
          shadow: 'none',
          paddingTop: 'xs',
          paddingBottom: 'xs',
          paddingX: 'zero',
          weight: 'regular',
        };
        delete authoredState.background;
        delete authoredState.borderColor;
        delete authoredState.shadow;
        if (state === 'selected')
          authoredState.foreground = mode === 'dark' ? 'color-1' : 'neutral-10';
        if (state === 'hover' || state === 'focus')
          authoredState.foreground = 'neutral-10';
        if (state === 'disabled') authoredState.foreground = 'neutral-4';
      }
    }
    return {
      ...base,
      background: 'none',
      foreground: 'neutral-10',
      borderColor: 'none',
      borderWidth: 'none',
      radius: 'zero',
      shadow: 'none',
      paddingTop: 'zero',
      paddingBottom: 'zero',
      paddingX: 'zero',
      gap: 'xs',
      ...authored.defaults,
      ...authored.modeDefaults?.[mode],
      ...atlasDefaults,
      ...popupDefaults,
      ...groveDefaults,
      ...separatorDefaults,
      ...menubarDefaults,
      ...(document.theme.name === 'Grove' && { textSize: 'm' }),
      ...(document.theme.name === 'Grove' &&
        component === 'number-field' &&
        (part === 'increment' || part === 'decrement') && { radius: 's' }),
      ...document.componentTokens[
        componentPartKey(component, variant, part, 'rest')
      ],
      ...authoredState,
      ...(component === 'number-field' &&
        (part === 'increment' || part === 'decrement') &&
        state === 'hover' && {
          background:
            document.componentTokens[
              componentPartKey(component, variant, part, 'rest')
            ]?.background ??
            (isAtlasTheme(document.theme)
              ? 'neutral-4'
              : (groveDefaults.background ?? authored.defaults.background)),
        }),
      ...(state === 'rest'
        ? {}
        : document.componentTokens[
            componentPartKey(component, variant, part, state)
          ]),
      ...mergeComponentShadows(
        base.shadows,
        document.componentTokens[
          componentPartKey(component, variant, part, 'rest')
        ]?.shadows,
        state === 'rest'
          ? undefined
          : document.componentTokens[
              componentPartKey(component, variant, part, state)
            ]?.shadows,
      ),
    };
  }

  let defaults: Partial<ComponentTokens> = {};
  let stateDefaults: Partial<ComponentTokens> = {};

  if (component === 'switch' && part === 'row') {
    defaults = {
      background: 'none',
      borderColor: 'none',
      borderWidth: 'none',
      paddingTop: 'zero',
      paddingBottom: 'zero',
      paddingX: 'zero',
      shadow: 'none',
      radius: 'zero',
      // Preserve gaps authored on Track before the enclosing row was selectable.
      gap: resolveComponentPartTokens(
        document,
        component,
        'control',
        state,
        variant,
        mode,
      ).gap,
    };
  } else if (part === 'label') {
    defaults = {
      background: 'none',
      borderColor: 'none',
      borderWidth: 'none',
      paddingTop: 'zero',
      paddingBottom: 'zero',
      paddingX: 'zero',
      shadow: 'none',
      radius: 'zero',
    };
    if (component !== 'button')
      defaults = {
        ...defaults,
        foreground: 'neutral-10',
        textSize: document.theme.name === 'Grove' ? 'm' : 's',
        weight: 'medium',
      };
    if (component === 'checkbox') defaults = { ...defaults, weight: 'regular' };
    if (state === 'disabled') stateDefaults = { foreground: 'neutral-6' };
    if (component === 'button' && state !== 'rest') {
      const legacyState = resolveComponentTokens(
        document,
        component,
        state,
        variant,
      );
      for (const key of TEXT) {
        if (legacyState[key] !== base[key])
          Object.assign(stateDefaults, { [key]: legacyState[key] });
      }
    }
  } else if (
    (component === 'combobox' || component === 'select') &&
    part === 'popover'
  ) {
    defaults = {
      background: mode === 'dark' ? 'neutral-2' : 'neutral-1',
      borderColor: 'neutral-4-transparent',
      paddingTop: 'xxs',
      paddingBottom: 'xxs',
      paddingX: 'xxs',
      radius: 's',
      shadow: 'm',
      gap: 'xxs',
    };
  } else if (
    (component === 'combobox' || component === 'select') &&
    part === 'option'
  ) {
    defaults = {
      background: 'none',
      borderColor: 'none',
      borderWidth: 'none',
      radius: 'xs',
      shadow: 'none',
      paddingTop: 'xxs',
      paddingBottom: 'xxs',
      paddingX: 'xs',
    };
    if (state === 'highlighted') stateDefaults = { background: 'neutral-3' };
    if (state === 'selected')
      stateDefaults = {
        background: 'neutral-2',
        foreground: 'neutral-10',
      };
    if (state === 'disabled') stateDefaults = { foreground: 'neutral-6' };
  } else if (part === 'indicator' || part === 'thumb') {
    defaults = {
      background: base.foreground,
      foreground: base.foreground,
      borderWidth: 'none',
      borderColor: 'none',
      radius:
        component === 'switch' && document.theme.name === 'Grove'
          ? 'xs'
          : 'full',
      shadow: 'none',
      paddingTop: 'zero',
      paddingBottom: 'zero',
      paddingX: 'zero',
      ...(part === 'thumb' && {
        borderColor: 'neutral-4-transparent',
        borderWidth: 's',
        shadow: 's',
      }),
    };
    if (state === 'disabled')
      stateDefaults = {
        foreground: 'neutral-6',
        background: 'neutral-6',
        shadow: 'none',
      };
  } else if (
    (component === 'checkbox' || component === 'switch') &&
    part === 'control'
  ) {
    defaults = {
      background: component === 'switch' ? 'neutral-4' : 'neutral-1',
      borderColor: 'neutral-4',
      ...(component === 'switch' && { borderWidth: 'none' }),
      ...(component === 'checkbox' &&
        isAtlasTheme(document.theme) && { background: 'neutral-3' }),
    };
    if (state === 'checked' || state === 'indeterminate')
      stateDefaults = {
        background: base.background,
        borderColor: base.borderColor,
      };
    if (state === 'hover')
      stateDefaults =
        component === 'switch'
          ? {}
          : {
              borderColor: 'neutral-5',
              ...(isAtlasTheme(document.theme) && {
                background: 'neutral-4',
              }),
            };
    if (state === 'focus')
      stateDefaults = { borderColor: 'color-1-transparent' };
    if (state === 'disabled')
      stateDefaults = {
        background: 'neutral-3',
        borderColor: 'neutral-4',
        shadow: 'none',
      };
  } else if (state !== 'rest') {
    // Existing authored state values remain the starting point for control parts.
    const legacyState = resolveComponentTokens(
      document,
      component,
      state,
      variant,
    );
    for (const key of definition.properties) {
      if (legacyState[key] !== base[key])
        Object.assign(stateDefaults, { [key]: legacyState[key] });
    }
  }

  if (
    isAtlasTheme(document.theme) &&
    component === 'input' &&
    part === 'control' &&
    (state === 'invalid' || state === 'valid')
  )
    stateDefaults.background =
      state === 'invalid' ? 'error-transparent' : 'success-transparent';

  if (
    document.theme.name === 'Grove' &&
    mode === 'dark' &&
    ((component === 'input' && part === 'control') ||
      (component === 'combobox' && part === 'input') ||
      (component === 'select' && part === 'control') ||
      (component === 'checkbox' && part === 'control') ||
      part === 'popover')
  )
    defaults.background = 'neutral-2';

  return {
    ...base,
    ...defaults,
    ...(isAtlasTheme(document.theme) && {
      shadow: part === 'popover' ? ('m' as const) : ('none' as const),
    }),
    ...document.componentTokens[
      componentPartKey(component, variant, part, 'rest')
    ],
    ...stateDefaults,
    ...(state === 'rest'
      ? {}
      : document.componentTokens[
          componentPartKey(component, variant, part, state)
        ]),
    ...mergeComponentShadows(
      base.shadows,
      document.componentTokens[
        componentPartKey(component, variant, part, 'rest')
      ]?.shadows,
      stateDefaults.shadows,
      state === 'rest'
        ? undefined
        : document.componentTokens[
            componentPartKey(component, variant, part, state)
          ]?.shadows,
    ),
  };
}

export function setComponentPartToken<K extends ComponentProperty>(
  document: ThemeDocument,
  component: ComponentId,
  variant: ButtonVariant | 'default',
  part: ComponentPartId,
  state: ComponentState,
  key: K,
  value: ComponentTokens[K],
): ThemeDocument {
  const definition = getComponentParts(component).find(
    (item) => item.id === part,
  );
  if (configuredComponentReference(document, component, part))
    throw new Error(`Edit the shared component for ${component}:${part}`);
  if (
    !definition?.properties.includes(key) ||
    !definition.states.includes(state)
  ) {
    throw new Error(`Unsupported ${component} ${part} property or state`);
  }
  const id = componentPartKey(component, variant, part, state);
  const borderEdit = componentBorderEdit(
    document.theme,
    resolveComponentPartTokens(document, component, part, state, variant),
    key,
    value,
  );
  return {
    ...document,
    componentTokens: {
      ...document.componentTokens,
      [id]: { ...document.componentTokens[id], ...borderEdit, [key]: value },
    },
  };
}

export function resolveComponentPartStyle(
  document: ThemeDocument,
  mode: ColorMode,
  component: ComponentId,
  part: ComponentPartId,
  state: ComponentState = 'rest',
  variant: ButtonVariant | 'default' = 'default',
): ComponentStyle {
  const reference = configuredComponentReference(document, component, part);
  if (reference) {
    return reference.component === 'button'
      ? resolveButtonPartStyle(
          document,
          mode,
          state,
          reference.variant ?? 'primary',
        )
      : resolveComponentPartStyle(
          document,
          mode,
          reference.component,
          reference.part,
          state,
          reference.variant ?? 'default',
        );
  }
  const definition = getComponentParts(component).find(
    (item) => item.id === part,
  );
  const tokens = resolveComponentPartTokens(
    document,
    component,
    part,
    state,
    variant,
    mode,
  );
  const effectiveState = definition?.states.includes(state) ? state : 'rest';
  const hasBorderColorOverride =
    hasComponentBorderColorOverride(
      document,
      component,
      variant,
      effectiveState,
    ) ||
    (['rest', effectiveState] as const).some(
      (value) =>
        document.componentTokens[
          componentPartKey(component, variant, part, value)
        ]?.borderColor !== undefined,
    );
  const style = resolveTokenStyle(
    document.theme,
    mode,
    tokens,
    definition?.properties.includes('borderWidth') ? state : 'rest',
    {
      // Outlines and dividers use their mode-aware tokens instead of a surface's default edge.
      borderColorAuthored:
        hasBorderColorOverride ||
        part === 'separator' ||
        (document.theme.name === 'Grove' &&
          component === 'tabs' &&
          part === 'list') ||
        (component === 'button' && variant === 'outline'),
      suppressFocusRing: part === 'row' || part === 'group',
      borderInset:
        part === 'control' &&
        ((component === 'button' &&
          !(document.theme.name === 'Grove' && variant === 'secondary')) ||
          (document.theme.name === 'Grove' && component === 'checkbox')),
      surface: definition?.properties.includes('background')
        ? componentSurfaceRelief(component, part)
        : undefined,
    },
  );
  style.borderAuthored = ['rest', effectiveState].some((value) =>
    [
      document.componentTokens[
        componentKey(component, variant, value as ComponentState)
      ],
      document.componentTokens[
        componentPartKey(component, variant, part, value as ComponentState)
      ],
    ].some(
      (overrides) =>
        overrides?.borderColor !== undefined ||
        overrides?.borderWidth !== undefined,
    ),
  );
  // Focus can coexist with checked/selected/open. Keep its outline available
  // independently of the appearance used for the control's fill and edge.
  if (definition?.properties.includes('focusRing'))
    style.focusOutline = componentFocusOutline(
      document.theme,
      mode,
      state === 'focus'
        ? tokens
        : resolveComponentPartTokens(
            document,
            component,
            part,
            'focus',
            variant,
            mode,
          ),
    );
  if (
    isAtlasTheme(document.theme) &&
    component === 'number-field' &&
    (part === 'increment' || part === 'decrement') &&
    !(['rest', effectiveState] as const).some(
      (value) =>
        document.componentTokens[
          componentPartKey(component, variant, part, value)
        ]?.radius !== undefined,
    )
  ) {
    const input = resolveComponentPartStyle(document, mode, component, 'input');
    const height = input.lineHeight + input.paddingTop + input.paddingBottom;
    // Concentric corners follow the actual input curve and the control's inset.
    const inset = themePx(document.theme.spacing.xxs);
    style.radius = Math.max(0, Math.min(input.radius, height / 2) - inset);
    for (const corner of RADIUS_CORNERS) {
      if (tokens[corner] === undefined && input[corner] !== undefined)
        style[corner] = Math.max(
          0,
          Math.min(input[corner], height / 2) - inset,
        );
    }
  }
  const hasForegroundOverride =
    hasComponentForegroundOverride(
      document,
      component,
      variant,
      effectiveState,
    ) ||
    (['rest', effectiveState] as const).some(
      (value) =>
        document.componentTokens[
          componentPartKey(component, variant, part, value)
        ]?.foreground !== undefined,
    );
  if (!hasForegroundOverride) {
    // Text-only button labels and checkbox marks sit on their control's fill.
    const background =
      (component === 'button' && part === 'label') ||
      (component === 'checkbox' && part === 'indicator')
        ? resolveComponentPartTokens(
            document,
            component,
            'control',
            state,
            variant,
            mode,
          ).background
        : tokens.background;
    style.foreground = resolveAutomaticForeground(document.theme, mode, {
      ...tokens,
      background,
    });
  }
  return style;
}

export function resolveButtonPartStyle(
  document: ThemeDocument,
  mode: ColorMode,
  state: ComponentState,
  variant: ButtonVariant,
): ComponentStyle {
  const control = resolveComponentPartStyle(
    document,
    mode,
    'button',
    'control',
    state,
    variant,
  );
  const label = resolveComponentPartStyle(
    document,
    mode,
    'button',
    'label',
    state,
    variant,
  );
  return {
    ...control,
    foreground: label.foreground,
    fontFamily: label.fontFamily,
    fontSize: label.fontSize,
    lineHeight: label.lineHeight,
    letterSpacing: label.letterSpacing,
    fontWeight: label.fontWeight,
  };
}
