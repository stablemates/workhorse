/** Adapted from DialKit 2.0, src/color.ts.
 * Dependency-free CSS color math. Matrices use the CSS Color 4 D65 reference white.
 * https://www.w3.org/TR/css-color-4/#color-conversion-code */
export type Color = { l: number; c: number; h: number; a: number };
export type ColorFormat = 'hex' | 'oklch' | 'p3';
type Triple = [number, number, number];
export const clamp = (n: number, min = 0, max = 1) =>
  Math.max(min, Math.min(max, n));
export const wrapHue = (h: number) => ((h % 360) + 360) % 360;
const multiply = (m: number[][], v: Triple): Triple =>
  m.map((row) => row.reduce((n, x, i) => n + x * v[i]!, 0)) as Triple;
const linearize = (v: number) =>
  Math.abs(v) <= 0.04045
    ? v / 12.92
    : Math.sign(v) * ((Math.abs(v) + 0.055) / 1.055) ** 2.4;
const encode = (v: number) =>
  Math.abs(v) <= 0.0031308
    ? 12.92 * v
    : Math.sign(v) * (1.055 * Math.abs(v) ** (1 / 2.4) - 0.055);
const RGB_XYZ = [
  [0.4123907993, 0.3575843394, 0.1804807884],
  [0.2126390059, 0.7151686788, 0.0721923154],
  [0.0193308187, 0.1191947798, 0.9505321522],
];
const P3_XYZ = [
  [0.4865709486, 0.2656676932, 0.1982172852],
  [0.2289745641, 0.6917385218, 0.0792869141],
  [0, 0.0451133819, 1.0439443689],
];
const XYZ_RGB = [
  [3.2409699419, -1.5373831776, -0.4986107603],
  [-0.9692436363, 1.8759675015, 0.0415550574],
  [0.0556300797, -0.2039769589, 1.0569715142],
];
const XYZ_P3 = [
  [2.4934969119, -0.9313836179, -0.4027107845],
  [-0.8294889696, 1.7626640603, 0.0236246858],
  [0.0358458302, -0.0761723893, 0.956884524],
];

export function rgbToColor(
  rgb: Triple,
  a = 1,
  space: 'srgb' | 'p3' = 'srgb',
): Color {
  const xyz = multiply(
    space === 'p3' ? P3_XYZ : RGB_XYZ,
    rgb.map(linearize) as Triple,
  );
  const [l, m, s] = multiply(
    [
      [0.819022438, 0.3619062601, -0.1288737815],
      [0.0329836539, 0.9292868616, 0.0361446664],
      [0.0481771894, 0.2642395318, 0.6335478285],
    ],
    xyz,
  ).map(Math.cbrt) as Triple;
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.hypot(A, B);
  return {
    l: clamp(L),
    c: c < 1e-7 ? 0 : c,
    h: c < 1e-7 ? 0 : wrapHue((Math.atan2(B, A) * 180) / Math.PI),
    a: clamp(a),
  };
}

export function colorToRgb(
  color: Color,
  space: 'srgb' | 'p3' = 'srgb',
): Triple {
  const a = color.c * Math.cos((color.h * Math.PI) / 180);
  const b = color.c * Math.sin((color.h * Math.PI) / 180);
  const lms: Triple = [
    (color.l + 0.3963377774 * a + 0.2158037573 * b) ** 3,
    (color.l - 0.1055613458 * a - 0.0638541728 * b) ** 3,
    (color.l - 0.0894841775 * a - 1.291485548 * b) ** 3,
  ];
  const xyz = multiply(
    [
      [1.2268798734, -0.5578149966, 0.2813910502],
      [-0.0405757626, 1.1122868294, -0.0717110667],
      [-0.0763729497, -0.421493324, 1.5869240244],
    ],
    lms,
  );
  return multiply(space === 'p3' ? XYZ_P3 : XYZ_RGB, xyz).map(encode) as Triple;
}

export function inGamut(color: Color, space: 'srgb' | 'p3' = 'srgb'): boolean {
  return colorToRgb(color, space).every((n) => n >= -0.00001 && n <= 1.00001);
}

/** Preserve lightness and hue when reducing chroma to an RGB gamut. */
export function fitGamut(color: Color, space: 'srgb' | 'p3' = 'srgb'): Color {
  if (inGamut(color, space)) return color;
  let lo = 0;
  let hi = color.c;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut({ ...color, c: mid }, space)) lo = mid;
    else hi = mid;
  }
  return { ...color, c: lo };
}

/** The right edge of the picker at a given lightness and hue. */
export function maxChroma(
  l: number,
  h: number,
  space: 'srgb' | 'p3' = 'srgb',
): number {
  if (l <= 0 || l >= 1) return 0;
  return fitGamut({ l, c: 0.5, h, a: 1 }, space).c;
}

export function colorFormat(value: string): ColorFormat {
  return /^oklch\(/i.test(value.trim())
    ? 'oklch'
    : /^color\(display-p3\s/i.test(value.trim())
      ? 'p3'
      : 'hex';
}
const round = (v: number, digits = 4) => Number(v.toFixed(digits));

/** Apply opacity without converting the source channels or color space. */
export function colorWithOpacity(value: string, opacity: number): string {
  const text = value.trim();
  if (/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(text)) {
    const hex =
      text.length <= 5
        ? text
            .slice(1)
            .split('')
            .map((digit) => digit + digit)
            .join('')
        : text.slice(1);
    const alpha =
      clamp(opacity) *
      (hex.length === 8 ? parseInt(hex.slice(6), 16) / 255 : 1);
    return `#${hex.slice(0, 6)}${Math.round(alpha * 255)
      .toString(16)
      .padStart(2, '0')}`;
  }
  const parsed = parseColor(text);
  if (!parsed) return value;
  const alpha = clamp(opacity) * parsed.a;
  if (colorFormat(text) !== 'hex') {
    return `${text.slice(0, -1).split('/')[0]!.trim()} / ${round(alpha)})`;
  }
  return formatColor({ ...parsed, a: alpha }, 'hex');
}

export function formatColor(color: Color, format: ColorFormat): string {
  const alpha = color.a < 1 ? ` / ${round(color.a)}` : '';
  if (format === 'oklch')
    return `oklch(${round(color.l)} ${round(color.c)} ${round(color.h, 2)}${alpha})`;
  const rgb = colorToRgb(
    fitGamut(color, format === 'p3' ? 'p3' : 'srgb'),
    format === 'p3' ? 'p3' : 'srgb',
  );
  if (format === 'p3')
    return `color(display-p3 ${rgb.map((n) => round(clamp(n), 5)).join(' ')}${alpha})`;
  const bytes = rgb.map((n) => Math.round(clamp(n) * 255));
  if (color.a < 1) bytes.push(Math.round(color.a * 255));
  return '#' + bytes.map((n) => n.toString(16).padStart(2, '0')).join('');
}

const NUMBER =
  /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(%|deg|grad|rad|turn)?$/i;
function number(value: string, percentScale = 1, hue = false): number | null {
  const match = value.match(NUMBER);
  if (!match) return null;
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return null;
  const unit = match[1]?.toLowerCase();
  if (hue)
    return unit === 'rad'
      ? (n * 180) / Math.PI
      : unit === 'turn'
        ? n * 360
        : unit === 'grad'
          ? n * 0.9
          : !unit || unit === 'deg'
            ? n
            : null;
  return unit === '%' ? (n * percentScale) / 100 : !unit ? n : null;
}

/** Absolute hex, RGB, HSL, OKLCH and Display P3 colors; no browser/DOM dependency. */
export function parseColor(value: string): Color | null {
  const text = value.trim().toLowerCase();
  if (text === 'transparent') return { l: 0, c: 0, h: 0, a: 0 };
  if (/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/.test(text)) {
    let hex = text.slice(1);
    if (hex.length <= 4)
      hex = hex
        .split('')
        .map((c) => c + c)
        .join('');
    const bytes = hex.match(/../g)!.map((c) => parseInt(c, 16) / 255);
    return rgbToColor(bytes.slice(0, 3) as Triple, bytes[3] ?? 1);
  }
  const match = text.match(/^(oklch|rgb|rgba|hsl|hsla|color)\(([^()]*)\)$/);
  if (!match) return null;
  const kind = match[1]!;
  let body = match[2]!.trim();
  const p3 = kind === 'color';
  if (p3) {
    if (!body.startsWith('display-p3 ')) return null;
    body = body.slice(11).trim();
  }
  const legacy = body.includes(',');
  if (legacy && (p3 || kind === 'oklch' || body.includes('/'))) return null;
  const parts = legacy
    ? body.split(',').map((x) => x.trim())
    : body.split(/\s*\/\s*/);
  if (!legacy && parts.length > 2) return null;
  const channels = legacy ? parts.slice(0, 3) : parts[0]!.split(/\s+/);
  if (
    channels.length !== 3 ||
    (legacy && parts.length !== 3 && parts.length !== 4)
  )
    return null;
  if (
    legacy &&
    kind.startsWith('rgb') &&
    channels.some((c) => c.endsWith('%')) &&
    !channels.every((c) => c.endsWith('%'))
  )
    return null;
  const alphaText = legacy ? parts[3] : parts[1];
  const alpha = alphaText === undefined ? 1 : number(alphaText);
  if (alpha === null) return null;
  if (kind === 'oklch') {
    const l = number(channels[0]!);
    const c = number(channels[1]!, 0.4);
    const h = number(channels[2]!, 1, true);
    return l === null || c === null || h === null
      ? null
      : { l: clamp(l), c: Math.max(0, c), h: wrapHue(h), a: clamp(alpha) };
  }
  if (kind.startsWith('hsl')) {
    const h = number(channels[0]!, 1, true);
    const s = number(channels[1]!);
    const l = number(channels[2]!);
    if (
      h === null ||
      s === null ||
      l === null ||
      !channels[1]!.endsWith('%') ||
      !channels[2]!.endsWith('%')
    )
      return null;
    const sat = clamp(s),
      light = clamp(l);
    const a = sat * Math.min(light, 1 - light);
    const f = (n: number) => {
      const k = (n + wrapHue(h) / 30) % 12;
      return light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    };
    return rgbToColor([f(0), f(8), f(4)], alpha);
  }
  const values = channels.map((c) => number(c, p3 ? 1 : 255));
  if (values.some((n) => n === null)) return null;
  return rgbToColor(
    values.map((n) => (p3 ? n! : clamp(n! / 255))) as Triple,
    alpha,
    p3 ? 'p3' : 'srgb',
  );
}
