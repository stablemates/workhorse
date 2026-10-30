'use client';

import {
  useId,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type ComponentProps,
} from 'react';
import { Combobox } from '@base-ui/react/combobox';
import { mergeProps } from '@base-ui/react/merge-props';
import { Check, ChevronDown } from "./control-icons.js";
import { IconTheme } from "./icon.js";

type ElementProps = HTMLAttributes<HTMLElement> & {
  [key: `data-${string}`]: unknown;
};

/** The reusable field accepts resolved styles; it knows nothing about the editor. */
export function ThemedCombobox({
  label,
  placeholder,
  triggerLabel,
  emptyMessage,
  sideOffset,
  styles,
  themeVariables,
  labelProps,
  fieldProps,
  inputProps,
  popupProps,
  getOptionProps,
  ...props
}: Omit<Combobox.Root.Props<string>, 'children'> & {
  label: string;
  placeholder: string;
  triggerLabel: string;
  emptyMessage: string;
  sideOffset: number;
  themeVariables: CSSProperties;
  styles: {
    label: CSSProperties;
    input: (state: { focused: boolean; hovered: boolean }) => CSSProperties;
    popover: CSSProperties;
    option: (state: Combobox.Item.State, index: number) => CSSProperties;
    empty: CSSProperties;
  };
  labelProps?: ElementProps;
  fieldProps?: ElementProps;
  inputProps?: ComponentProps<typeof Combobox.Input>;
  popupProps?: Combobox.Popup.Props;
  getOptionProps?: (index: number) => Combobox.Item.Props;
}) {
  const generatedId = useId();
  const id = inputProps?.id ?? generatedId;
  const anchor = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);

  return (
    <IconTheme variables={themeVariables}>
      <div className="combobox-specimen" style={{ gap: 'var(--space-xs)' }}>
        <Combobox.Root {...props}>
          <label
            className="combobox-label"
            htmlFor={id}
            style={styles.label}
            {...labelProps}
          >
            {label}
          </label>
          <div
            ref={anchor}
            {...mergeProps<'div'>(
              {
                className: 'combobox-field',
                style: styles.input({ focused, hovered }),
                onPointerEnter: () => setHovered(true),
                onPointerLeave: () => setHovered(false),
              },
              fieldProps,
            )}
          >
            <Combobox.Input
              id={id}
              placeholder={placeholder}
              {...inputProps}
              className={(state) =>
                [
                  'combobox-input',
                  typeof inputProps?.className === 'function'
                    ? inputProps.className(state)
                    : inputProps?.className,
                ]
                  .filter(Boolean)
                  .join(' ')
              }
              onFocus={(event) => {
                setFocused(true);
                inputProps?.onFocus?.(event);
              }}
              onBlur={(event) => {
                setFocused(false);
                inputProps?.onBlur?.(event);
              }}
            />
            <Combobox.Trigger
              className="combobox-trigger"
              aria-label={triggerLabel}
            >
              <ChevronDown aria-hidden="true" />
            </Combobox.Trigger>
          </div>
          <Combobox.Portal>
            <Combobox.Positioner
              anchor={anchor}
              sideOffset={sideOffset}
              align="start"
              className="combobox-positioner"
              style={themeVariables}
            >
              <Combobox.Popup
                className="combobox-popover"
                style={styles.popover}
                {...popupProps}
              >
                <Combobox.Empty className="combobox-empty" style={styles.empty}>
                  {emptyMessage}
                </Combobox.Empty>
                <Combobox.List className="combobox-options">
                  {(item: string, index: number) => (
                    <Combobox.Item
                      key={item}
                      value={item}
                      index={index}
                      className="combobox-option"
                      style={(state) => styles.option(state, index)}
                      {...getOptionProps?.(index)}
                    >
                      <span>{item}</span>
                      <Combobox.ItemIndicator className="combobox-option-check">
                        <Check aria-hidden="true" />
                      </Combobox.ItemIndicator>
                    </Combobox.Item>
                  )}
                </Combobox.List>
              </Combobox.Popup>
            </Combobox.Positioner>
          </Combobox.Portal>
        </Combobox.Root>
      </div>
    </IconTheme>
  );
}
