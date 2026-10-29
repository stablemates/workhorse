'use client';

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithRef,
  type CSSProperties,
} from 'react';
import { Tabs } from '@base-ui/react/tabs';
import { motion } from 'motion/react';
import { THEME_STYLE_NAMES } from "../../lib/theme-style-names.js";
import { componentBoxShadow, withFocusBorder } from "../../lib/theme-model.js";
import {
  usePartAppearance,
  usePartStyle,
  useThemeMotion,
} from "./component-theme.js";

type Press = { pointerId: number; tab: HTMLElement; x: number; y: number };
const TabPressContext = createContext<{ current: Press | null } | null>(null);

function useInteractionBorderStyle(variables: CSSProperties): CSSProperties {
  const values = variables as Record<string, string | number>;
  const selected = usePartAppearance('tabs', 'trigger', 'selected');
  const hover = usePartAppearance('tabs', 'trigger', 'hover');
  const focus = usePartAppearance('tabs', 'trigger', 'focus');
  const appearances = { hover, focus };
  return Object.fromEntries(
    (['hover', 'focus'] as const).flatMap((state) => {
      const authored = Number(values[`--ui-${state}-border-authored`]);
      return [
        [
          `--tab-${state}-border-shadow`,
          authored && selected
            ? componentBoxShadow({
                ...withFocusBorder(selected, appearances[state]),
                shadow: 'none',
              })
            : 'none',
        ],
        [
          `--tab-${state}-indicator-shadow`,
          values[authored ? '--ui-selected-elevation' : '--ui-selected-shadow'],
        ],
      ];
    }),
  ) as CSSProperties;
}

function SlidingIndicator({
  indicatorProps,
  state,
  press,
}: {
  indicatorProps: Omit<
    ComponentPropsWithRef<'span'>,
    'onDrag' | 'onDragStart' | 'onDragEnd' | 'onAnimationStart'
  >;
  state: Tabs.Indicator.State;
  press: Press | null;
}) {
  const variables = usePartStyle('tabs', 'trigger');
  const borders = useInteractionBorderStyle(variables);
  const { disabled, transition } = useThemeMotion();
  const vertical = state.orientation === 'vertical';
  const stretch = press && !disabled ? 6 : 0;
  const direction = (vertical ? press?.y : press?.x) ?? 0;
  return (
    <motion.span
      {...indicatorProps}
      className="ui-tabs-indicator"
      data-anticipating={stretch > 0 || undefined}
      style={{
        ...variables,
        ...borders,
        ...indicatorProps.style,
      }}
      initial={false}
      animate={{
        left:
          (state.activeTabPosition?.left ?? 0) -
          (!vertical && direction < 0 ? stretch : 0),
        top:
          (state.activeTabPosition?.top ?? 0) -
          (vertical && direction < 0 ? stretch : 0),
        width: (state.activeTabSize?.width ?? 0) + (!vertical ? stretch : 0),
        height: (state.activeTabSize?.height ?? 0) + (vertical ? stretch : 0),
      }}
      transition={transition}
    />
  );
}

export function SlidingTabsList({
  children,
  onPointerDown,
  onClick,
  ...props
}: ComponentPropsWithRef<typeof Tabs.List>) {
  const variables = usePartStyle('tabs', 'list');
  const list = usePartAppearance('tabs', 'list');
  const underline =
    (variables as Record<string, unknown>)['--theme-name'] ===
    THEME_STYLE_NAMES.Grove;
  const pressed = useRef<Press | null>(null);
  const [press, setPress] = useState<Press | null>(null);
  useEffect(() => {
    if (!press) return;
    const view = press.tab.ownerDocument.defaultView;
    if (!view) return;
    const cancel = () => {
      pressed.current = null;
      setPress(null);
    };
    const release = (event: PointerEvent) => {
      if (event.pointerId !== press.pointerId) return;
      const bounds = press.tab.getBoundingClientRect();
      const inside =
        bounds.width && bounds.height
          ? event.clientX >= bounds.left &&
            event.clientX <= bounds.right &&
            event.clientY >= bounds.top &&
            event.clientY <= bounds.bottom
          : event.target instanceof Node && press.tab.contains(event.target);
      if (!inside) cancel();
      // Keep the stretched surface until click and Base UI selection commit
      // together, avoiding a spring back to the previous tab on pointer-up.
      else pressed.current = null;
    };
    view.addEventListener('pointerup', release);
    view.addEventListener('pointercancel', cancel);
    view.addEventListener('blur', cancel);
    return () => {
      view.removeEventListener('pointerup', release);
      view.removeEventListener('pointercancel', cancel);
      view.removeEventListener('blur', cancel);
    };
  }, [press]);
  return (
    <TabPressContext value={pressed}>
      <Tabs.List
        {...props}
        data-tab-style={underline ? 'underline' : 'surface'}
        data-border-authored={list?.borderAuthored || undefined}
        onPointerDown={(event) => {
          onPointerDown?.(event);
          if (
            event.defaultPrevented ||
            event.button !== 0 ||
            event.isPrimary === false
          )
            return;
          const listElement = event.currentTarget;
          const tab = (event.target as Element).closest<HTMLElement>(
            '[role="tab"]',
          );
          const active = listElement.querySelector<HTMLElement>(
            '[role="tab"][aria-selected="true"]',
          );
          if (
            !tab ||
            !active ||
            tab === active ||
            tab.closest('[role="tablist"]') !== listElement ||
            tab.getAttribute('aria-disabled') === 'true' ||
            tab.hasAttribute('disabled')
          )
            return;
          const target = tab.getBoundingClientRect();
          const current = active.getBoundingClientRect();
          const next = {
            pointerId: event.pointerId,
            tab,
            x: Math.sign(
              target.left + target.width / 2 - current.left - current.width / 2,
            ),
            y: Math.sign(
              target.top + target.height / 2 - current.top - current.height / 2,
            ),
          };
          pressed.current = next;
          setPress(next);
        }}
        onClick={(event) => {
          onClick?.(event);
          pressed.current = null;
          setPress(null);
        }}
      >
        {children}
        <Tabs.Indicator
          render={(indicatorProps, state) => (
            <SlidingIndicator
              key={indicatorProps.hidden ? 'hidden' : 'visible'}
              indicatorProps={indicatorProps}
              state={state}
              press={press}
            />
          )}
        />
      </Tabs.List>
    </TabPressContext>
  );
}

export function SlidingTab({
  onFocus,
  style,
  ...props
}: ComponentPropsWithRef<typeof Tabs.Tab>) {
  const pressed = useContext(TabPressContext);
  const variables = usePartStyle('tabs', 'trigger');
  const borders = useInteractionBorderStyle(variables);
  return (
    <Tabs.Tab
      {...props}
      style={(state) => ({
        ...borders,
        ...(typeof style === 'function' ? style(state) : style),
      })}
      onFocus={(event) => {
        onFocus?.(event);
        // Pointer focus is retained, but selection waits for release/click so the
        // anticipation can play. Arrow-key focus still activates normally.
        if (pressed?.current) event.preventBaseUIHandler();
      }}
    />
  );
}
