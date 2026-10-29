/**
 * The Mantine side of the Untitled theme.
 *
 * Most dashboard screens use Mantine components. This module gives Mantine the values of the
 * Graphical theme document in `components/graphical/theme.ts`, so those screens and the Graphical
 * components show the same theme. Every value comes from that document. Change the theme there.
 *
 * Mantine writes the variables of `dashboardCssVariablesResolver` on the document root, so they
 * also reach Mantine portals outside the `GraphicalProvider` element.
 */
import {
  createTheme,
  defaultVariantColorsResolver,
  parseThemeColor,
  type CSSVariablesResolver,
  type MantineColorsTuple,
  type VariantColorsResolver,
  virtualColor,
} from "@mantine/core";
import { dashboardThemeDocument } from "./theme-document.js";
import {
  resolveColor,
  resolveShadow,
  type ColorKey,
  type ColorMode,
} from "./components/graphical/lib/theme-model.js";
import { statusTextColors } from "./status-colors.js";
import { chartColorVariables } from "./charts/palette.js";

const definition = dashboardThemeDocument.theme;
const color = (mode: ColorMode, key: ColorKey) => resolveColor(definition, mode, key);
const px = (value: number) => `${Math.round(value)}px`;

function channels(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1, 7), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function mix(hex: string, toward: string, amount: number): string {
  const from = channels(hex);
  const to = channels(toward);
  return `#${from
    .map((channel, index) => Math.round(channel + (to[index]! - channel) * amount))
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}

/** Ten shades of one theme color. Shade 6 is the theme color, the shade that filled parts use. */
function shades(hex: string): MantineColorsTuple {
  return [
    mix(hex, "#ffffff", 0.92),
    mix(hex, "#ffffff", 0.82),
    mix(hex, "#ffffff", 0.68),
    mix(hex, "#ffffff", 0.52),
    mix(hex, "#ffffff", 0.34),
    mix(hex, "#ffffff", 0.16),
    hex,
    mix(hex, "#000000", 0.16),
    mix(hex, "#000000", 0.32),
    mix(hex, "#000000", 0.48),
  ];
}

const neutral = (mode: ColorMode, step: number) => color(mode, `neutral-${step}` as ColorKey);

/**
 * The primary action color is `neutral-10`: black in light mode and white in dark mode. A virtual
 * color gives each mode its own ramp. Mantine fills controls with shade 6 and its hover with
 * shade 7, and the theme keeps the same fill on hover. Mantine reads light-variant text from
 * shade 9 in light mode and from shade 0 in dark mode, so those shades are `neutral-10` too.
 * In dark mode Mantine darkens shade 9 by half for a light-variant background, so `neutral-5`
 * there gives about `neutral-3`, the theme's highlighted option.
 */
const inkLight: MantineColorsTuple = [
  neutral("light", 2),
  neutral("light", 3),
  neutral("light", 4),
  neutral("light", 5),
  neutral("light", 6),
  neutral("light", 7),
  neutral("light", 10),
  neutral("light", 10),
  neutral("light", 10),
  neutral("light", 10),
];
const inkDark: MantineColorsTuple = [
  neutral("dark", 10),
  neutral("dark", 9),
  neutral("dark", 8),
  neutral("dark", 7),
  neutral("dark", 6),
  neutral("dark", 5),
  neutral("dark", 10),
  neutral("dark", 10),
  neutral("dark", 10),
  neutral("dark", 5),
];

/** Mantine's light-mode gray, from the light neutral ramp. */
const gray: MantineColorsTuple = [
  neutral("light", 2),
  neutral("light", 3),
  neutral("light", 4),
  mix(neutral("light", 4), neutral("light", 5), 0.5),
  neutral("light", 5),
  neutral("light", 6),
  neutral("light", 7),
  neutral("light", 8),
  neutral("light", 9),
  neutral("light", 10),
];

/**
 * Mantine's dark-mode surfaces, from the dark neutral ramp. Mantine reads text from shade 0,
 * borders from shade 4, controls from shade 6, and the page from shade 7.
 */
const dark: MantineColorsTuple = [
  neutral("dark", 9),
  neutral("dark", 8),
  neutral("dark", 7),
  neutral("dark", 6),
  neutral("dark", 5),
  neutral("dark", 4),
  neutral("dark", 3),
  neutral("dark", 2),
  mix(neutral("dark", 2), neutral("dark", 1), 0.5),
  neutral("dark", 1),
];

// The four theme hues. Their values do not change between light and dark mode.
const accent = shades(color("light", "color-1"));
const navy = shades(color("light", "color-2"));
const lavender = shades(color("light", "color-3"));
const peach = shades(color("light", "color-4"));
// `color-2` is too dark to see on a dark page, so dark mode uses a lighter shade of it.
const navyDark = shades(navy[2]);
const success = shades(color("light", "success"));
const warning = shades(color("light", "warning"));
const error = shades(color("light", "error"));

/**
 * The dashboard names Mantine colors such as `red` and `teal` in many places. Each name gives a
 * theme hue. Task states keep distinct names in `status-colors.ts`, so a state dot keeps a
 * distinct hue. `variantColorResolver` below keeps every other colored part neutral.
 *
 * `accent` is `color-1`. The theme uses it only for the focus outline and checked controls, so
 * no other color name gives it. The wait states use `color-4`.
 */
const themeColors = {
  ink: virtualColor({ name: "ink", light: "inkLight", dark: "inkDark" }),
  inkLight,
  inkDark,
  gray,
  dark,
  accent,
  red: error,
  pink: lavender,
  grape: lavender,
  violet: lavender,
  indigo: navy,
  blue: virtualColor({ name: "blue", light: "navyLight", dark: "navyDark" }),
  navyLight: navy,
  navyDark,
  cyan: navy,
  teal: success,
  green: success,
  lime: success,
  yellow: warning,
  orange: peach,
} satisfies Record<string, MantineColorsTuple>;

/** Text for a colored part that reports an error or a warning. Other parts use `neutral-10`. */
const semanticText: Readonly<Record<string, string>> = {
  red: "var(--workhorse-color-danger-text)",
  yellow: "var(--workhorse-color-warning-text)",
  orange: "var(--workhorse-color-warning-text)",
};

const noBorder = "0 solid transparent";

/**
 * The theme fills controls with neutrals and draws no borders. Only the primary action has a
 * `neutral-10` fill, and only a destructive action has the `error` fill. A light, outline, or
 * filled part in another color gets the secondary `neutral-3` fill, and its text keeps the
 * meaning of an error or a warning. A state dot gets its hue from the `dot` variant instead.
 */
const variantColorResolver: VariantColorsResolver = (input) => {
  const base = defaultVariantColorsResolver(input);
  const name = parseThemeColor({
    color: input.color ?? input.theme.primaryColor,
    theme: input.theme,
  }).color;
  const primary = input.color === undefined || name === input.theme.primaryColor;
  const text = semanticText[name] ?? "var(--workhorse-neutral-10)";
  const secondary = {
    background: "var(--workhorse-neutral-3)",
    hover: "var(--workhorse-neutral-4)",
    color: text,
    hoverColor: text,
    border: noBorder,
  };
  switch (input.variant) {
    case "filled":
      return primary || name === "red" ? { ...base, border: noBorder } : secondary;
    case "light":
    case "outline":
    case "default":
      return secondary;
    case "subtle":
      return {
        background: "transparent",
        hover: "var(--workhorse-neutral-3)",
        color: primary ? "var(--workhorse-neutral-10)" : text,
        hoverColor: primary ? "var(--workhorse-neutral-10)" : text,
        border: noBorder,
      };
    default:
      return { ...base, border: noBorder };
  }
};

/** The theme stack with its fallback font, as `theme-document.ts` gives it. */
const fontFamily = definition.fonts.ui.family;

const text = (key: keyof typeof definition.text) => ({
  fontSize: px(definition.text[key].size),
  lineHeight: px(definition.text[key].lineHeight),
});

export const dashboardMantineTheme = createTheme({
  primaryColor: "ink",
  variantColorResolver,
  primaryShade: { light: 6, dark: 6 },
  autoContrast: true,
  white: neutral("light", 1),
  black: neutral("light", 10),
  colors: themeColors,
  fontFamily,
  headings: {
    fontFamily,
    fontWeight: String(definition.fonts.ui.weights.heavy),
    sizes: {
      h1: text("l"),
      h2: text("m"),
      h3: text("m"),
      h4: text("s"),
      h5: text("xs"),
      h6: text("xs"),
    },
  },
  fontSizes: {
    xs: px(definition.text.xs.size),
    sm: px(definition.text.s.size),
    md: px(definition.text.m.size),
    lg: px(definition.text.l.size),
    xl: px(definition.text.xl.size),
  },
  lineHeights: {
    xs: px(definition.text.xs.lineHeight),
    sm: px(definition.text.s.lineHeight),
    md: px(definition.text.m.lineHeight),
    lg: px(definition.text.l.lineHeight),
    xl: px(definition.text.xl.lineHeight),
  },
  spacing: {
    xs: px(definition.spacing.xs),
    sm: px(definition.spacing.s),
    md: px(definition.spacing.m),
    lg: px(definition.spacing.l),
    xl: px(definition.spacing.xl),
  },
  radius: {
    xs: px(definition.radius.xs),
    sm: px(definition.radius.s),
    md: px(definition.radius.m),
    lg: px(definition.radius.l),
    xl: px(definition.radius.xl),
  },
  // Buttons use radius `s`, and Mantine gives the default radius to most controls.
  defaultRadius: "sm",
  // The theme gives elevation only to shadow `m`. Shadows `s` and `l` have no opacity.
  shadows: {
    xs: "none",
    sm: "none",
    md: "var(--workhorse-shadow-m)",
    lg: "none",
    xl: "none",
  },
  components: {
    Button: { styles: { root: { fontWeight: definition.fonts.ui.weights.medium } } },
    // The theme separates a surface with a fill, not a border.
    Paper: { vars: () => ({ root: { "--paper-border-color": "transparent" } }) },
    // A table draws only a hairline between rows, and a hovered row takes `neutral-3`.
    Table: {
      vars: () => ({
        table: {
          "--table-border-color": "var(--workhorse-divider)",
          "--table-hover-color": "var(--workhorse-neutral-3)",
          "--table-striped-color": "var(--workhorse-neutral-2)",
        },
      }),
    },
    // A compact segmented control: a 30px `neutral-3` track with 8px corners and 2px of inset,
    // and a 26px selected option with 6px corners. Every size uses these measures, so the
    // controls on all pages match. `styles.css` draws the focus ring.
    SegmentedControl: {
      defaultProps: { withItemsBorders: false, radius: 8 },
      vars: () => ({
        root: {
          "--sc-color": "var(--workhorse-segment-selected)",
          "--sc-shadow": "0 1px 2px rgb(0 0 0 / 0.08), 0 0 0 0.5px rgb(0 0 0 / 0.08)",
          "--sc-padding": "0 10px",
          "--sc-font-size": px(definition.text.xs.size),
          "--sc-transition-duration": "150ms",
          "--sc-label-color": "var(--workhorse-neutral-10)",
        },
      }),
      styles: {
        root: { backgroundColor: "var(--workhorse-segment-track)", padding: 2 },
        indicator: { borderRadius: 6 },
        label: {
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: 26,
          minWidth: 32,
          lineHeight: 1,
          whiteSpace: "nowrap",
          borderRadius: 6,
          fontWeight: definition.fonts.ui.weights.medium,
        },
      },
    },
    AppShell: { defaultProps: { withBorder: false } },
    Badge: { defaultProps: { radius: "xs" } },
    // Amber marks a checked control. It marks nothing else.
    Switch: { defaultProps: { color: "accent" } },
    Radio: { defaultProps: { color: "accent" } },
    Checkbox: { defaultProps: { color: "accent" } },
    Accordion: { defaultProps: { variant: "filled" } },
    Notification: { defaultProps: { withBorder: false } },
    Menu: {
      defaultProps: { shadow: "md", radius: "xs" },
      styles: {
        dropdown: {
          backgroundColor: "var(--workhorse-surface-popup)",
          border: 0,
          padding: px(definition.spacing.xxs),
        },
        item: { borderRadius: px(definition.radius.xs) },
      },
    },
    Combobox: {
      defaultProps: { shadow: "md" },
      styles: {
        dropdown: {
          backgroundColor: "var(--workhorse-surface-popup)",
          border: 0,
          padding: px(definition.spacing.xxs),
        },
        option: { borderRadius: px(definition.radius.xs) },
      },
    },
    Popover: {
      defaultProps: { shadow: "md", radius: "md" },
      styles: { dropdown: { backgroundColor: "var(--workhorse-surface-popup)", border: 0 } },
    },
    HoverCard: {
      defaultProps: { shadow: "md", radius: "md" },
      styles: { dropdown: { backgroundColor: "var(--workhorse-surface-popup)", border: 0 } },
    },
    Tooltip: {
      defaultProps: { radius: "sm", color: "ink" },
      styles: {
        tooltip: {
          color: "var(--workhorse-neutral-1)",
          fontSize: px(definition.text.xs.size),
          lineHeight: px(definition.text.xs.lineHeight),
          fontWeight: definition.fonts.ui.weights.medium,
          padding: `${px(definition.spacing.xxs)} ${px(definition.spacing.xs)}`,
          boxShadow: "var(--workhorse-shadow-m)",
        },
      },
    },
    Modal: {
      defaultProps: { shadow: "md", radius: "md" },
      styles: {
        content: { backgroundColor: "var(--workhorse-surface-popup)" },
        header: { backgroundColor: "var(--workhorse-surface-popup)" },
      },
    },
    // The current page is a neutral fill, like every selected item in the theme.
    Pagination: {
      vars: () => ({
        root: {
          "--pagination-active-bg": "var(--workhorse-neutral-3)",
          "--pagination-active-color": "var(--workhorse-neutral-10)",
        },
      }),
    },
    Drawer: {
      defaultProps: { shadow: "md" },
      styles: {
        content: { backgroundColor: "var(--workhorse-surface-popup)" },
        header: { backgroundColor: "var(--workhorse-surface-popup)" },
      },
    },
  },
});

/** Theme variables for each mode. Application styles and Mantine overrides read these names. */
function modeVariables(mode: ColorMode): Record<string, string> {
  const variables: Record<string, string> = {};
  for (let step = 1; step <= 10; step += 1) {
    variables[`--workhorse-neutral-${step}`] = neutral(mode, step);
  }
  for (const key of ["color-1", "color-2", "color-3", "color-4", "success", "warning", "error"]) {
    variables[`--workhorse-${key}`] = color(mode, key as ColorKey);
  }
  return {
    ...variables,
    "--workhorse-surface-popup": mode === "light" ? neutral(mode, 1) : neutral(mode, 2),
    "--workhorse-shadow-m": resolveShadow(definition, mode, "m"),
    // The theme draws keyboard focus with `color-1` at 2px, because its controls have no border.
    "--workhorse-focus-ring": color(mode, "color-1"),
    "--mantine-color-body": neutral(mode, 1),
    "--mantine-color-text": neutral(mode, 10),
    // Light `neutral-7` gives 4.1:1 on white. `neutral-8` keeps secondary text above 4.5:1.
    "--mantine-color-dimmed": mode === "light" ? neutral(mode, 8) : neutral(mode, 7),
    "--mantine-color-placeholder": neutral(mode, 6),
    // A default control is the theme's secondary control: a `neutral-3` fill and no border.
    "--mantine-color-default": neutral(mode, 3),
    "--mantine-color-default-hover": neutral(mode, 4),
    "--mantine-color-default-color": neutral(mode, 10),
    "--mantine-color-default-border": "transparent",
    // The one line the theme draws: a hairline between the rows of a table or a list.
    "--workhorse-divider": mode === "light" ? neutral(mode, 4) : neutral(mode, 3),
    // Chart series colors. `charts/palette.ts` states the contrast of each value.
    ...chartColorVariables(mode),
    // The selected option of a segmented control: white on the light track, and a lighter gray
    // than the track in dark mode, so it never reads as a black hole in the track.
    "--workhorse-segment-track": neutral(mode, 3),
    "--workhorse-segment-selected": mode === "light" ? neutral(mode, 1) : neutral(mode, 5),
    // A switch track. Checked is amber, darkened in light mode to give 3.7:1 on white. Unchecked
    // is a gray between `neutral-6` and `neutral-7`, which gives at least 3:1 on its panel.
    "--workhorse-switch-on": mode === "light" ? accent[7] : accent[6],
    "--workhorse-switch-off":
      mode === "light"
        ? mix(neutral(mode, 6), neutral(mode, 7), 0.5)
        : mix(neutral(mode, 5), neutral(mode, 6), 0.5),
    "--mantine-color-error": color(mode, "error"),
    "--mantine-color-success": color(mode, "success"),
    "--mantine-color-anchor": neutral(mode, 10),
    // Text on the primary fill, which is `neutral-10` in each mode.
    "--mantine-primary-color-contrast": neutral(mode, 1),
    "--workhorse-color-warning-text": statusTextColors.warning[mode],
    "--workhorse-color-danger-text": statusTextColors.danger[mode],
    // `c="red"` and similar text props read these names.
    "--mantine-color-red-text": statusTextColors.danger[mode],
    "--mantine-color-yellow-text": statusTextColors.warning[mode],
    "--mantine-color-orange-text": statusTextColors.warning[mode],
  };
}

export const dashboardCssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {},
  light: modeVariables("light"),
  dark: modeVariables("dark"),
});

/** The page color of each mode, for the browser `theme-color` metadata. */
export const dashboardPageColor = {
  light: neutral("light", 1),
  dark: neutral("dark", 1),
} as const;
