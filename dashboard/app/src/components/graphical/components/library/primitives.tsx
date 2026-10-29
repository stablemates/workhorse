'use client';
import type { ComponentProps, CSSProperties } from 'react';
import { componentBoxShadow } from "../../lib/theme-model.js";
import {
  themeContainer,
  themePart,
  usePartAppearance,
  usePartStyle,
} from "./component-theme.js";
import { MenuItemContent } from "./menu-item-content.js";
import { Accordion as BaseAccordion } from '@base-ui/react/accordion';
import { AlertDialog as BaseAlertDialog } from '@base-ui/react/alert-dialog';
import { Autocomplete as BaseAutocomplete } from '@base-ui/react/autocomplete';
import { Avatar as BaseAvatar } from '@base-ui/react/avatar';
import { Collapsible as BaseCollapsible } from '@base-ui/react/collapsible';
import { ContextMenu as BaseContextMenu } from '@base-ui/react/context-menu';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { Drawer as BaseDrawer } from '@base-ui/react/drawer';
import { Field as BaseField } from '@base-ui/react/field';
import { Fieldset as BaseFieldset } from '@base-ui/react/fieldset';
import { Menu as BaseMenu } from '@base-ui/react/menu';
import { Meter as BaseMeter } from '@base-ui/react/meter';
import { NavigationMenu as BaseNavigationMenu } from '@base-ui/react/navigation-menu';
import { NumberField as BaseNumberField } from '@base-ui/react/number-field';
import {
  AnimatedNumberInput,
  AnimatedNumberIncrement,
  AnimatedNumberDecrement,
  NumberFieldGroup,
} from "./number-field.js";
import { OTPField as BaseOTPField } from '@base-ui/react/otp-field';
import { Popover as BasePopover } from '@base-ui/react/popover';
import { PreviewCard as BasePreviewCard } from '@base-ui/react/preview-card';
import { Progress as BaseProgress } from '@base-ui/react/progress';
import { Radio as BaseRadio } from '@base-ui/react/radio';
import { Checkbox as BaseCheckbox } from '@base-ui/react/checkbox';
import { ScrollArea as BaseScrollArea } from '@base-ui/react/scroll-area';
import { Slider as BaseSlider } from '@base-ui/react/slider';
import {
  InsetSliderRoot,
  InsetSliderControl,
  InsetSliderThumb,
  InsetSliderIndicator,
} from "./slider.js";
import { Tabs as BaseTabs } from '@base-ui/react/tabs';
import { SlidingTab, SlidingTabsList } from "./tabs.js";
import { Toast as BaseToast } from '@base-ui/react/toast';
import { Toolbar as BaseToolbar } from '@base-ui/react/toolbar';
import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip';
import { CheckboxGroup as BaseCheckboxGroup } from '@base-ui/react/checkbox-group';
import { Form as BaseForm } from '@base-ui/react/form';
import { Menubar as BaseMenubar } from '@base-ui/react/menubar';
import { RadioGroup as BaseRadioGroup } from '@base-ui/react/radio-group';
import { Separator as BaseSeparator } from '@base-ui/react/separator';
import { Toggle as BaseToggle } from '@base-ui/react/toggle';
import { ToggleGroup as BaseToggleGroup } from '@base-ui/react/toggle-group';

function AccordionItem({
  className,
  style,
  ...props
}: ComponentProps<typeof BaseAccordion.Item>) {
  const themeStyle = usePartStyle('accordion', 'panel');
  const panel = usePartAppearance('accordion', 'panel');
  return (
    <BaseAccordion.Item
      {...props}
      data-panel-border-authored={panel?.borderAuthored || undefined}
      className={(state) =>
        [
          'ui-accordion-item',
          typeof className === 'function' ? className(state) : className,
        ]
          .filter(Boolean)
          .join(' ')
      }
      style={(state) => ({
        ...themeStyle,
        ...(typeof style === 'function' ? style(state) : style),
      })}
    />
  );
}

const AccordionPanelSurface = themePart(
  BaseAccordion.Panel,
  'accordion',
  'panel',
  'ui-disclosure-panel ui-accordion-panel',
);

function AccordionPanel({
  children,
  ...props
}: ComponentProps<typeof BaseAccordion.Panel>) {
  const panel = usePartAppearance('accordion', 'panel');
  return (
    <AccordionPanelSurface
      {...props}
      data-border-authored={panel?.borderAuthored || undefined}
    >
      <div className="ui-accordion-content-clip">
        <div className="ui-disclosure-content">{children}</div>
      </div>
    </AccordionPanelSurface>
  );
}

export const ThemedAccordion = {
  ...BaseAccordion,
  Item: AccordionItem,
  Trigger: themePart(
    BaseAccordion.Trigger,
    'accordion',
    'trigger',
    'ui-button ui-spread ui-accordion-trigger',
  ),
  Indicator: themePart(
    'span',
    'accordion',
    'indicator',
    'ui-accordion-indicator',
  ),
  Panel: AccordionPanel,
};
export const ThemedAlertDialog = {
  ...BaseAlertDialog,
  Trigger: themePart(
    BaseAlertDialog.Trigger,
    'alert-dialog',
    'trigger',
    'ui-button',
  ),
  Popup: themePart(
    BaseAlertDialog.Popup,
    'alert-dialog',
    'popover',
    'ui-popup ui-modal',
  ),
  Backdrop: themePart(
    BaseAlertDialog.Backdrop,
    'alert-dialog',
    'backdrop',
    'ui-backdrop',
  ),
  Title: themePart(BaseAlertDialog.Title, 'alert-dialog', 'title', 'ui-title'),
  Description: themePart(
    BaseAlertDialog.Description,
    'alert-dialog',
    'description',
    'ui-copy',
  ),
  Close: themePart(BaseAlertDialog.Close, 'alert-dialog', 'close', 'ui-button'),
};
const AutocompletePositionerSurface = themeContainer(
  BaseAutocomplete.Positioner,
  'ui-positioner',
);

function AutocompletePositioner(
  props: ComponentProps<typeof BaseAutocomplete.Positioner>,
) {
  return <AutocompletePositionerSurface align="start" {...props} />;
}

const AutocompleteEmptyContent = themePart(
  'div',
  'autocomplete',
  'content',
  'ui-copy',
);

function AutocompleteEmpty({
  children,
  ...props
}: ComponentProps<typeof BaseAutocomplete.Empty>) {
  // Keep the live region mounted; only its conditional content needs padding.
  return (
    <BaseAutocomplete.Empty {...props}>
      <AutocompleteEmptyContent>{children}</AutocompleteEmptyContent>
    </BaseAutocomplete.Empty>
  );
}

export const ThemedAutocomplete = {
  ...BaseAutocomplete,
  Input: themePart(BaseAutocomplete.Input, 'autocomplete', 'input', 'ui-input'),
  Positioner: AutocompletePositioner,
  Popup: themePart(
    BaseAutocomplete.Popup,
    'autocomplete',
    'popover',
    'ui-popup ui-menu',
  ),
  Item: themePart(BaseAutocomplete.Item, 'autocomplete', 'option', 'ui-option'),
  Empty: AutocompleteEmpty,
};
const AvatarSurface = themePart(
  BaseAvatar.Root,
  'avatar',
  'control',
  'ui-avatar',
);
function AvatarRoot({
  style,
  ...props
}: ComponentProps<typeof BaseAvatar.Root>) {
  const appearance = usePartAppearance('avatar', 'control');
  const border = appearance?.borderInset;
  const edge = {
    '--avatar-surface-shadow': appearance
      ? border
        ? appearance.shadow
        : componentBoxShadow(appearance)
      : 'none',
    '--avatar-inset-border':
      appearance && border
        ? componentBoxShadow({ ...appearance, shadow: 'none' })
        : 'none',
  } as CSSProperties;
  return (
    <AvatarSurface
      {...props}
      style={(state) => ({
        ...edge,
        ...(typeof style === 'function' ? style(state) : style),
      })}
    />
  );
}
export const ThemedAvatar = {
  ...BaseAvatar,
  Root: AvatarRoot,
  Fallback: themePart(
    BaseAvatar.Fallback,
    'avatar',
    'fallback',
    'ui-avatar-fallback',
  ),
};
const CollapsiblePanelSurface = themePart(
  BaseCollapsible.Panel,
  'collapsible',
  'panel',
  'ui-disclosure-panel',
);

function CollapsiblePanel({
  children,
  ...props
}: ComponentProps<typeof BaseCollapsible.Panel>) {
  return (
    <CollapsiblePanelSurface {...props}>
      <div className="ui-disclosure-content">{children}</div>
    </CollapsiblePanelSurface>
  );
}

export const ThemedCollapsible = {
  ...BaseCollapsible,
  Root: themePart(
    BaseCollapsible.Root,
    'collapsible',
    'group',
    'ui-stack ui-collapsible',
  ),
  Trigger: themePart(
    BaseCollapsible.Trigger,
    'collapsible',
    'trigger',
    'ui-button ui-spread',
  ),
  Indicator: themePart(
    'span',
    'collapsible',
    'indicator',
    'ui-collapsible-indicator',
  ),
  Panel: CollapsiblePanel,
};
export const ThemedContextMenu = {
  ...BaseContextMenu,
  Trigger: themePart(
    BaseContextMenu.Trigger,
    'context-menu',
    'trigger',
    'ui-context-trigger',
  ),
  Popup: themePart(
    BaseContextMenu.Popup,
    'context-menu',
    'popover',
    'ui-popup ui-menu',
  ),
  Item: themePart(BaseContextMenu.Item, 'context-menu', 'option', 'ui-option'),
  CheckboxItem: themePart(
    BaseContextMenu.CheckboxItem,
    'context-menu',
    'option',
    'ui-option',
  ),
  CheckboxItemIndicator: themePart(
    BaseContextMenu.CheckboxItemIndicator,
    'context-menu',
    'indicator',
    'ui-mark',
  ),
  Separator: themePart(
    BaseContextMenu.Separator,
    'context-menu',
    'separator',
    'ui-separator',
  ),
};
export const ThemedDialog = {
  ...BaseDialog,
  Trigger: themePart(BaseDialog.Trigger, 'dialog', 'trigger', 'ui-button'),
  Popup: themePart(BaseDialog.Popup, 'dialog', 'popover', 'ui-popup ui-modal'),
  Backdrop: themePart(BaseDialog.Backdrop, 'dialog', 'backdrop', 'ui-backdrop'),
  Title: themePart(BaseDialog.Title, 'dialog', 'title', 'ui-title'),
  Description: themePart(
    BaseDialog.Description,
    'dialog',
    'description',
    'ui-copy',
  ),
  Close: themePart(BaseDialog.Close, 'dialog', 'close', 'ui-button'),
};
export const ThemedDrawer = {
  ...BaseDrawer,
  Trigger: themePart(BaseDrawer.Trigger, 'drawer', 'trigger', 'ui-button'),
  Popup: themePart(BaseDrawer.Popup, 'drawer', 'popover', 'ui-popup ui-drawer'),
  Backdrop: themePart(BaseDrawer.Backdrop, 'drawer', 'backdrop', 'ui-backdrop'),
  Title: themePart(BaseDrawer.Title, 'drawer', 'title', 'ui-title'),
  Description: themePart(
    BaseDrawer.Description,
    'drawer',
    'description',
    'ui-copy',
  ),
  Close: themePart(BaseDrawer.Close, 'drawer', 'close', 'ui-button'),
};
export const ThemedField = {
  ...BaseField,
  Root: themePart(BaseField.Root, 'field', 'group', 'ui-stack'),
  Label: themePart(BaseField.Label, 'field', 'label', 'ui-label'),
  Control: themePart(BaseField.Control, 'field', 'input', 'ui-input'),
  Description: themePart(
    BaseField.Description,
    'field',
    'description',
    'ui-copy',
  ),
  Error: themePart(BaseField.Error, 'field', 'error', 'ui-copy'),
};
export const ThemedFieldset = {
  ...BaseFieldset,
  Root: themePart(BaseFieldset.Root, 'fieldset', 'group', 'ui-stack'),
  Legend: themePart(BaseFieldset.Legend, 'fieldset', 'legend', 'ui-title'),
};
export const ThemedMenu = {
  ...BaseMenu,
  Trigger: themePart(BaseMenu.Trigger, 'menu', 'trigger', 'ui-button'),
  Positioner: themeContainer(BaseMenu.Positioner, 'ui-positioner'),
  Popup: themePart(
    BaseMenu.Popup,
    'menu',
    'popover',
    'ui-popup ui-menu ui-menu-detailed',
  ),
  ItemContent: MenuItemContent,
  Item: themePart(BaseMenu.Item, 'menu', 'option', 'ui-option'),
  SubmenuTrigger: themePart(
    BaseMenu.SubmenuTrigger,
    'menu',
    'option',
    'ui-option',
  ),
  GroupLabel: themePart(
    BaseMenu.GroupLabel,
    'menu',
    'label',
    'ui-menu-group-label',
  ),
  CheckboxItem: themePart(BaseMenu.CheckboxItem, 'menu', 'option', 'ui-option'),
  CheckboxItemIndicator: themePart(
    BaseMenu.CheckboxItemIndicator,
    'menu',
    'indicator',
    'ui-mark',
  ),
  RadioItem: themePart(BaseMenu.RadioItem, 'menu', 'option', 'ui-option'),
  RadioItemIndicator: themePart(
    BaseMenu.RadioItemIndicator,
    'menu',
    'indicator',
    'ui-mark',
  ),
  Separator: themePart(BaseMenu.Separator, 'menu', 'separator', 'ui-separator'),
};
export const ThemedMeter = {
  ...BaseMeter,
  Label: themePart(BaseMeter.Label, 'meter', 'label', 'ui-label'),
  Value: themePart(BaseMeter.Value, 'meter', 'value', 'ui-value'),
  Track: themePart(BaseMeter.Track, 'meter', 'track', 'ui-range-track'),
  Indicator: themePart(
    BaseMeter.Indicator,
    'meter',
    'indicator',
    'ui-range-fill',
  ),
};
export const ThemedNavigationMenu = {
  ...BaseNavigationMenu,
  List: themePart(BaseNavigationMenu.List, 'navigation-menu', 'list', 'ui-row'),
  Trigger: themePart(
    BaseNavigationMenu.Trigger,
    'navigation-menu',
    'trigger',
    'ui-button',
  ),
  Link: themePart(
    BaseNavigationMenu.Link,
    'navigation-menu',
    'link',
    'ui-option ui-link',
  ),
  Popup: themePart(
    BaseNavigationMenu.Popup,
    'navigation-menu',
    'popover',
    'ui-popup ui-menu',
  ),
};
export const ThemedNumberField = {
  ...BaseNumberField,
  Group: NumberFieldGroup,
  Input: themePart(
    AnimatedNumberInput,
    'number-field',
    'input',
    'ui-input ui-number-input',
  ),
  Increment: themePart(
    AnimatedNumberIncrement,
    'number-field',
    'increment',
    'ui-button ui-number-step',
  ),
  Decrement: themePart(
    AnimatedNumberDecrement,
    'number-field',
    'decrement',
    'ui-button ui-number-step',
  ),
};
export const ThemedOTPField = {
  ...BaseOTPField,
  Input: themePart(BaseOTPField.Input, 'otp-field', 'input', 'ui-otp-input'),
  Separator: themePart(
    BaseOTPField.Separator,
    'otp-field',
    'separator',
    'ui-separator ui-otp-separator',
  ),
};
export const ThemedPopover = {
  ...BasePopover,
  Trigger: themePart(BasePopover.Trigger, 'popover', 'trigger', 'ui-button'),
  Popup: themePart(
    BasePopover.Popup,
    'popover',
    'popover',
    'ui-popup ui-popover',
  ),
  Title: themePart(BasePopover.Title, 'popover', 'title', 'ui-title'),
  Description: themePart(
    BasePopover.Description,
    'popover',
    'description',
    'ui-copy',
  ),
  Close: themePart(BasePopover.Close, 'popover', 'close', 'ui-button'),
};
export const ThemedPreviewCard = {
  ...BasePreviewCard,
  Trigger: themePart(
    BasePreviewCard.Trigger,
    'preview-card',
    'trigger',
    'ui-button ui-link',
  ),
  Popup: themePart(
    BasePreviewCard.Popup,
    'preview-card',
    'popover',
    'ui-popup ui-popover',
  ),
};
export const ThemedProgress = {
  ...BaseProgress,
  Label: themePart(BaseProgress.Label, 'progress', 'label', 'ui-label'),
  Value: themePart(BaseProgress.Value, 'progress', 'value', 'ui-value'),
  Track: themePart(BaseProgress.Track, 'progress', 'track', 'ui-range-track'),
  Indicator: themePart(
    BaseProgress.Indicator,
    'progress',
    'indicator',
    'ui-range-fill',
  ),
};
export const ThemedRadio = {
  ...BaseRadio,
  Root: themePart(BaseRadio.Root, 'radio', 'control', 'ui-choice'),
  Indicator: themePart(
    BaseRadio.Indicator,
    'radio',
    'indicator',
    'ui-radio-dot',
  ),
};
export const ThemedCheckbox = {
  ...BaseCheckbox,
  Root: themePart(BaseCheckbox.Root, 'checkbox-group', 'control', 'ui-choice'),
  Indicator: themePart(
    BaseCheckbox.Indicator,
    'checkbox-group',
    'indicator',
    'ui-checkmark',
  ),
};
export const ThemedScrollArea = {
  ...BaseScrollArea,
  Root: themePart(
    BaseScrollArea.Root,
    'scroll-area',
    'viewport',
    'ui-scroll-root',
  ),
  Scrollbar: themePart(
    BaseScrollArea.Scrollbar,
    'scroll-area',
    'scrollbar',
    'ui-scrollbar',
  ),
  Thumb: themePart(
    BaseScrollArea.Thumb,
    'scroll-area',
    'thumb',
    'ui-scroll-thumb',
  ),
};
export const ThemedSlider = {
  ...BaseSlider,
  Root: InsetSliderRoot,
  Control: InsetSliderControl,
  Label: themePart(BaseSlider.Label, 'slider', 'label', 'ui-label'),
  Value: themePart(BaseSlider.Value, 'slider', 'value', 'ui-value'),
  Track: themePart(BaseSlider.Track, 'slider', 'track', 'ui-range-track'),
  Indicator: themePart(
    InsetSliderIndicator,
    'slider',
    'indicator',
    'ui-range-fill',
  ),
  Thumb: themePart(InsetSliderThumb, 'slider', 'thumb', 'ui-range-thumb'),
};
export const ThemedTabs = {
  ...BaseTabs,
  List: themePart(SlidingTabsList, 'tabs', 'list', 'ui-row ui-tabs-list'),
  Tab: themePart(SlidingTab, 'tabs', 'trigger', 'ui-button ui-tab'),
  Panel: themePart(BaseTabs.Panel, 'tabs', 'panel', 'ui-tab-panel'),
};
export const ThemedToast = {
  ...BaseToast,
  Viewport: themeContainer(BaseToast.Viewport, 'ui-toast-viewport'),
  Content: themeContainer(BaseToast.Content, 'ui-toast-content'),
  Root: themePart(BaseToast.Root, 'toast', 'popover', 'ui-popup ui-toast'),
  Title: themePart(BaseToast.Title, 'toast', 'title', 'ui-title'),
  Description: themePart(
    BaseToast.Description,
    'toast',
    'description',
    'ui-copy',
  ),
  Action: themePart(BaseToast.Action, 'toast', 'action', 'ui-button'),
  Close: themePart(BaseToast.Close, 'toast', 'close', 'ui-button'),
};
export const ThemedToolbar = {
  ...BaseToolbar,
  Root: themePart(BaseToolbar.Root, 'toolbar', 'group', 'ui-row ui-toolbar'),
  Button: themePart(BaseToolbar.Button, 'toolbar', 'control', 'ui-button'),
  Link: themePart(BaseToolbar.Link, 'toolbar', 'control', 'ui-button'),
  Separator: themePart(
    BaseToolbar.Separator,
    'toolbar',
    'separator',
    'ui-separator ui-vertical',
  ),
};
export const ThemedTooltip = {
  ...BaseTooltip,
  Trigger: themePart(BaseTooltip.Trigger, 'tooltip', 'trigger', 'ui-button'),
  Popup: themePart(
    BaseTooltip.Popup,
    'tooltip',
    'popover',
    'ui-popup ui-tooltip',
  ),
};
export const ThemedCheckboxGroup = themePart(
  BaseCheckboxGroup,
  'checkbox-group',
  'group',
  'ui-stack',
);
export const ThemedForm = themePart(BaseForm, 'form', 'group', 'ui-stack');
export const ThemedMenubarTrigger = themePart(
  BaseMenu.Trigger,
  'menubar',
  'trigger',
  'ui-button',
);
export const ThemedMenubar = themePart(
  BaseMenubar,
  'menubar',
  'group',
  'ui-row',
);
export const ThemedRadioGroup = themePart(
  BaseRadioGroup,
  'radio-group',
  'group',
  'ui-stack',
);
export const ThemedRadioRow = themePart(
  'label',
  'radio-group',
  'row',
  'ui-choice-row',
);
export const ThemedCheckboxRow = themePart(
  'label',
  'checkbox-group',
  'row',
  'ui-choice-row',
);
export const ThemedSeparator = themePart(
  BaseSeparator,
  'separator',
  'separator',
  'ui-separator',
);
export const ThemedToggle = themePart(
  BaseToggle,
  'toggle',
  'control',
  'ui-button',
);
export const ThemedToggleGroup = themePart(
  BaseToggleGroup,
  'toggle-group',
  'group',
  'ui-row',
);

export const ThemedNumberLabel = themePart('label', 'number-field', 'label');
export const ThemedRadioLabel = themePart('span', 'radio-group', 'label');
export const ThemedToggleLabel = themePart('span', 'toggle-group', 'label');
