'use client';

import { componentRadius } from "../../lib/component-radius.js";

import {
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithRef,
  type CSSProperties,
} from 'react';
import { NumberField } from '@base-ui/react/number-field';
import { useRender } from '@base-ui/react/use-render';
import { AnimatePresence, motion } from 'motion/react';
import {
  usePartAppearance,
  usePartStyle,
  useThemeMotion,
} from "./component-theme.js";

export function NumberFieldGroup({
  style,
  className,
  ...props
}: ComponentPropsWithRef<typeof NumberField.Group>) {
  const input = usePartAppearance('number-field', 'input');
  const variables = usePartStyle('number-field', 'input');
  const integrated =
    (variables as Record<string, unknown>)['--theme-name'] === 'Atlas';
  const geometry = {
    '--number-field-input-height': input
      ? `${input.lineHeight + input.paddingTop + input.paddingBottom}px`
      : undefined,
    '--number-field-radius': input ? componentRadius(input) : undefined,
  } as CSSProperties;
  return (
    <NumberField.Group
      {...props}
      data-integrated={integrated || undefined}
      className={(state) =>
        [
          'ui-number-group',
          integrated && 'ui-part',
          typeof className === 'function' ? className(state) : className,
        ]
          .filter(Boolean)
          .join(' ')
      }
      style={(state) => ({
        ...variables,
        ...geometry,
        ...(typeof style === 'function' ? style(state) : style),
      })}
    />
  );
}

function NumberInputDisplay({
  inputProps,
  state,
  render,
}: {
  inputProps: ComponentPropsWithRef<'input'>;
  state: NumberField.Input.State;
  render: NumberField.Input.Props['render'];
}) {
  const variables = usePartStyle('number-field', 'input');
  const { disabled, transition } = useThemeMotion();
  const [previous, setPrevious] = useState({
    value: state.value,
    direction: 1,
  });
  if (previous.value !== state.value) {
    setPrevious({
      value: state.value,
      direction: (state.value ?? 0) >= (previous.value ?? 0) ? 1 : -1,
    });
  }
  const input = useRender({
    defaultTagName: 'input',
    render,
    state: { ...state },
    props: { ...inputProps },
  });
  return (
    <span className="ui-number-display" style={variables}>
      {input}
      <span className="ui-number-ticker" aria-hidden="true">
        <AnimatePresence initial={false} custom={previous.direction}>
          <motion.span
            key={state.inputValue}
            className="ui-number-ticker-value"
            custom={previous.direction}
            variants={{
              enter: (direction: number) => ({
                y: `${direction * 100}%`,
                opacity: 0,
              }),
              current: { y: '0%', opacity: 1 },
              exit: (direction: number) => ({
                y: `${direction * -100}%`,
                opacity: 0,
              }),
            }}
            initial={disabled ? false : 'enter'}
            animate="current"
            exit={disabled ? undefined : 'exit'}
            transition={transition}
          >
            {state.inputValue}
          </motion.span>
        </AnimatePresence>
      </span>
    </span>
  );
}

export function AnimatedNumberInput({
  render,
  ...props
}: ComponentPropsWithRef<typeof NumberField.Input>) {
  return (
    <NumberField.Input
      {...props}
      render={(inputProps, state) => (
        <NumberInputDisplay
          inputProps={inputProps}
          state={state}
          render={render}
        />
      )}
    />
  );
}

function numberStepper(Base: typeof NumberField.Increment) {
  return function NumberStepper({
    onPointerDown,
    onClick,
    ...props
  }: ComponentPropsWithRef<typeof NumberField.Increment>) {
    const stopRepeat = useRef(() => {});
    const mousePress = useRef(false);
    useEffect(() => () => stopRepeat.current(), []);
    return (
      <Base
        {...props}
        onPointerDown={(event) => {
          onPointerDown?.(event);
          // Touch/pen already avoid input focus and retain Base UI's scroll and
          // hold handling. Mouse presses use its click path without focusing.
          mousePress.current =
            event.pointerType !== 'touch' && event.pointerType !== 'pen';
          if (!mousePress.current) return;
          const button = event.currentTarget;
          const view = button.ownerDocument.defaultView;
          if (
            event.defaultPrevented ||
            event.button !== 0 ||
            !view ||
            button.getAttribute('aria-disabled') === 'true' ||
            button.hasAttribute('disabled')
          )
            return;
          event.preventDefault();
          stopRepeat.current();
          const { altKey, ctrlKey, metaKey, shiftKey } = event;
          const step = () => {
            if (
              button.getAttribute('aria-disabled') === 'true' ||
              button.hasAttribute('disabled')
            ) {
              stopRepeat.current();
              return;
            }
            // detail=0 invokes Base UI's activation path. It continues to own
            // parsing, min/max, modifiers, controlled values, and form commits.
            button.dispatchEvent(
              new view.MouseEvent('click', {
                bubbles: true,
                cancelable: true,
                detail: 0,
                altKey,
                ctrlKey,
                metaKey,
                shiftKey,
              }),
            );
          };
          let interval: ReturnType<typeof setInterval> | undefined;
          const delay = setTimeout(() => {
            interval = setInterval(step, 60);
          }, 400);
          const stop = () => {
            clearTimeout(delay);
            clearInterval(interval);
            view.removeEventListener('pointerup', stop);
            view.removeEventListener('pointercancel', stop);
            view.removeEventListener('blur', stop);
            button.removeEventListener('pointerleave', stop);
          };
          stopRepeat.current = stop;
          view.addEventListener('pointerup', stop);
          view.addEventListener('pointercancel', stop);
          view.addEventListener('blur', stop);
          button.addEventListener('pointerleave', stop);
          step();
        }}
        onClick={(event) => {
          // A physical mouse click follows the pointer-down activation above.
          // Base UI also skips it; do not call the consumer twice for one press.
          if (event.detail > 0 && mousePress.current) {
            event.preventDefault();
            return;
          }
          onClick?.(event);
        }}
      />
    );
  };
}

export const AnimatedNumberIncrement = numberStepper(NumberField.Increment);
export const AnimatedNumberDecrement = numberStepper(NumberField.Decrement);
