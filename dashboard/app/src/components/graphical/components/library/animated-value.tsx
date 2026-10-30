'use client';

import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useThemeMotion } from "./component-theme.js";

/** A changing readout follows Large motion while exposing only its current value. */
export function ThemedAnimatedValue({
  value,
  format = String,
}: {
  value: number;
  format?: (value: number) => string;
}) {
  const { disabled, transition } = useThemeMotion('large');
  const [previous, setPrevious] = useState({ value, direction: 1 });
  if (value !== previous.value)
    setPrevious({ value, direction: value > previous.value ? 1 : -1 });
  const text = format(value);
  return (
    <span className="ui-animated-value" data-value={value}>
      {disabled ? (
        text
      ) : (
        <>
          <span className="sr-only">{text}</span>
          <span className="ui-animated-value-window" aria-hidden="true">
            <AnimatePresence initial={false} custom={previous.direction}>
              <motion.span
                key={text}
                custom={previous.direction}
                variants={{
                  enter: (direction: number) => ({
                    y: `${direction * 100}%`,
                    opacity: 0,
                  }),
                  visible: { y: '0%', opacity: 1 },
                  exit: (direction: number) => ({
                    y: `${-direction * 100}%`,
                    opacity: 0,
                  }),
                }}
                initial="enter"
                animate="visible"
                exit="exit"
                transition={transition}
              >
                {text}
              </motion.span>
            </AnimatePresence>
          </span>
        </>
      )}
    </span>
  );
}
