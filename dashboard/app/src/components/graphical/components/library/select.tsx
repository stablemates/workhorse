'use client';

import { useState, type CSSProperties } from 'react';
import { Select } from '@base-ui/react/select';
import { Check, ChevronDown } from "./control-icons.js";
import { IconTheme } from "./icon.js";

/** A single-selection field. Behavior and form participation belong to Base UI. */
export function ThemedSelect<Value extends string>({
  label,
  options,
  description,
  triggerStyle,
  popupStyle,
  labelStyle,
  optionStyle,
  popupProps,
  placeholder,
  sideOffset = 4,
  ...props
}: Omit<Select.Root.Props<Value>, 'children' | 'items'> & {
  label: string;
  options: { value: Value; label: string; disabled?: boolean }[];
  description?: string;
  triggerStyle:
    | CSSProperties
    | ((
        state: Select.Trigger.State & { hovered: boolean; focused: boolean },
      ) => CSSProperties);
  labelStyle?: CSSProperties;
  optionStyle?: Select.Item.Props['style'];
  popupProps?: Omit<Select.Popup.Props, 'children' | 'className' | 'style'>;
  placeholder?: string;
  sideOffset?: number;
  popupStyle: CSSProperties;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  return (
    <IconTheme variables={popupStyle}>
      <Select.Root {...props} items={options}>
        <Select.Label className="field-label" style={labelStyle}>
          {label}
        </Select.Label>
        <Select.Trigger
          className="themed-select"
          data-slot="select-trigger"
          style={(state) =>
            typeof triggerStyle === 'function'
              ? triggerStyle({ ...state, hovered, focused })
              : triggerStyle
          }
          onPointerEnter={() => setHovered(true)}
          onPointerLeave={() => setHovered(false)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          aria-description={description}
        >
          <Select.Value placeholder={placeholder} />
          <Select.Icon>
            <ChevronDown aria-hidden="true" />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Positioner
            sideOffset={sideOffset}
            align="start"
            alignItemWithTrigger={false}
            className="themed-select-positioner"
          >
            <Select.Popup
              {...popupProps}
              className="themed-select-popup"
              style={popupStyle}
            >
              <Select.List>
                {options.map(({ value, label: optionLabel, disabled }) => (
                  <Select.Item
                    key={value}
                    value={value}
                    disabled={disabled}
                    style={optionStyle}
                    className="themed-select-option"
                  >
                    <Select.ItemText>{optionLabel}</Select.ItemText>
                    <Select.ItemIndicator>
                      <Check aria-hidden="true" />
                    </Select.ItemIndicator>
                  </Select.Item>
                ))}
              </Select.List>
            </Select.Popup>
          </Select.Positioner>
        </Select.Portal>
        {description && <span>{description}</span>}
      </Select.Root>
    </IconTheme>
  );
}
