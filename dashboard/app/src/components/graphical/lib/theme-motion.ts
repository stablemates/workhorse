import { cubicBezier, spring } from 'motion';
import type { ThemeMotionCurve } from "./theme-model.js";

export const DEFAULT_SPRING_BOUNCE = 0.2;

/** Theme durations are milliseconds; Motion's visualDuration is seconds. */
export function motionDuration(curve: ThemeMotionCurve): number {
  return curve.type === 'spring'
    ? (curve.visualDuration ?? curve.duration / 1000) * 1000
    : curve.duration;
}

/** Use with motion/react's transition prop or animate(). */
export function resolveMotionTransition(
  curve: ThemeMotionCurve,
  reduced = false,
) {
  if (reduced || motionDuration(curve) === 0)
    return { type: 'tween' as const, duration: 0 };
  return curve.type === 'spring'
    ? {
        type: 'spring' as const,
        visualDuration: motionDuration(curve) / 1000,
        bounce: curve.bounce ?? DEFAULT_SPRING_BOUNCE,
      }
    : {
        type: 'tween' as const,
        duration: curve.duration / 1000,
        ease: curve.easing,
      };
}

const springCss = new Map<string, { duration: number; easing: string }>();

/** Base UI CSS transitions use Motion's own spring generator, including its settling tail. */
export function resolveMotionCss(curve: ThemeMotionCurve) {
  const duration = motionDuration(curve);
  if (duration === 0) return { duration: 0, easing: 'linear' };
  if (curve.type !== 'spring')
    return { duration, easing: `cubic-bezier(${curve.easing.join(', ')})` };
  const bounce = curve.bounce ?? DEFAULT_SPRING_BOUNCE;
  const key = `${duration}-${bounce}`;
  const cached = springCss.get(key);
  if (cached) return cached;
  const css = String(spring(duration / 1000, bounce));
  const space = css.indexOf(' ');
  const resolved = { duration: parseFloat(css), easing: css.slice(space + 1) };
  if (springCss.size >= 64) springCss.delete(springCss.keys().next().value!);
  springCss.set(key, resolved);
  return resolved;
}

/** Sample the same response for graphs and multi-keyframe Motion sequences. */
export function motionProgress(
  curve: ThemeMotionCurve,
): (progress: number) => number {
  if (motionDuration(curve) === 0) return () => 1;
  if (curve.type !== 'spring') return cubicBezier(...curve.easing);
  const generator = spring(
    motionDuration(curve) / 1000,
    curve.bounce ?? DEFAULT_SPRING_BOUNCE,
  );
  const { duration } = resolveMotionCss(curve);
  return (progress) =>
    progress >= 1 ? 1 : generator.next(progress * duration).value;
}

/** Library components receive these variables through their existing theme scope and portals. */
export function motionCurveFromVariables(
  variables: Record<string, string | number | undefined>,
  role: 'small' | 'large' = 'small',
): ThemeMotionCurve {
  const prefix = role === 'small' ? '--motion' : '--motion-large';
  const duration = parseFloat(String(variables[`${prefix}-duration`] ?? 200));
  if (variables[`${prefix}-type`] === 'spring')
    return {
      type: 'spring',
      duration,
      easing: [0, 0, 1, 1],
      visualDuration: parseFloat(
        String(variables[`${prefix}-visual-duration`] ?? duration / 1000),
      ),
      bounce: Number(variables[`${prefix}-bounce`] ?? DEFAULT_SPRING_BOUNCE),
    };
  const easing = String(
    variables[`${prefix}-easing`] ?? 'cubic-bezier(0.16, 1, 0.3, 1)',
  );
  return {
    duration,
    easing: easing.startsWith('cubic-bezier(')
      ? (easing
          .slice(13, -1)
          .split(',')
          .map(Number) as ThemeMotionCurve['easing'])
      : [0, 0, 1, 1],
  };
}
