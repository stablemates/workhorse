import type { ComponentStyle } from "./theme-model.js";

/** CSS order: top-left, top-right, bottom-right, bottom-left. */
export const RADIUS_CORNERS = [
  'radiusTopLeft',
  'radiusTopRight',
  'radiusBottomRight',
  'radiusBottomLeft',
] as const;

export function componentRadius(style: ComponentStyle, inset = 0): string {
  const corners = RADIUS_CORNERS.map((corner) =>
    Math.max(0, (style[corner] ?? style.radius) - inset),
  );
  return corners.every((corner) => corner === corners[0])
    ? `${corners[0]}px`
    : corners.map((corner) => `${corner}px`).join(' ');
}
