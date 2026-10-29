'use client';

/** Public composition API. Rendering, motion and behavior stay in the preview library. */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { Button as BaseButton } from '@base-ui/react/button';
import { Checkbox as BaseCheckbox } from '@base-ui/react/checkbox';
import { Combobox as BaseCombobox } from '@base-ui/react/combobox';
import { Select as BaseSelect } from '@base-ui/react/select';
import { Switch as BaseSwitch } from '@base-ui/react/switch';
import { mergeProps } from '@base-ui/react/merge-props';
import {
  resolveButtonPartStyle,
  resolveComponentPartStyle,
} from "../../lib/component-parts.js";
import {
  choiceAppearance,
  choiceMarkStyle,
  choiceState,
  controlAppearances,
  partCss,
  selectAppearances,
} from "../../lib/component-appearances.js";
import {
  previewCssVariables,
  type ButtonVariant,
  type ComponentId,
} from "../../lib/theme-model.js";
import { ThemedButton } from "./button.js";
import { ThemedInput } from "./input.js";
import { ThemedCheckbox as CheckboxControl } from "./choice-controls.js";
import { ThemedSelect } from "./select.js";
import { ThemedCombobox } from "./combobox.js";
import { Check, Minus, ChevronDown } from "./control-icons.js";
import {
  ComponentTheme,
  createAppearanceResolver,
  resolvePartAppearances,
  themeContainer,
  themePart,
} from "./component-theme.js";
import { useGraphicalTheme } from "./graphical-provider.js";
import * as Library from "./primitives.js";

export { GraphicalProvider, useGraphicalTheme } from "./graphical-provider.js";
export { ThemedButtonContent as ButtonContent } from "./button-content.js";
export { ThemedAnimatedValue as AnimatedValue } from "./animated-value.js";
export { ThemedIcon, IconRendererProvider } from "./icon.js";
export type { ThemeIconName, ThemeIconRenderProps } from "./icon.js";
export { createHugeiconsRenderer } from "./hugeicons-renderer.js";
export type {
  ThemeDocument,
  ColorMode,
  ButtonVariant,
} from "../../lib/theme-model.js";

function useThemeVariables() {
  const { document, colorMode } = useGraphicalTheme();
  return useMemo(
    () => previewCssVariables(document.theme, colorMode),
    [document.theme, colorMode],
  );
}

/** Compound controls share the catalog's group-specific part overrides. */
function FamilyTheme({
  component,
  member,
  children,
}: {
  component: ComponentId;
  member: ComponentId;
  children: ReactNode;
}) {
  const { document, colorMode } = useGraphicalTheme();
  const variables = useThemeVariables();
  const appearances = useMemo(
    () => resolvePartAppearances(document, colorMode, component),
    [document, colorMode, component],
  );
  const resolve = useMemo(
    () => createAppearanceResolver(document, colorMode),
    [document, colorMode],
  );
  return (
    <ComponentTheme
      component={member}
      appearances={appearances}
      variables={variables}
      resolveComponent={resolve}
    >
      {children}
    </ComponentTheme>
  );
}

export function Button({
  variant = 'primary',
  ...props
}: ComponentProps<typeof BaseButton> & { variant?: ButtonVariant }) {
  const { document, colorMode } = useGraphicalTheme();
  const appearances = useMemo(
    () => ({
      rest: resolveButtonPartStyle(document, colorMode, 'rest', variant),
      hover: resolveButtonPartStyle(document, colorMode, 'hover', variant),
      focus: resolveButtonPartStyle(document, colorMode, 'focus', variant),
      disabled: resolveButtonPartStyle(
        document,
        colorMode,
        'disabled',
        variant,
      ),
    }),
    [document, colorMode, variant],
  );
  return <ThemedButton {...props} appearances={appearances} />;
}

// Button already merges the label part into every variant and state.
export function ButtonLabel(props: ComponentProps<'span'>) {
  return <span {...props} />;
}

export function Input(
  props: Omit<ComponentProps<typeof ThemedInput>, 'appearances'>,
) {
  const { document, colorMode } = useGraphicalTheme();
  return (
    <ThemedInput
      {...props}
      appearances={controlAppearances(document, colorMode, 'input')}
    />
  );
}
export const InputLabel = themePart('label', 'input', 'label');

const InCheckboxGroup = createContext(false);
function CheckboxRoot(props: ComponentProps<typeof BaseCheckbox.Root>) {
  const grouped = useContext(InCheckboxGroup);
  const { document, colorMode } = useGraphicalTheme();
  if (grouped) {
    return (
      <Library.ThemedCheckbox.Root {...props}>
        {props.children === undefined ? <CheckboxIndicator /> : props.children}
      </Library.ThemedCheckbox.Root>
    );
  }
  return (
    <CheckboxControl
      {...props}
      appearance={choiceAppearance(document, colorMode, 'checkbox')}
      indicatorStyle={(state) =>
        choiceMarkStyle(document, colorMode, 'checkbox', choiceState(state))
      }
    />
  );
}
function CheckboxIndicator({
  style,
  children,
  render,
  ...props
}: ComponentProps<typeof BaseCheckbox.Indicator>) {
  const grouped = useContext(InCheckboxGroup);
  const { document, colorMode } = useGraphicalTheme();
  if (grouped) {
    return (
      <Library.ThemedCheckbox.Indicator
        {...props}
        style={style}
        render={render}
      >
        {children === undefined ? (
          <>
            <Check className="ui-check" />
            <Minus className="ui-mixed" />
          </>
        ) : (
          children
        )}
      </Library.ThemedCheckbox.Indicator>
    );
  }
  return (
    <BaseCheckbox.Indicator
      keepMounted
      data-slot="checkbox-indicator"
      {...props}
      style={(state) => ({
        ...choiceMarkStyle(document, colorMode, 'checkbox', choiceState(state)),
        ...(typeof style === 'function' ? style(state) : style),
      })}
      render={
        render ??
        ((indicatorProps, state) => (
          <span {...indicatorProps}>
            {children === undefined ? (
              state.indeterminate ? (
                <Minus aria-hidden="true" />
              ) : (
                <Check aria-hidden="true" />
              )
            ) : (
              children
            )}
          </span>
        ))
      }
    >
      {children}
    </BaseCheckbox.Indicator>
  );
}
export const Checkbox = {
  ...BaseCheckbox,
  Root: CheckboxRoot,
  Indicator: CheckboxIndicator,
  Label: themePart('span', 'checkbox', 'label'),
  Row: themeContainer('label', 'ui-choice-label graphical-choice-row'),
};

/**
 * The dashboard switch. `styles.css` gives it a fixed 36 x 20 track and a round thumb, because the
 * theme's switch size makes a 56 x 32 track that is too large for a table row.
 */
function SwitchRoot({
  className,
  children,
  ...props
}: ComponentProps<typeof BaseSwitch.Root>) {
  return (
    <BaseSwitch.Root
      data-slot="switch"
      {...props}
      className={(state) =>
        [
          'themed-switch',
          'dashboard-switch',
          typeof className === 'function' ? className(state) : className,
        ]
          .filter(Boolean)
          .join(' ')
      }
    >
      {children === undefined ? <SwitchThumb /> : children}
    </BaseSwitch.Root>
  );
}
function SwitchThumb({
  className,
  ...props
}: ComponentProps<typeof BaseSwitch.Thumb>) {
  return (
    <BaseSwitch.Thumb
      {...props}
      className={(state) =>
        [
          'themed-switch-thumb',
          typeof className === 'function' ? className(state) : className,
        ]
          .filter(Boolean)
          .join(' ')
      }
    />
  );
}
export const Switch = {
  ...BaseSwitch,
  Root: SwitchRoot,
  Thumb: SwitchThumb,
  Row: themePart(
    'label',
    'switch',
    'row',
    'ui-choice-row graphical-choice-row',
  ),
  Label: themePart('span', 'switch', 'label'),
};

function useSelectAppearances() {
  const { document, colorMode } = useGraphicalTheme();
  return selectAppearances(document, colorMode, useThemeVariables());
}
function SelectTrigger({
  className,
  style,
  onPointerEnter,
  onPointerLeave,
  onFocus,
  onBlur,
  ...props
}: ComponentProps<typeof BaseSelect.Trigger>) {
  const appearances = useSelectAppearances();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  return (
    <BaseSelect.Trigger
      data-slot="select-trigger"
      {...props}
      className={(state) =>
        [
          'themed-select',
          typeof className === 'function' ? className(state) : className,
        ]
          .filter(Boolean)
          .join(' ')
      }
      style={(state) => ({
        ...appearances.triggerStyle({ ...state, hovered, focused }),
        ...(typeof style === 'function' ? style(state) : style),
      })}
      onPointerEnter={(event) => {
        setHovered(true);
        onPointerEnter?.(event);
      }}
      onPointerLeave={(event) => {
        setHovered(false);
        onPointerLeave?.(event);
      }}
      onFocus={(event) => {
        setFocused(true);
        onFocus?.(event);
      }}
      onBlur={(event) => {
        setFocused(false);
        onBlur?.(event);
      }}
    />
  );
}
function SelectPopup({
  className,
  style,
  ...props
}: ComponentProps<typeof BaseSelect.Popup>) {
  const appearances = useSelectAppearances();
  return (
    <BaseSelect.Popup
      {...props}
      className={(state) =>
        [
          'themed-select-popup',
          typeof className === 'function' ? className(state) : className,
        ]
          .filter(Boolean)
          .join(' ')
      }
      style={(state) => ({
        ...appearances.popupStyle,
        ...(typeof style === 'function' ? style(state) : style),
      })}
    />
  );
}
function SelectItem({
  className,
  style,
  ...props
}: ComponentProps<typeof BaseSelect.Item>) {
  const appearances = useSelectAppearances();
  return (
    <BaseSelect.Item
      {...props}
      className={(state) =>
        [
          'themed-select-option',
          typeof className === 'function' ? className(state) : className,
        ]
          .filter(Boolean)
          .join(' ')
      }
      style={(state) => ({
        ...appearances.optionStyle(state),
        ...(typeof style === 'function' ? style(state) : style),
      })}
    />
  );
}
const SelectPositionerSurface = themeContainer(
  BaseSelect.Positioner,
  'themed-select-positioner',
);
function SelectPositioner(props: ComponentProps<typeof BaseSelect.Positioner>) {
  const appearances = useSelectAppearances();
  return (
    <SelectPositionerSurface
      align="start"
      alignItemWithTrigger={false}
      sideOffset={appearances.sideOffset}
      {...props}
    />
  );
}
export const Select = {
  ...BaseSelect,
  Label: themePart(BaseSelect.Label, 'select', 'label'),
  Trigger: SelectTrigger,
  Positioner: SelectPositioner,
  Popup: SelectPopup,
  Item: SelectItem,
  Icon: function SelectIcon({
    children = <ChevronDown aria-hidden="true" />,
    ...props
  }: ComponentProps<typeof BaseSelect.Icon>) {
    return <BaseSelect.Icon {...props}>{children}</BaseSelect.Icon>;
  },
  ItemIndicator: function SelectItemIndicator({
    children = <Check aria-hidden="true" />,
    ...props
  }: ComponentProps<typeof BaseSelect.ItemIndicator>) {
    return (
      <BaseSelect.ItemIndicator {...props}>{children}</BaseSelect.ItemIndicator>
    );
  },
};

/** The complete, single-selection field used by the preview. */
export function SelectField<Value extends string>(
  props: Omit<
    ComponentProps<typeof ThemedSelect<Value>>,
    'triggerStyle' | 'popupStyle' | 'labelStyle' | 'optionStyle'
  >,
) {
  return <ThemedSelect {...useSelectAppearances()} {...props} />;
}

function useComboboxAppearances(disabled = false) {
  const { document, colorMode } = useGraphicalTheme();
  const option = partCss(document, colorMode, 'combobox', 'option');
  return {
    label: partCss(
      document,
      colorMode,
      'combobox',
      'label',
      disabled ? 'disabled' : 'rest',
    ),
    input: ({ focused, hovered }: { focused: boolean; hovered: boolean }) =>
      partCss(
        document,
        colorMode,
        'combobox',
        'input',
        disabled ? 'disabled' : focused ? 'focus' : hovered ? 'hover' : 'rest',
      ),
    popover: partCss(document, colorMode, 'combobox', 'popover'),
    option: (state: BaseCombobox.Item.State) =>
      partCss(
        document,
        colorMode,
        'combobox',
        'option',
        state.disabled
          ? 'disabled'
          : state.highlighted
            ? 'highlighted'
            : state.selected
              ? 'selected'
              : 'rest',
      ),
    empty: {
      color: option.color,
      fontFamily: option.fontFamily,
      fontSize: option.fontSize,
      fontWeight: option.fontWeight,
      lineHeight: option.lineHeight,
      letterSpacing: option.letterSpacing,
    },
    sideOffset: resolveComponentPartStyle(
      document,
      colorMode,
      'combobox',
      'popover',
    ).gap,
  };
}
/** The exact preview composition, with accessible labels and the full-field popup anchor. */
export function ComboboxField({
  triggerLabel = 'Show options',
  emptyMessage = 'No options found.',
  placeholder = '',
  ...props
}: Omit<
  ComponentProps<typeof ThemedCombobox>,
  | 'styles'
  | 'themeVariables'
  | 'sideOffset'
  | 'triggerLabel'
  | 'emptyMessage'
  | 'placeholder'
> & {
  triggerLabel?: string;
  emptyMessage?: string;
  placeholder?: string;
  sideOffset?: number;
}) {
  const styles = useComboboxAppearances(props.disabled);
  return (
    <ThemedCombobox
      styles={styles}
      themeVariables={useThemeVariables()}
      sideOffset={styles.sideOffset}
      triggerLabel={triggerLabel}
      emptyMessage={emptyMessage}
      placeholder={placeholder}
      {...props}
    />
  );
}

const ComboboxFieldContext = createContext<{
  anchor: React.RefObject<HTMLDivElement | null>;
  setAnchor: (element: HTMLDivElement | null) => void;
  disabled: boolean;
} | null>(null);
function ComboboxRoot<Value, Multiple extends boolean | undefined = false>(
  props: BaseCombobox.Root.Props<Value, Multiple>,
) {
  const anchor = useRef<HTMLDivElement>(null);
  const setAnchor = useCallback((element: HTMLDivElement | null) => {
    anchor.current = element;
  }, []);
  return (
    <ComboboxFieldContext
      value={{ anchor, setAnchor, disabled: props.disabled ?? false }}
    >
      <BaseCombobox.Root {...props} />
    </ComboboxFieldContext>
  );
}
function ComboboxFieldSurface({ ref, style, ...props }: ComponentProps<'div'>) {
  const context = useContext(ComboboxFieldContext);
  const setAnchor = context?.setAnchor;
  const styles = useComboboxAppearances(context?.disabled);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const mergedRef = useMemo(
    () => (element: HTMLDivElement | null) => {
      setAnchor?.(element);
      const cleanup = typeof ref === 'function' ? ref(element) : undefined;
      if (ref && typeof ref !== 'function') ref.current = element;
      return () => {
        setAnchor?.(null);
        if (typeof cleanup === 'function') cleanup();
        else if (typeof ref === 'function') ref(null);
        else if (ref) ref.current = null;
      };
    },
    [setAnchor, ref],
  );
  return (
    <div
      ref={mergedRef}
      {...mergeProps<'div'>(
        {
          className: 'combobox-field',
          style: { ...styles.input({ focused, hovered }), ...style },
          onPointerEnter: () => setHovered(true),
          onPointerLeave: () => setHovered(false),
          onFocus: () => setFocused(true),
          onBlur: (event) => {
            if (!event.currentTarget.contains(event.relatedTarget))
              setFocused(false);
          },
        },
        props,
      )}
    />
  );
}
const ComboboxPositionerSurface = themeContainer(
  BaseCombobox.Positioner,
  'combobox-positioner',
);
function ComboboxPositioner(
  props: ComponentProps<typeof BaseCombobox.Positioner>,
) {
  const context = useContext(ComboboxFieldContext);
  const styles = useComboboxAppearances();
  return (
    <ComboboxPositionerSurface
      anchor={context?.anchor}
      sideOffset={styles.sideOffset}
      align="start"
      {...props}
    />
  );
}
function ComboboxPopup({
  className,
  style,
  ...props
}: ComponentProps<typeof BaseCombobox.Popup>) {
  const styles = useComboboxAppearances();
  const variables = useThemeVariables();
  return (
    <BaseCombobox.Popup
      {...props}
      className={(state) =>
        [
          'combobox-popover',
          typeof className === 'function' ? className(state) : className,
        ]
          .filter(Boolean)
          .join(' ')
      }
      style={(state) => ({
        ...variables,
        ...styles.popover,
        ...(typeof style === 'function' ? style(state) : style),
      })}
    />
  );
}
function ComboboxItem({
  className,
  style,
  ...props
}: ComponentProps<typeof BaseCombobox.Item>) {
  const styles = useComboboxAppearances();
  return (
    <BaseCombobox.Item
      {...props}
      className={(state) =>
        [
          'combobox-option',
          typeof className === 'function' ? className(state) : className,
        ]
          .filter(Boolean)
          .join(' ')
      }
      style={(state) => ({
        ...styles.option(state),
        ...(typeof style === 'function' ? style(state) : style),
      })}
    />
  );
}
type ComboboxLabelProps =
  | (ComponentProps<typeof BaseCombobox.Label> & { htmlFor?: never })
  | (ComponentProps<'label'> & { htmlFor: string; render?: never });

function ComboboxLabel(props: ComboboxLabelProps) {
  const context = useContext(ComboboxFieldContext);
  const { document, colorMode } = useGraphicalTheme();
  const labelStyle = (disabled: boolean) =>
    partCss(
      document,
      colorMode,
      'combobox',
      'label',
      disabled ? 'disabled' : 'rest',
    );
  // An explicit input target keeps the preview's native-label composition.
  // Base UI's Label associates automatically with a trigger-based combobox.
  if (props.htmlFor !== undefined) {
    const { style, className, htmlFor, ...labelProps } = props;
    return (
      <label
        {...labelProps}
        htmlFor={htmlFor}
        className={['combobox-label', className].filter(Boolean).join(' ')}
        style={{ ...labelStyle(context?.disabled ?? false), ...style }}
      />
    );
  }
  const { style, className, ...labelProps } = props;
  return (
    <BaseCombobox.Label
      {...labelProps}
      className={(state) =>
        [
          'combobox-label',
          typeof className === 'function' ? className(state) : className,
        ]
          .filter(Boolean)
          .join(' ')
      }
      style={(state) => ({
        ...labelStyle(!!context?.disabled || state.disabled),
        ...(typeof style === 'function' ? style(state) : style),
      })}
    />
  );
}
function ComboboxEmpty({
  style,
  className,
  ...props
}: ComponentProps<typeof BaseCombobox.Empty>) {
  const styles = useComboboxAppearances();
  return (
    <BaseCombobox.Empty
      {...props}
      className={(state) =>
        [
          'combobox-empty',
          typeof className === 'function' ? className(state) : className,
        ]
          .filter(Boolean)
          .join(' ')
      }
      style={(state) => ({
        ...styles.empty,
        ...(typeof style === 'function' ? style(state) : style),
      })}
    />
  );
}
export const Combobox = {
  ...BaseCombobox,
  Root: ComboboxRoot,
  Label: ComboboxLabel,
  Field: ComboboxFieldSurface,
  Input: themeContainer(BaseCombobox.Input, 'combobox-input'),
  Trigger: themeContainer(BaseCombobox.Trigger, 'combobox-trigger'),
  Positioner: ComboboxPositioner,
  Popup: ComboboxPopup,
  List: themeContainer(BaseCombobox.List, 'combobox-options'),
  Item: ComboboxItem,
  ItemIndicator: themeContainer(
    BaseCombobox.ItemIndicator,
    'combobox-option-check',
  ),
  Empty: ComboboxEmpty,
};

/** A namespace with extra or replaced parts. Names the type so declarations stay portable. */
type Extended<Base, Extra> = Omit<Base, keyof Extra> & Extra;

export const Accordion = {
  ...Library.ThemedAccordion,
  Content: themePart('div', 'accordion', 'content', 'ui-copy'),
};
export const AlertDialog: Extended<
  typeof Library.ThemedAlertDialog,
  { Action: typeof BaseButton }
> = {
  ...Library.ThemedAlertDialog,
  Action: themePart(BaseButton, 'alert-dialog', 'action', 'ui-button'),
};
export const Autocomplete = {
  ...Library.ThemedAutocomplete,
  Label: themePart('label', 'autocomplete', 'label', 'ui-label'),
};
export const Avatar = {
  ...Library.ThemedAvatar,
  Image: themeContainer(Library.ThemedAvatar.Image, 'ui-avatar-image'),
};
export const Collapsible = {
  ...Library.ThemedCollapsible,
  Content: themePart('div', 'collapsible', 'content', 'ui-copy'),
};
export const ContextMenu = {
  ...Library.ThemedContextMenu,
  Positioner: themeContainer(
    Library.ThemedContextMenu.Positioner,
    'ui-positioner',
  ),
  GroupLabel: themePart(
    Library.ThemedContextMenu.GroupLabel,
    'context-menu',
    'label',
    'ui-menu-group-label',
  ),
  RadioItem: themePart(
    Library.ThemedContextMenu.RadioItem,
    'context-menu',
    'option',
    'ui-option',
  ),
  RadioItemIndicator: themePart(
    Library.ThemedContextMenu.RadioItemIndicator,
    'context-menu',
    'indicator',
    'ui-mark',
  ),
  SubmenuTrigger: themePart(
    Library.ThemedContextMenu.SubmenuTrigger,
    'context-menu',
    'option',
    'ui-option',
  ),
};
export const Dialog: Extended<
  typeof Library.ThemedDialog,
  { Action: typeof BaseButton }
> = {
  ...Library.ThemedDialog,
  Action: themePart(BaseButton, 'dialog', 'action', 'ui-button'),
};
export const Drawer: Extended<
  typeof Library.ThemedDrawer,
  { Action: typeof BaseButton }
> = {
  ...Library.ThemedDrawer,
  Viewport: themeContainer(Library.ThemedDrawer.Viewport, 'ui-drawer-viewport'),
  Content: themeContainer(Library.ThemedDrawer.Content, 'ui-drawer-content'),
  Action: themePart(BaseButton, 'drawer', 'action', 'ui-button'),
};
export const Field = Library.ThemedField;
export const Fieldset = {
  ...Library.ThemedFieldset,
  Content: themePart('div', 'fieldset', 'content', 'ui-stack'),
  Label: themePart(Library.ThemedField.Label, 'fieldset', 'label', 'ui-label'),
  Control: themePart(
    Library.ThemedField.Control,
    'fieldset',
    'input',
    'ui-input',
  ),
  Description: themePart(
    Library.ThemedField.Description,
    'fieldset',
    'description',
    'ui-copy',
  ),
  Error: themePart(Library.ThemedField.Error, 'fieldset', 'error', 'ui-copy'),
};
export const Form = Object.assign(Library.ThemedForm, {
  Content: themePart('div', 'form', 'content', 'ui-stack'),
  Label: themePart(Library.ThemedField.Label, 'form', 'label', 'ui-label'),
  Control: themePart(Library.ThemedField.Control, 'form', 'input', 'ui-input'),
  Description: themePart(
    Library.ThemedField.Description,
    'form',
    'description',
    'ui-copy',
  ),
  Error: themePart(Library.ThemedField.Error, 'form', 'error', 'ui-copy'),
  Action: themePart(BaseButton, 'form', 'action', 'ui-button'),
});
export const Menu: typeof Library.ThemedMenu = Library.ThemedMenu;
function MenubarRoot({
  children,
  ...props
}: ComponentProps<typeof Library.ThemedMenubar>) {
  return (
    <FamilyTheme component="menubar" member="menu">
      <Library.ThemedMenubar {...props}>{children}</Library.ThemedMenubar>
    </FamilyTheme>
  );
}
export const Menubar = Object.assign(MenubarRoot, {
  Trigger: Library.ThemedMenubarTrigger,
});
export const Meter = {
  ...Library.ThemedMeter,
  Root: themeContainer(Library.ThemedMeter.Root, 'ui-range'),
  Heading: themeContainer('div', 'ui-range-heading'),
};
export const NavigationMenu = {
  ...Library.ThemedNavigationMenu,
  Positioner: themeContainer(
    Library.ThemedNavigationMenu.Positioner,
    'ui-positioner',
  ),
};
export const NumberField = {
  ...Library.ThemedNumberField,
  Root: themeContainer(Library.ThemedNumberField.Root, 'ui-stack'),
  Group: themeContainer(Library.ThemedNumberField.Group, 'ui-row'),
  Label: Library.ThemedNumberLabel,
};
export const OTPField = {
  ...Library.ThemedOTPField,
  Root: themeContainer(Library.ThemedOTPField.Root, 'ui-row'),
  Label: themePart('label', 'otp-field', 'label'),
};
export const Popover: Extended<
  typeof Library.ThemedPopover,
  { Action: typeof BaseButton }
> = {
  ...Library.ThemedPopover,
  Positioner: themeContainer(Library.ThemedPopover.Positioner, 'ui-positioner'),
  Action: themePart(BaseButton, 'popover', 'action', 'ui-button'),
};
export const PreviewCard: Extended<
  typeof Library.ThemedPreviewCard,
  { Title: 'div'; Description: 'div' }
> = {
  ...Library.ThemedPreviewCard,
  Positioner: themeContainer(
    Library.ThemedPreviewCard.Positioner,
    'ui-positioner',
  ),
  Title: themePart('div', 'preview-card', 'title', 'ui-title'),
  Description: themePart('div', 'preview-card', 'description', 'ui-copy'),
};
export const Progress = {
  ...Library.ThemedProgress,
  Root: themeContainer(Library.ThemedProgress.Root, 'ui-range'),
  Heading: themeContainer('div', 'ui-range-heading'),
};
export const Radio = {
  ...Library.ThemedRadio,
  Row: themeContainer('label', 'ui-choice-label'),
  Label: themePart('span', 'radio', 'label'),
};
function RadioGroupRoot({
  children,
  ...props
}: ComponentProps<typeof Library.ThemedRadioGroup>) {
  return (
    <FamilyTheme component="radio-group" member="radio">
      <Library.ThemedRadioGroup {...props}>{children}</Library.ThemedRadioGroup>
    </FamilyTheme>
  );
}
export const RadioGroup = Object.assign(RadioGroupRoot, {
  Row: Library.ThemedRadioRow,
  Label: Library.ThemedRadioLabel,
});
function CheckboxGroupRoot({
  children,
  ...props
}: ComponentProps<typeof Library.ThemedCheckboxGroup>) {
  return (
    <InCheckboxGroup value={true}>
      <FamilyTheme component="checkbox-group" member="checkbox">
        <Library.ThemedCheckboxGroup {...props}>
          {children}
        </Library.ThemedCheckboxGroup>
      </FamilyTheme>
    </InCheckboxGroup>
  );
}
export const CheckboxGroup = Object.assign(CheckboxGroupRoot, {
  Row: Library.ThemedCheckboxRow,
  Label: themePart('span', 'checkbox-group', 'label'),
});
export const ScrollArea = {
  ...Library.ThemedScrollArea,
  Viewport: themeContainer(
    Library.ThemedScrollArea.Viewport,
    'ui-scroll-viewport',
  ),
  Content: themePart(
    Library.ThemedScrollArea.Content,
    'scroll-area',
    'content',
    'ui-scroll-content',
  ),
};
export const Separator = Library.ThemedSeparator;
export const Slider = {
  ...Library.ThemedSlider,
  Root: themeContainer(Library.ThemedSlider.Root, 'ui-range'),
  Control: themeContainer(Library.ThemedSlider.Control, 'ui-range-control'),
  Heading: themeContainer('div', 'ui-range-heading'),
};
export const Tabs = {
  ...Library.ThemedTabs,
  Content: themePart('div', 'tabs', 'content', 'ui-copy'),
};
export const Toast = {
  ...Library.ThemedToast,
  Trigger: themePart(BaseButton, 'toast', 'trigger', 'ui-button'),
};
export const Toggle = Object.assign(Library.ThemedToggle, {
  Label: themePart('span', 'toggle', 'label'),
});
function ToggleGroupRoot({
  children,
  ...props
}: ComponentProps<typeof Library.ThemedToggleGroup>) {
  return (
    <FamilyTheme component="toggle-group" member="toggle">
      <Library.ThemedToggleGroup {...props}>
        {children}
      </Library.ThemedToggleGroup>
    </FamilyTheme>
  );
}
export const ToggleGroup = Object.assign(ToggleGroupRoot, {
  Label: Library.ThemedToggleLabel,
});
export const Toolbar = {
  ...Library.ThemedToolbar,
  Label: themePart('span', 'toolbar', 'label'),
};
export const Tooltip: typeof Library.ThemedTooltip = {
  ...Library.ThemedTooltip,
  Positioner: themeContainer(Library.ThemedTooltip.Positioner, 'ui-positioner'),
};
