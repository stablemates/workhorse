import { clamp, colorToRgb, parseColor } from "./dialkit-color.js";

/** Choose the stronger black/white contrast against the rendered fill. */
export function contrastingTextColor(fill: string, backdrop = '#ffffff') {
  const color = parseColor(fill);
  if (!color) return '#000000';
  const base = parseColor(backdrop);
  const behind = base ? colorToRgb(base) : [1, 1, 1];
  const channels = colorToRgb(color).map((channel, index) => {
    const rendered =
      clamp(channel) * color.a + clamp(behind[index]!) * (1 - color.a);
    return rendered <= 0.04045
      ? rendered / 12.92
      : ((rendered + 0.055) / 1.055) ** 2.4;
  });
  const luminance =
    channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  const blackContrast = (luminance + 0.05) / 0.05;
  const whiteContrast = 1.05 / (luminance + 0.05);
  return blackContrast >= whiteContrast ? '#000000' : '#ffffff';
}
