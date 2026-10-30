import { RADIUS_CORNERS } from "./component-radius.js";
import type { ColorMode, ComponentTokens, ComponentState } from "./theme-model.js";

/** Visual components beyond the six original controls. Utility providers have no canvas UI. */
export const BASE_UI_COMPONENTS = [
  ['accordion', 'Accordion'],
  ['alert-dialog', 'Alert dialog'],
  ['autocomplete', 'Autocomplete'],
  ['avatar', 'Avatar'],
  ['checkbox-group', 'Checkbox group'],
  ['collapsible', 'Collapsible'],
  ['context-menu', 'Context menu'],
  ['dialog', 'Dialog'],
  ['drawer', 'Drawer'],
  ['field', 'Field'],
  ['fieldset', 'Fieldset'],
  ['form', 'Form'],
  ['menu', 'Menu'],
  ['menubar', 'Menubar'],
  ['meter', 'Meter'],
  ['navigation-menu', 'Navigation menu'],
  ['number-field', 'Number field'],
  ['otp-field', 'OTP field'],
  ['popover', 'Popover'],
  ['preview-card', 'Preview card'],
  ['progress', 'Progress'],
  ['radio', 'Radio'],
  ['radio-group', 'Radio group'],
  ['scroll-area', 'Scroll area'],
  ['separator', 'Separator'],
  ['slider', 'Slider'],
  ['tabs', 'Tabs'],
  ['toast', 'Toast'],
  ['toggle', 'Toggle'],
  ['toggle-group', 'Toggle group'],
  ['toolbar', 'Toolbar'],
  ['tooltip', 'Tooltip'],
] as const;
export type CatalogComponentId = (typeof BASE_UI_COMPONENTS)[number][0];
export type CatalogPartId =
  | 'trigger'
  | 'content'
  | 'title'
  | 'description'
  | 'close'
  | 'backdrop'
  | 'track'
  | 'value'
  | 'error'
  | 'increment'
  | 'decrement'
  | 'image'
  | 'fallback'
  | 'separator'
  | 'viewport'
  | 'scrollbar'
  | 'link'
  | 'item'
  | 'list'
  | 'action'
  | 'panel'
  | 'legend'
  | 'group'
  | 'row'
  | 'clear';
export type CatalogScene =
  | 'default'
  | 'hover'
  | 'focus'
  | 'disabled'
  | 'open'
  | 'checked'
  | 'indeterminate'
  | 'selected'
  | 'pressed'
  | 'invalid'
  | 'valid'
  | 'readonly'
  | 'loading'
  | 'complete'
  | 'low'
  | 'high'
  | 'empty'
  | 'fallback';
type PartId =
  | CatalogPartId
  | 'control'
  | 'label'
  | 'input'
  | 'popover'
  | 'option'
  | 'indicator'
  | 'thumb';
export type CatalogPart = {
  id: PartId;
  label: string;
  properties: (keyof ComponentTokens)[];
  states: ComponentState[];
  defaults: Partial<ComponentTokens>;
  modeDefaults?: Partial<Record<ColorMode, Partial<ComponentTokens>>>;
  stateDefaults?: Partial<Record<ComponentState, Partial<ComponentTokens>>>;
  scenes?: CatalogScene[];
};
const TEXT: (keyof ComponentTokens)[] = [
  'foreground',
  'font',
  'textSize',
  'lineHeight',
  'weight',
  'letterSpacing',
];
const ICON: (keyof ComponentTokens)[] = ['foreground', 'textSize'];
const SURFACE: (keyof ComponentTokens)[] = [
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
const SPACE: (keyof ComponentTokens)[] = [
  'paddingTop',
  'paddingBottom',
  'paddingX',
  'paddingLeft',
  'paddingRight',
  'gap',
];
const PADDING = SPACE.filter((key) => key !== 'gap');
const INTERACTION: ComponentState[] = ['rest', 'hover', 'focus', 'disabled'];
const INTERACTION_SCENES: CatalogScene[] = [
  'default',
  'hover',
  'focus',
  'disabled',
];
const brand: Partial<ComponentTokens> = {
  background: 'color-1',
  foreground: 'neutral-1',
  borderColor: 'color-1',
};
const stateDefaults: CatalogPart['stateDefaults'] = {
  hover: { background: 'neutral-2', borderColor: 'neutral-5' },
  focus: { borderColor: 'color-1' },
  disabled: {
    background: 'neutral-2',
    foreground: 'neutral-6',
    borderColor: 'neutral-4',
    shadow: 'none',
  },
  pressed: { background: 'neutral-3', foreground: 'neutral-10' },
  selected: { background: 'neutral-3', foreground: 'neutral-10' },
  highlighted: { background: 'neutral-3', foreground: 'neutral-10' },
  open: { background: 'neutral-3', foreground: 'neutral-10' },
  invalid: { borderColor: 'error' },
  valid: { borderColor: 'success' },
  readonly: { background: 'neutral-2', foreground: 'neutral-8' },
  complete: { borderColor: 'color-1' },
};
const control = (
  id: PartId = 'control',
  label = 'Control',
  states = INTERACTION,
  defaults: Partial<ComponentTokens> = {},
): CatalogPart => ({
  id,
  label,
  states,
  properties: [...SURFACE, ...TEXT, ...SPACE],
  defaults: {
    background: 'neutral-1',
    borderColor: 'neutral-4',
    borderWidth: 's',
    radius: 's',
    foreground: 'neutral-10',
    font: 'ui',
    textSize: 's',
    weight: 'medium',
    shadow: 's',
    paddingTop: 'xs',
    paddingBottom: 'xs',
    paddingX: 's',
    gap: 'xs',
    ...defaults,
  },
  stateDefaults,
});
const quietControl = (
  id: PartId,
  label: string,
  states = INTERACTION,
  defaults: Partial<ComponentTokens> = {},
): CatalogPart => ({
  ...control(id, label, states, {
    background: 'none',
    borderColor: 'none',
    borderWidth: 'none',
    shadow: 'none',
    ...defaults,
  }),
  stateDefaults: {
    ...stateDefaults,
    hover: { background: 'neutral-3' },
    disabled: { background: 'none', foreground: 'neutral-6', shadow: 'none' },
  },
});
const input = (
  label = 'Input',
  states = [...INTERACTION, 'invalid', 'valid', 'readonly'] as ComponentState[],
  defaults: Partial<ComponentTokens> = {},
): CatalogPart => ({
  ...control('input', label, states, { weight: 'regular', ...defaults }),
  properties: [...SURFACE, ...TEXT, ...PADDING],
  stateDefaults: {
    ...stateDefaults,
    hover: { borderColor: 'neutral-5' },
  },
});
const primaryAction = (label = 'Action'): CatalogPart => ({
  ...control('action', label, INTERACTION, brand),
  stateDefaults: {
    ...stateDefaults,
    hover: { ...brand, shadow: 'm' },
    focus: { ...brand },
  },
});
const text = (
  id: PartId = 'label',
  label = 'Label',
  defaults: Partial<ComponentTokens> = {},
): CatalogPart => ({
  id,
  label,
  properties: TEXT,
  states: ['rest', 'disabled', 'invalid'],
  defaults: { font: 'ui', textSize: 's', weight: 'regular', ...defaults },
  stateDefaults: {
    disabled: { foreground: 'neutral-6' },
    invalid: id === 'error' ? { foreground: 'error' } : {},
  },
});
const surface = (
  id: PartId,
  label: string,
  defaults: Partial<ComponentTokens> = {},
): CatalogPart => ({
  id,
  label,
  properties: [...SURFACE, ...SPACE],
  states: ['rest'],
  defaults: {
    background: 'neutral-1',
    borderColor: 'neutral-4-transparent',
    borderWidth: 's',
    radius: 'm',
    paddingTop: 'm',
    paddingBottom: 'm',
    paddingX: 'm',
    gap: 's',
    ...defaults,
  },
});
const plainSurface = (
  id: PartId,
  label: string,
  defaults: Partial<ComponentTokens> = {},
): CatalogPart =>
  surface(id, label, {
    background: 'none',
    borderColor: 'none',
    borderWidth: 'none',
    radius: 'zero',
    paddingTop: 'zero',
    paddingBottom: 'zero',
    paddingX: 'zero',
    ...defaults,
  });
const disclosureTrigger = (): CatalogPart => ({
  ...quietControl('trigger', 'Trigger', [...INTERACTION, 'open'], {
    paddingTop: 'm',
    paddingBottom: 'm',
    paddingX: 'zero',
  }),
  stateDefaults: {
    focus: { borderColor: 'color-1' },
    disabled: { foreground: 'neutral-6' },
  },
});
const popup = (defaults: Partial<ComponentTokens> = {}): CatalogPart => ({
  ...surface('popover', 'Popup', { shadow: 'm', gap: 'xs', ...defaults }),
  scenes: ['open'],
});
const menuPopup = (): CatalogPart =>
  popup({
    paddingTop: 'xxs',
    paddingBottom: 'xxs',
    paddingX: 'xxs',
    gap: 'xxs',
  });
const option = (radius: ComponentTokens['radius'] = 'xs'): CatalogPart => ({
  ...quietControl(
    'option',
    'Item',
    ['rest', 'highlighted', 'selected', 'disabled'],
    {
      radius,
      weight: 'regular',
      paddingTop: 'xxs',
      paddingBottom: 'xxs',
      paddingX: 'xs',
    },
  ),
  scenes: ['open'],
});
const actionLabel = (): CatalogPart => ({
  ...text('label', 'Label', { weight: 'medium' }),
  states: [...INTERACTION, 'pressed'],
  stateDefaults: {
    disabled: { foreground: 'neutral-6' },
    pressed: { foreground: 'neutral-10' },
  },
});
const actionControl = (label = 'Control'): CatalogPart => ({
  ...quietControl('control', label, [...INTERACTION, 'pressed']),
  properties: [...SURFACE, ...PADDING],
});
const icon = (id: PartId, label: string): CatalogPart => ({
  ...text(id, label, { foreground: 'neutral-7', textSize: 'm' }),
  properties: ICON,
});
const iconControl = (
  id: PartId,
  label: string,
  defaults: Partial<ComponentTokens> = {},
): CatalogPart => ({
  ...control(id, label, INTERACTION, { paddingX: 'xs', ...defaults }),
  properties: [...SURFACE, ...ICON, ...PADDING],
});
const content = () => text('content', 'Content', { foreground: 'neutral-8' });
const title = () => text('title', 'Title', { textSize: 'm', weight: 'medium' });
const description = () =>
  text('description', 'Description', { foreground: 'neutral-7' });
const label = () => text('label', 'Label', { weight: 'medium' });
const separator = (): CatalogPart => ({
  id: 'separator',
  label: 'Separator',
  properties: ['borderColor', 'borderWidth'],
  states: ['rest'],
  defaults: { borderColor: 'neutral-4-transparent', borderWidth: 's' },
});
const choice = (checkbox = false): CatalogPart[] => [
  {
    ...control('control', 'Control', [
      ...INTERACTION,
      'checked',
      ...(checkbox ? ['indeterminate' as const] : []),
    ]),
    properties: [...SURFACE, 'controlSize', 'gap'],
    defaults: {
      ...control().defaults,
      radius: checkbox ? 'xs' : 'full',
      controlSize: 'm',
      borderColor: 'neutral-5',
      shadow: 'none',
      paddingTop: 'zero',
      paddingBottom: 'zero',
      paddingX: 'zero',
    },
    stateDefaults: {
      ...stateDefaults,
      hover: { borderColor: 'neutral-7' },
      checked: checkbox ? brand : { borderColor: 'color-1' },
      ...(checkbox ? { indeterminate: brand } : {}),
      disabled: {
        background: 'neutral-3',
        borderColor: 'neutral-4',
      },
    },
  },
  {
    ...surface('indicator', 'Indicator', {
      background: checkbox ? 'none' : 'color-1',
      foreground: checkbox ? 'neutral-1' : 'color-1',
      radius: 'full',
      borderWidth: 'none',
      paddingTop: 'zero',
      paddingBottom: 'zero',
      paddingX: 'zero',
    }),
    properties: checkbox ? ['foreground'] : [...SURFACE],
    scenes: [
      'checked',
      'disabled',
      ...(checkbox ? ['indeterminate' as const] : []),
    ],
    states: [
      'rest',
      'checked',
      'disabled',
      ...(checkbox ? ['indeterminate' as const] : []),
    ],
    stateDefaults: {
      disabled: {
        background: checkbox ? 'none' : 'neutral-6',
        foreground: 'neutral-6',
      },
    },
  },
  text('label', 'Label'),
];
const choiceRow = (checkbox = false): CatalogPart => ({
  ...plainSurface('row', 'Row', { radius: 's', gap: 'xs' }),
  properties: [...SURFACE, ...SPACE],
  states: [
    ...INTERACTION,
    'checked',
    ...(checkbox ? ['indeterminate' as const] : []),
  ],
});
const fieldParts = (): CatalogPart[] => [
  input(),
  label(),
  description(),
  {
    ...text('error', 'Error', { foreground: 'error', textSize: 'xs' }),
    scenes: ['invalid'],
  },
];
const modalParts = (
  alert = false,
  surfaceDefaults: Partial<ComponentTokens> = {},
): CatalogPart[] => [
  {
    ...control('trigger', 'Trigger'),
    scenes: ['default', 'hover', 'focus', 'disabled'],
  },
  {
    ...popup({
      paddingTop: 'l',
      paddingBottom: 'l',
      paddingX: 'l',
      gap: 's',
      shadow: 'l',
      ...surfaceDefaults,
    }),
    label: 'Surface',
  },
  {
    ...surface('backdrop', 'Backdrop', {
      background: 'neutral-10-transparent',
      borderWidth: 'none',
      radius: 'zero',
    }),
    modeDefaults: { dark: { background: 'neutral-1-transparent' } },
    properties: [...SURFACE],
    scenes: ['open'],
  },
  ...[
    title(),
    description(),
    primaryAction(),
    alert
      ? control('close', 'Close')
      : quietControl('close', 'Close', INTERACTION, { paddingX: 'xs' }),
  // oxlint-disable-next-line oxc/no-map-spread -- Builds the catalog once, from fresh objects.
  ].map((part) => ({ ...part, scenes: ['open'] as CatalogScene[] })),
];
const menuParts = (): CatalogPart[] => [
  control('trigger', 'Trigger', [...INTERACTION, 'open']),
  menuPopup(),
  option(),
  {
    ...text('label', 'Group label', {
      foreground: 'neutral-6',
      textSize: 'xs',
      weight: 'medium',
    }),
    scenes: ['open'],
  },
  { ...separator(), scenes: ['open'] },
  { ...text('indicator', 'Checkmark'), properties: ICON, scenes: ['open'] },
];
const rangeParts = (interactive: boolean, meter = false): CatalogPart[] => [
  {
    ...surface('track', 'Track', {
      background: 'neutral-3',
      borderWidth: 'none',
      radius: 'full',
      controlSize: 'xxs',
      paddingTop: 'zero',
      paddingBottom: 'zero',
      paddingX: 'zero',
    }),
    properties: [...SURFACE, 'controlSize'],
    states: interactive ? INTERACTION : ['rest'],
  },
  {
    ...surface('indicator', 'Fill', {
      background: 'color-1',
      borderWidth: 'none',
      radius: 'full',
      paddingTop: 'zero',
      paddingBottom: 'zero',
      paddingX: 'zero',
    }),
    properties: [...SURFACE],
    states: interactive
      ? ['rest', 'disabled']
      : meter
        ? ['rest', 'low', 'high']
        : ['rest', 'loading', 'complete'],
    stateDefaults: {
      disabled: { background: 'neutral-5' },
      low: { background: 'warning' },
      high: { background: 'error' },
    },
  },
  ...(interactive
    ? [
        {
          ...control('thumb', 'Thumb'),
          properties: [...SURFACE, 'controlSize'],
          defaults: {
            ...control().defaults,
            radius: 'full',
            controlSize: 'm',
            borderColor: 'color-1',
            paddingTop: 'zero',
            paddingBottom: 'zero',
            paddingX: 'zero',
            shadow: 's',
          },
          stateDefaults: {
            hover: { borderColor: 'color-1' },
            focus: { borderColor: 'color-1' },
            disabled: {
              background: 'neutral-2',
              borderColor: 'neutral-5-transparent',
              shadow: 'none',
            },
          },
        } satisfies CatalogPart,
      ]
    : []),
  label(),
  text('value', 'Value', { textSize: 'xs', foreground: 'neutral-7' }),
];
export const CATALOG: Record<
  CatalogComponentId,
  { scenes: CatalogScene[]; parts: CatalogPart[] }
> = {
  accordion: {
    scenes: [...INTERACTION_SCENES, 'open'],
    parts: [
      disclosureTrigger(),
      {
        ...plainSurface('panel', 'Panel', {
          paddingBottom: 'm',
          borderWidth: 's',
          borderColor: 'neutral-4-transparent',
        }),
        properties: [...SURFACE, ...PADDING],
        scenes: ['open'],
      },
      { ...content(), scenes: ['open'] },
      icon('indicator', 'Chevron'),
    ],
  },
  'alert-dialog': { scenes: ['default', 'open'], parts: modalParts(true) },
  autocomplete: {
    scenes: [...INTERACTION_SCENES, 'open', 'empty'],
    parts: [
      input('Input', INTERACTION),
      label(),
      { ...menuPopup(), scenes: ['open', 'empty'] },
      {
        ...option('s'),
        // A suggestion is a single label; Gap does not space the option rows.
        properties: [
          ...SURFACE,
          ...TEXT,
          ...SPACE.filter((key) => key !== 'gap'),
        ],
      },
      {
        ...text('content', 'Empty message', {
          foreground: 'neutral-7',
          paddingTop: 's',
          paddingBottom: 's',
          paddingX: 'xs',
        }),
        properties: [...TEXT, ...PADDING],
        scenes: ['empty'],
      },
    ],
  },
  avatar: {
    scenes: ['default', 'fallback'],
    parts: [
      {
        ...surface('control', 'Avatar', {
          background: 'neutral-3',
          radius: 'full',
          borderWidth: 'none',
          controlSize: 'xl',
          paddingTop: 'zero',
          paddingBottom: 'zero',
          paddingX: 'zero',
        }),
        properties: [...SURFACE, 'controlSize'],
      },
      {
        ...text('fallback', 'Initials', {
          weight: 'medium',
          foreground: 'neutral-8',
        }),
        scenes: ['fallback'],
      },
    ],
  },
  'checkbox-group': {
    scenes: [...INTERACTION_SCENES, 'checked', 'indeterminate'],
    parts: [
      {
        ...plainSurface('group', 'Group'),
        properties: [...SURFACE, ...SPACE],
      },
      choiceRow(true),
      ...choice(true),
    ],
  },
  collapsible: {
    scenes: [...INTERACTION_SCENES, 'open'],
    parts: [
      {
        ...plainSurface('group', 'Group'),
        properties: [...SURFACE, ...SPACE],
      },
      {
        ...disclosureTrigger(),
        defaults: {
          ...disclosureTrigger().defaults,
          paddingTop: 'xs',
          paddingBottom: 'xs',
        },
      },
      {
        ...surface('panel', 'Panel', {
          background: 'neutral-2',
          radius: 's',
          paddingTop: 's',
          paddingBottom: 's',
          paddingX: 's',
        }),
        properties: [...SURFACE, ...PADDING],
        scenes: ['open'],
      },
      { ...content(), scenes: ['open'] },
      icon('indicator', 'Chevron'),
    ],
  },
  'context-menu': {
    scenes: ['default', 'open'],
    parts: menuParts(),
  },
  dialog: { scenes: ['default', 'open'], parts: modalParts() },
  drawer: {
    scenes: ['default', 'open'],
    parts: modalParts(false, {
      radiusBottomLeft: 'zero',
      radiusBottomRight: 'zero',
    }),
  },
  field: {
    scenes: [...INTERACTION_SCENES, 'invalid', 'valid', 'readonly'],
    parts: [plainSurface('group', 'Field', { gap: 'xs' }), ...fieldParts()],
  },
  fieldset: {
    scenes: ['default', 'disabled'],
    parts: [
      plainSurface('group', 'Fieldset', { gap: 'm' }),
      text('legend', 'Legend', { textSize: 'm', weight: 'medium' }),
      plainSurface('content', 'Field'),
      ...fieldParts(),
    ],
  },
  form: {
    scenes: ['default', 'invalid', 'valid'],
    parts: [
      plainSurface('group', 'Form', { gap: 'm' }),
      plainSurface('content', 'Field'),
      ...fieldParts(),
      primaryAction('Submit button'),
    ],
  },
  menu: { scenes: [...INTERACTION_SCENES, 'open'], parts: menuParts() },
  menubar: {
    scenes: ['default', 'focus', 'open', 'disabled'],
    parts: [
      surface('group', 'Menubar', {
        paddingTop: 'xxs',
        paddingBottom: 'xxs',
        paddingX: 'xxs',
        radius: 's',
        shadow: 's',
        gap: 'xxs',
      }),
      ...menuParts().map((part) =>
        part.id === 'trigger'
          ? quietControl('trigger', 'Trigger', [...INTERACTION, 'open'], {
              paddingTop: 'xxs',
              paddingBottom: 'xxs',
              paddingX: 'xs',
            })
          : part,
      ),
    ],
  },
  meter: { scenes: ['default', 'low', 'high'], parts: rangeParts(false, true) },
  'navigation-menu': {
    scenes: ['default', 'hover', 'focus', 'open'],
    parts: [
      {
        ...plainSurface('list', 'Navigation', { gap: 'xxs' }),
        properties: [...SURFACE, ...PADDING],
      },
      quietControl('trigger', 'Trigger', [...INTERACTION, 'open']),
      popup({
        paddingTop: 'xs',
        paddingBottom: 'xs',
        paddingX: 'xs',
        gap: 'xxs',
      }),
      {
        ...quietControl('link', 'Link', [...INTERACTION, 'selected'], {
          weight: 'regular',
        }),
        properties: [...SURFACE, ...TEXT, ...PADDING],
        scenes: ['open'],
      },
    ],
  },
  'number-field': {
    scenes: [...INTERACTION_SCENES, 'readonly', 'invalid'],
    parts: [
      input('Input', [...INTERACTION, 'readonly', 'invalid']),
      label(),
      iconControl('decrement', 'Decrement', { radius: 'full' }),
      iconControl('increment', 'Increment', { radius: 'full' }),
    ],
  },
  'otp-field': {
    scenes: [...INTERACTION_SCENES, 'invalid', 'complete'],
    parts: [
      {
        ...input('Digit', [...INTERACTION, 'invalid', 'complete'], {
          controlSize: 'xl',
          paddingX: 'zero',
          weight: 'medium',
        }),
        properties: [...SURFACE, ...TEXT, ...PADDING, 'controlSize'],
      },
      label(),
      separator(),
    ],
  },
  popover: {
    scenes: [...INTERACTION_SCENES, 'open'],
    parts: modalParts()
      .filter((p) => p.id !== 'backdrop')
      // oxlint-disable-next-line oxc/no-map-spread -- Builds the catalog once, from fresh objects.
      .map((part) =>
        part.id === 'popover' ? { ...popup(), label: 'Surface' } : part,
      ),
  },
  'preview-card': {
    scenes: ['default', 'hover', 'focus', 'open'],
    parts: [
      {
        ...quietControl('trigger', 'Link', INTERACTION, {
          foreground: 'color-1',
          paddingTop: 'zero',
          paddingBottom: 'zero',
          paddingX: 'zero',
        }),
        properties: [...SURFACE, ...TEXT, ...PADDING],
        stateDefaults: {
          focus: { borderColor: 'color-1' },
          disabled: { foreground: 'neutral-6' },
        },
      },
      popup(),
      { ...title(), scenes: ['open'] },
      { ...description(), scenes: ['open'] },
    ],
  },
  progress: {
    scenes: ['default', 'loading', 'complete'],
    parts: rangeParts(false),
  },
  radio: {
    scenes: [...INTERACTION_SCENES, 'checked'],
    parts: choice(),
  },
  'radio-group': {
    scenes: [...INTERACTION_SCENES, 'checked'],
    parts: [plainSurface('group', 'Group'), choiceRow(), ...choice()],
  },
  'scroll-area': {
    scenes: ['default', 'hover', 'focus'],
    parts: [
      surface('viewport', 'Viewport', {
        radius: 's',
        paddingTop: 'm',
        paddingBottom: 'm',
        paddingX: 'm',
      }),
      content(),
      {
        ...surface('scrollbar', 'Scrollbar', {
          background: 'none',
          borderWidth: 'none',
          controlSize: 'xs',
          radius: 'full',
          paddingTop: 'zero',
          paddingBottom: 'zero',
          paddingX: 'zero',
        }),
        properties: [...SURFACE, 'controlSize'],
      },
      {
        ...control('thumb', 'Thumb', INTERACTION, {
          background: 'neutral-4',
          borderWidth: 'none',
          borderColor: 'none',
          radius: 'full',
          shadow: 'none',
        }),
        stateDefaults: {
          hover: { background: 'neutral-5' },
          focus: { background: 'neutral-5' },
          disabled: { background: 'neutral-3' },
        },
        properties: SURFACE,
      },
    ],
  },
  separator: { scenes: ['default'], parts: [separator()] },
  slider: { scenes: [...INTERACTION_SCENES], parts: rangeParts(true) },
  tabs: {
    scenes: ['default', 'hover', 'focus', 'selected', 'disabled'],
    parts: [
      surface('list', 'Tab list', {
        background: 'neutral-3',
        borderWidth: 'none',
        paddingTop: 'xxs',
        paddingBottom: 'xxs',
        paddingX: 'xxs',
        gap: 'xxs',
      }),
      {
        ...quietControl('trigger', 'Tab', [...INTERACTION, 'selected'], {
          foreground: 'neutral-7',
          paddingTop: 'xxs',
          paddingBottom: 'xxs',
        }),
        properties: [...SURFACE, ...TEXT, ...PADDING],
        stateDefaults: {
          hover: { foreground: 'neutral-10' },
          focus: { borderColor: 'color-1' },
          selected: {
            background: 'neutral-1',
            foreground: 'neutral-10',
            shadow: 's',
          },
          disabled: { foreground: 'neutral-6' },
        },
      },
      {
        ...plainSurface('panel', 'Panel', { paddingTop: 'xs' }),
        properties: [...SURFACE, ...PADDING],
      },
      content(),
    ],
  },
  toast: {
    scenes: ['default', 'open'],
    parts: [
      control('trigger', 'Trigger'),
      { ...popup(), label: 'Notification' },
      ...[
        text('title', 'Title', { weight: 'medium' }),
        description(),
        control('action', 'Action', INTERACTION, {
          paddingTop: 'xxs',
          paddingBottom: 'xxs',
          paddingX: 'xs',
        }),
        quietControl('close', 'Close', INTERACTION, {
          paddingTop: 'xxs',
          paddingBottom: 'xxs',
          paddingX: 'xxs',
        }),
      // oxlint-disable-next-line oxc/no-map-spread -- Builds the catalog once, from fresh objects.
      ].map((p) => ({ ...p, scenes: ['open'] as CatalogScene[] })),
    ],
  },
  toggle: {
    scenes: [...INTERACTION_SCENES, 'pressed'],
    parts: [actionControl(), actionLabel()],
  },
  'toggle-group': {
    scenes: [...INTERACTION_SCENES, 'pressed'],
    parts: [
      plainSurface('group', 'Group', { gap: 'xxs' }),
      actionControl('Toggle'),
      actionLabel(),
    ],
  },
  toolbar: {
    scenes: [...INTERACTION_SCENES, 'pressed'],
    parts: [
      surface('group', 'Toolbar', {
        paddingTop: 'xxs',
        paddingBottom: 'xxs',
        paddingX: 'xxs',
        gap: 'xxs',
        radius: 's',
        shadow: 's',
      }),
      actionControl('Button'),
      { ...actionLabel(), label: 'Icon' },
      separator(),
    ],
  },
  tooltip: {
    scenes: ['default', 'hover', 'focus', 'open', 'disabled'],
    parts: [
      quietControl('trigger', 'Trigger', INTERACTION, { paddingX: 'xs' }),
      {
        ...popup(),
        defaults: {
          ...popup().defaults,
          background: 'neutral-10',
          foreground: 'neutral-1',
          borderColor: 'none',
          borderWidth: 'none',
          paddingTop: 'xxs',
          paddingBottom: 'xxs',
          paddingX: 'xs',
          radius: 's',
          shadow: 's',
          textSize: 'xs',
          weight: 'medium',
        },
        properties: [...SURFACE, ...SPACE, ...TEXT],
      },
    ],
  },
};
export function isCatalogComponent(id: string): id is CatalogComponentId {
  return Object.hasOwn(CATALOG, id);
}
