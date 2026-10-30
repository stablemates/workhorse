'use client';

import { useState, type ComponentProps } from 'react';
import { Input } from '@base-ui/react/input';
import { componentCssStyle, type ComponentStyle } from "../../lib/theme-model.js";

export function ThemedInput({
  appearances,
  className,
  style,
  onFocus,
  onBlur,
  onPointerEnter,
  onPointerLeave,
  ...props
}: ComponentProps<typeof Input> & {
  appearances: Record<'rest' | 'hover' | 'focus' | 'disabled', ComponentStyle>;
}) {
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  return (
    <Input
      {...props}
      className={(state) =>
        [
          'themed-input',
          typeof className === 'function' ? className(state) : className,
        ]
          .filter(Boolean)
          .join(' ')
      }
      style={(state) => ({
        ...componentCssStyle(
          appearances[
            state.disabled
              ? 'disabled'
              : focused
                ? 'focus'
                : hovered
                  ? 'hover'
                  : 'rest'
          ],
        ),
        ...(typeof style === 'function' ? style(state) : style),
      })}
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
    />
  );
}
