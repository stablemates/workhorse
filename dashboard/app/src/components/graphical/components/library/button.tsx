'use client';

import { useState, type ComponentProps } from 'react';
import { Button } from '@base-ui/react/button';
import { componentCssStyle, type ComponentStyle } from "../../lib/theme-model.js";

export function ThemedButton({
  appearances,
  className,
  style,
  onPointerEnter,
  onPointerLeave,
  onFocus,
  onBlur,
  ...props
}: ComponentProps<typeof Button> & {
  appearances: Record<'rest' | 'hover' | 'focus' | 'disabled', ComponentStyle>;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  return (
    <Button
      {...props}
      className={(state) =>
        [
          'themed-button',
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
