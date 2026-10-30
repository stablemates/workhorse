'use client';

import {
  createContext,
  useContext,
  useState,
  type CSSProperties,
  type Ref,
} from 'react';
import { Slider } from '@base-ui/react/slider';
import { usePartAppearance } from "./component-theme.js";

const InsetTrackSize = createContext(0);
const SliderPositionMotion = createContext(false);

/** Single-value thick tracks contain the knob; explicit alignment preserves custom compositions. */
export function InsetSliderRoot<Value extends number | readonly number[]>({
  thumbAlignment,
  onValueChange,
  ...props
}: Slider.Root.Props<Value> & { ref?: Ref<HTMLDivElement> }) {
  const [animatePosition, setAnimatePosition] = useState(false);
  const state = props.disabled ? 'disabled' : 'rest';
  const track = usePartAppearance('slider', 'track', state)?.controlSize ?? 0;
  const thumb = usePartAppearance('slider', 'thumb', state)?.controlSize ?? 0;
  const inset =
    thumbAlignment === undefined &&
    props.orientation !== 'vertical' &&
    !Array.isArray(props.value ?? props.defaultValue) &&
    track > thumb;
  return (
    <InsetTrackSize value={inset ? track : 0}>
      <SliderPositionMotion value={animatePosition}>
        <Slider.Root
          {...props}
          thumbAlignment={thumbAlignment ?? 'center'}
          onValueChange={(value, details) => {
            onValueChange?.(value, details);
            if (!details.isCanceled) {
              // Track clicks glide to their value; dragging follows the pointer.
              setAnimatePosition(details.reason !== 'drag');
            }
          }}
        />
      </SliderPositionMotion>
    </InsetTrackSize>
  );
}

export function InsetSliderControl({
  className,
  style,
  ...props
}: Slider.Control.Props & { ref?: Ref<HTMLDivElement> }) {
  const track = useContext(InsetTrackSize);
  return (
    <Slider.Control
      {...props}
      data-inset={track > 0 || undefined}
      className={(state) =>
        [
          'ui-slider-control',
          typeof className === 'function' ? className(state) : className,
        ]
          .filter(Boolean)
          .join(' ')
      }
      style={(state) =>
        ({
          ...(track > 0 && {
            '--slider-track-size': `${track}px`,
            paddingInlineStart: track / 2,
            paddingInlineEnd: track / 2,
            minHeight: track,
          }),
          ...(typeof style === 'function' ? style(state) : style),
        }) as CSSProperties
      }
    />
  );
}

function fraction(value: number, min: number, max: number) {
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

export function InsetSliderThumb({
  style,
  ...props
}: Slider.Thumb.Props & { ref?: Ref<HTMLDivElement> }) {
  const track = useContext(InsetTrackSize);
  const animatePosition = useContext(SliderPositionMotion);
  return (
    <Slider.Thumb
      {...props}
      data-animate-position={animatePosition || undefined}
      style={(state) => ({
        ...(track > 0 && {
          insetInlineStart: `calc(${track / 2}px + (100% - ${track}px) * ${fraction(state.values[0]!, state.min, state.max)})`,
        }),
        ...(typeof style === 'function' ? style(state) : style),
      })}
    />
  );
}

export function InsetSliderIndicator({
  style,
  ...props
}: Slider.Indicator.Props & { ref?: Ref<HTMLDivElement> }) {
  const track = useContext(InsetTrackSize);
  const animatePosition = useContext(SliderPositionMotion);
  return (
    <Slider.Indicator
      {...props}
      data-animate-position={animatePosition || undefined}
      style={(state) => {
        const end = fraction(state.values[0]!, state.min, state.max);
        return {
          ...(track > 0 && {
            width: `calc(${track}px + (100% - ${track}px) * ${end})`,
          }),
          ...(typeof style === 'function' ? style(state) : style),
        };
      }}
    />
  );
}
