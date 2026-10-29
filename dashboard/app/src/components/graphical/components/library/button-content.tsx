'use client';

import { LoaderCircle } from "./control-icons.js";
import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useThemeMotion } from "./component-theme.js";

/** Animated visual content; give the enclosing button an explicit accessible name. */
export function ThemedButtonContent({
  loading,
  contentKey = 'label',
  children,
}: {
  loading: boolean;
  contentKey?: string;
  children: ReactNode;
}) {
  const { disabled, transition } = useThemeMotion();
  const content = loading ? (
    <LoaderCircle className="themed-button-spinner" aria-hidden="true" />
  ) : (
    children
  );

  return (
    <span className="themed-button-content" aria-hidden="true">
      {disabled ? (
        <span className="themed-button-content-layer">{content}</span>
      ) : (
        <AnimatePresence initial={false}>
          <motion.span
            key={loading ? 'spinner' : contentKey}
            className="themed-button-content-layer"
            initial={{ opacity: 0, scale: 0.75, filter: 'blur(4px)' }}
            animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0, scale: 0.7, filter: 'blur(4px)' }}
            transition={transition}
          >
            {content}
          </motion.span>
        </AnimatePresence>
      )}
    </span>
  );
}
