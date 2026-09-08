import {
  createElement,
  type CSSProperties,
  type ElementType,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
} from "react";
import { cn } from "../lib/utils.js";

type Scale = string | number;
type Responsive =
  | Scale
  | { base?: Scale; xs?: Scale; sm?: Scale; md?: Scale; lg?: Scale; xl?: Scale };
export interface BoxProps extends Omit<HTMLAttributes<HTMLElement>, "color"> {
  component?: ElementType;
  ref?: Ref<HTMLElement>;
  p?: Responsive;
  px?: Responsive;
  py?: Responsive;
  pt?: Responsive;
  pb?: Responsive;
  pl?: Responsive;
  pr?: Responsive;
  m?: Responsive;
  mx?: Responsive;
  my?: Responsive;
  mt?: Responsive;
  mb?: Responsive;
  ml?: Responsive;
  mr?: Responsive;
  w?: Responsive;
  h?: Responsive;
  miw?: Responsive;
  maw?: Responsive;
  mih?: Responsive;
  mah?: Responsive;
  c?: string;
  bg?: string;
  ff?: string;
  fw?: number;
  fz?: Scale;
  lh?: Scale;
  ta?: CSSProperties["textAlign"];
  tt?: CSSProperties["textTransform"];
  viewBox?: string;
  display?: CSSProperties["display"];
  visibleFrom?: string;
  hiddenFrom?: string;
  href?: string;
  target?: string;
  rel?: string;
  src?: string;
  alt?: string;
}
const spacing: Record<string, string> = {
  xs: "0.5rem",
  sm: "0.75rem",
  md: "1rem",
  lg: "1.5rem",
  xl: "2rem",
};
export function length(value: Scale | undefined): string | undefined {
  return typeof value === "number"
    ? `${value}px`
    : value === undefined
      ? undefined
      : (spacing[value] ?? value);
}
function fontSize(value: Scale | undefined) {
  const sizes: Record<string, string> = {
    xs: "0.75rem",
    sm: "0.875rem",
    md: "1rem",
    lg: "1.125rem",
    xl: "1.25rem",
  };
  return typeof value === "string" ? (sizes[value] ?? value) : length(value);
}
export function color(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value === "dimmed") return "var(--muted-foreground)";
  if (
    value.startsWith("#") ||
    value.startsWith("var(") ||
    value === "inherit" ||
    value === "transparent"
  )
    return value;
  return `var(--status-${value.split(".")[0]}, var(--foreground))`;
}
const styleKeys: Record<string, string> = {
  p: "padding",
  px: "paddingInline",
  py: "paddingBlock",
  pt: "paddingTop",
  pb: "paddingBottom",
  pl: "paddingLeft",
  pr: "paddingRight",
  m: "margin",
  mx: "marginInline",
  my: "marginBlock",
  mt: "marginTop",
  mb: "marginBottom",
  ml: "marginLeft",
  mr: "marginRight",
  w: "width",
  h: "height",
  miw: "minWidth",
  maw: "maxWidth",
  mih: "minHeight",
  mah: "maxHeight",
};
/** Shared spacing vocabulary keeps dense operator layouts consistent across shadcn controls. */
export function boxAttributes(props: BoxProps) {
  const {
    component: _component,
    ref: _ref,
    c,
    bg,
    ff,
    fw,
    fz,
    lh,
    ta,
    tt,
    display,
    visibleFrom,
    hiddenFrom,
    className,
    style,
    ...rest
  } = props;
  const resolved: Record<string, string | number | undefined> = {};
  const classes: string[] = [];
  for (const [key, property] of Object.entries(styleKeys)) {
    const value = rest[key as keyof typeof rest] as Responsive | undefined;
    delete rest[key as keyof typeof rest];
    if (typeof value === "object" && value !== null) {
      classes.push(`ui-responsive-${key}`);
      for (const [breakpoint, item] of Object.entries(value))
        resolved[`--${key}-${breakpoint}`] = length(item);
    } else if (value !== undefined) resolved[property] = length(value);
  }
  return {
    ...rest,
    className: cn(
      classes,
      visibleFrom && `ui-visible-${visibleFrom}`,
      hiddenFrom && `ui-hidden-${hiddenFrom}`,
      className,
    ),
    style: {
      ...resolved,
      color: color(c),
      backgroundColor: color(bg),
      fontFamily: ff,
      fontWeight: fw,
      fontSize: fontSize(fz),
      lineHeight: lh,
      textAlign: ta,
      textTransform: tt,
      display,
      ...style,
    } as CSSProperties,
  };
}
export function Box({ component = "div", ref, ...props }: BoxProps) {
  return createElement(component, { ...boxAttributes(props), ref });
}
interface LayoutProps extends BoxProps {
  gap?: Scale;
  align?: CSSProperties["alignItems"];
  justify?: CSSProperties["justifyContent"];
  wrap?: CSSProperties["flexWrap"];
  grow?: boolean;
}
export function Group({
  gap = "sm",
  align = "center",
  justify,
  wrap = "wrap",
  grow,
  style,
  ...props
}: LayoutProps) {
  return (
    <Box
      {...props}
      style={{
        display: "flex",
        alignItems: align,
        justifyContent: justify,
        flexWrap: wrap,
        gap: length(gap),
        ...(grow ? { flex: 1 } : {}),
        ...style,
      }}
    />
  );
}
export function Stack({ gap = "md", align, justify, style, ...props }: LayoutProps) {
  return (
    <Box
      {...props}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: length(gap),
        alignItems: align,
        justifyContent: justify,
        ...style,
      }}
    />
  );
}
export function Center({ style, ...props }: BoxProps) {
  return (
    <Box
      {...props}
      style={{ display: "flex", alignItems: "center", justifyContent: "center", ...style }}
    />
  );
}
interface TextProps extends BoxProps {
  size?: Scale;
  span?: boolean;
  truncate?: boolean | string;
  lineClamp?: number;
  inherit?: boolean;
}
export function Text({
  size = "sm",
  span,
  truncate,
  lineClamp,
  inherit,
  component,
  style,
  ...props
}: TextProps) {
  return (
    <Box
      component={component ?? (span ? "span" : "p")}
      {...props}
      style={{
        fontSize: inherit ? "inherit" : fontSize(props.fz ?? size),
        ...(truncate ? { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } : {}),
        ...(lineClamp
          ? {
              display: "-webkit-box",
              WebkitLineClamp: lineClamp,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }
          : {}),
        ...style,
      }}
    />
  );
}
export function Title({
  order = 2,
  size,
  style,
  ...props
}: TextProps & { order?: 1 | 2 | 3 | 4 | 5 | 6 }) {
  return (
    <Text
      component={`h${order}`}
      size={size ?? (order === 1 ? "1.875rem" : "1.5rem")}
      {...props}
      style={{ fontWeight: 600, letterSpacing: "-0.035em", lineHeight: 1.25, ...style }}
    />
  );
}
export function Paper({
  withBorder: _withBorder,
  radius: _radius,
  shadow: _shadow,
  className,
  ...props
}: BoxProps & { withBorder?: boolean; radius?: Scale; shadow?: string }) {
  return (
    <Box
      data-slot="card"
      className={cn("rounded-xl border bg-card text-card-foreground shadow-xs", className)}
      {...props}
    />
  );
}
export function Code({ block, children, ...props }: BoxProps & { block?: boolean }) {
  return (
    <Box component={block ? "pre" : "code"} className="ui-code" {...props}>
      {children}
    </Box>
  );
}
export function Divider({ label, ...props }: BoxProps & { label?: ReactNode }) {
  return label ? (
    <Box className="ui-divider-label" {...props}>
      {label}
    </Box>
  ) : (
    <Box role="separator" className="ui-divider" {...props} />
  );
}
function ScrollAreaRoot({
  viewportProps,
  type: _type,
  scrollbars = "xy",
  offsetScrollbars: _offset,
  style,
  ...props
}: BoxProps & {
  type?: string;
  scrollbars?: string;
  offsetScrollbars?: boolean | string;
  viewportProps?: HTMLAttributes<HTMLDivElement>;
}) {
  return (
    <Box
      {...props}
      {...viewportProps}
      style={{
        overflowX: scrollbars.includes("x") ? "auto" : "hidden",
        overflowY: scrollbars.includes("y") ? "auto" : "hidden",
        minWidth: 0,
        ...style,
      }}
    />
  );
}
export function VisuallyHidden(props: BoxProps) {
  return <Box className="sr-only" {...props} />;
}
function GridRoot({ gutter = "md", style, ...props }: BoxProps & { gutter?: Scale }) {
  return (
    <Box
      {...props}
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(12,minmax(0,1fr))",
        gap: length(gutter),
        ...style,
      }}
    />
  );
}
function GridCol({ span = 12, style, ...props }: Omit<BoxProps, "span"> & { span?: Responsive }) {
  const values = typeof span === "object" ? span : { base: span };
  return (
    <Box
      {...props}
      className={cn("ui-grid-col", props.className)}
      style={{
        ...Object.fromEntries(Object.entries(values).map(([k, v]) => [`--col-${k}`, v])),
        ...style,
      }}
    />
  );
}
export const Grid = Object.assign(GridRoot, { Col: GridCol });

export const ScrollArea = Object.assign(ScrollAreaRoot, { Autosize: ScrollAreaRoot });
