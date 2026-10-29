'use client';

import { componentRadius } from "../../lib/component-radius.js";

import { useState, type CSSProperties } from 'react';
import { Switch } from '@base-ui/react/switch';
import { Checkbox } from '@base-ui/react/checkbox';
import { Check, Minus } from "./control-icons.js";
import {
  componentBoxShadow,
  componentEffectStyle,
  type ComponentStyle,
} from "../../lib/theme-model.js";

export type ChoiceVisualState = {
  checked: boolean;
  disabled: boolean;
  indeterminate?: boolean;
  hovered: boolean;
  focused: boolean;
};
type ChoiceAppearance =
  | ComponentStyle
  | ((state: ChoiceVisualState) => ComponentStyle);

export function ThemedCheckbox({
  appearance,
  className,
  style,
  children,
  indicatorStyle,
  onFocus,
  onBlur,
  onPointerEnter,
  onPointerLeave,
  ...props
}: React.ComponentProps<typeof Checkbox.Root> & {
  appearance: ChoiceAppearance;
  indicatorStyle?: Checkbox.Indicator.Props['style'];
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  return (
    <Checkbox.Root
      data-slot="checkbox"
      {...props}
      className={(state) =>
        [
          'themed-checkbox',
          typeof className === 'function' ? className(state) : className,
        ]
          .filter(Boolean)
          .join(' ')
      }
      onFocus={(event) => {
        setFocused(true);
        onFocus?.(event);
      }}
      onBlur={(event) => {
        setFocused(false);
        onBlur?.(event);
      }}
      onPointerEnter={(event) => {
        setHovered(true);
        onPointerEnter?.(event);
      }}
      onPointerLeave={(event) => {
        setHovered(false);
        onPointerLeave?.(event);
      }}
      style={(state) => {
        const resolved =
          typeof appearance === 'function'
            ? appearance({ ...state, hovered, focused })
            : appearance;
        const unselected =
          typeof appearance === 'function'
            ? appearance({
                ...state,
                checked: false,
                indeterminate: false,
                hovered,
                focused,
              })
            : undefined;
        // Keep the selected paint available while its layer shrinks away.
        const selected =
          typeof appearance === 'function'
            ? appearance({ ...state, checked: true, hovered, focused })
            : appearance;
        return {
          ...componentEffectStyle(resolved),
          backgroundImage: unselected?.backgroundImage,
          backgroundColor: unselected?.background,
          width: resolved.controlSize,
          height: resolved.controlSize,
          borderWidth: 0,
          borderStyle: 'none',
          borderRadius: componentRadius(resolved),
          boxShadow: resolved.borderInset
            ? resolved.shadow
            : componentBoxShadow(resolved),
          // Inset edges sit above the animated fill instead of behind it.
          '--control-inset-shadow': resolved.borderInset
            ? componentBoxShadow({ ...resolved, shadow: 'none' })
            : 'none',
          '--control-fill': selected.background,
          '--control-fill-image': selected.backgroundImage ?? 'none',
          '--control-gap': `${resolved.gap}px`,
          '--control-ink': resolved.foreground,
          '--control-icon-size': `${resolved.controlSize * 0.7}px`,
          ...(typeof style === 'function' ? style(state) : style),
        } as CSSProperties;
      }}
    >
      {children === undefined ? (
        <Checkbox.Indicator
          keepMounted
          data-slot="checkbox-indicator"
          style={indicatorStyle}
          render={(indicatorProps, state) => (
            <span {...indicatorProps}>
              {state.indeterminate ? (
                <Minus aria-hidden="true" />
              ) : (
                <Check aria-hidden="true" />
              )}
            </span>
          )}
        />
      ) : (
        children
      )}
    </Checkbox.Root>
  );
}

export function ThemedSwitch({
  appearance,
  className,
  style,
  children,
  thumbStyle,
  onFocus,
  onBlur,
  onPointerEnter,
  onPointerLeave,
  ...props
}: React.ComponentProps<typeof Switch.Root> & {
  appearance: ChoiceAppearance;
  thumbStyle?: Switch.Thumb.Props['style'];
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  return (
    <Switch.Root
      data-slot="switch"
      {...props}
      className={(state) =>
        [
          'themed-switch',
          typeof className === 'function' ? className(state) : className,
        ]
          .filter(Boolean)
          .join(' ')
      }
      onFocus={(event) => {
        setFocused(true);
        onFocus?.(event);
      }}
      onBlur={(event) => {
        setFocused(false);
        onBlur?.(event);
      }}
      onPointerEnter={(event) => {
        setHovered(true);
        onPointerEnter?.(event);
      }}
      onPointerLeave={(event) => {
        setHovered(false);
        onPointerLeave?.(event);
      }}
      style={(state) => {
        const resolved =
          typeof appearance === 'function'
            ? appearance({ ...state, hovered, focused })
            : appearance;
        const inset = resolved.controlSize / 8;
        const thumbSize = Math.max(0, resolved.controlSize - inset * 2);
        return {
          ...componentEffectStyle(resolved),
          backgroundImage: resolved.backgroundImage,
          backgroundColor:
            typeof appearance === 'function' ? resolved.background : undefined,
          width: resolved.controlSize * 1.75,
          height: resolved.controlSize,
          borderWidth: 0,
          borderStyle: 'none',
          borderRadius: componentRadius(resolved),
          boxShadow: componentBoxShadow(resolved),
          '--control-fill': resolved.background,
          '--control-gap': `${resolved.gap}px`,
          '--control-ink': resolved.foreground,
          '--switch-inset': `${inset}px`,
          '--switch-thumb-size': `${thumbSize}px`,
          '--switch-travel': `${resolved.controlSize * 0.75}px`,
          ...(typeof style === 'function' ? style(state) : style),
        } as CSSProperties;
      }}
    >
      {children === undefined ? (
        <Switch.Thumb className="themed-switch-thumb" style={thumbStyle} />
      ) : (
        children
      )}
    </Switch.Root>
  );
}
