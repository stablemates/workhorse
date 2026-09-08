import { type CSSProperties, type ElementType, type ReactNode } from "react";
import { Box, type BoxProps } from "./layout.js";
import { cn } from "../lib/utils.js";
function TableRoot({
  highlightOnHover: _highlight,
  striped: _striped,
  withTableBorder: _border,
  withColumnBorders: _columns,
  verticalSpacing: _vertical,
  horizontalSpacing: _horizontal,
  stickyHeader: _sticky,
  captionSide,
  layout,
  style,
  ...props
}: BoxProps & {
  highlightOnHover?: boolean;
  striped?: boolean;
  withTableBorder?: boolean;
  withColumnBorders?: boolean;
  verticalSpacing?: string | number;
  horizontalSpacing?: string | number;
  stickyHeader?: boolean;
  captionSide?: CSSProperties["captionSide"];
  layout?: CSSProperties["tableLayout"];
}) {
  return (
    <Box
      component="table"
      {...props}
      className={cn("ui-table", props.className)}
      style={{ tableLayout: layout, captionSide, ...style }}
    />
  );
}
function tablePart(component: ElementType) {
  return function TablePart(
    props: BoxProps & { colSpan?: number; rowSpan?: number; scope?: string },
  ) {
    return <Box component={component} {...props} />;
  };
}
export const Table = Object.assign(TableRoot, {
  Thead: tablePart("thead"),
  Tbody: tablePart("tbody"),
  Tr: tablePart("tr"),
  Th: tablePart("th"),
  Td: tablePart("td"),
  Caption: tablePart("caption"),
  ScrollContainer: ({ minWidth, children }: { minWidth: number; children: ReactNode }) => (
    <div style={{ overflowX: "auto" }}>
      <div style={{ minWidth }}>{children}</div>
    </div>
  ),
});
function Shell({
  children,
  navbar,
  header: _header,
  padding: _padding,
  ...props
}: BoxProps & {
  children: ReactNode;
  header?: unknown;
  navbar: { collapsed: { mobile: boolean }; width: unknown; breakpoint: string };
  padding?: unknown;
}) {
  return (
    <Box {...props} className="ui-shell" data-navigation-open={!navbar.collapsed.mobile}>
      <a className="ui-skip-link" href="#dashboard-content">
        Skip to content
      </a>
      {children}
    </Box>
  );
}
function Header(props: BoxProps) {
  return <Box component="header" {...props} className={cn("ui-shell-header", props.className)} />;
}
function Navbar(props: BoxProps) {
  return (
    <Box
      component="nav"
      aria-label="Main navigation"
      {...props}
      className={cn("ui-shell-sidebar", props.className)}
    />
  );
}
function Main(props: BoxProps) {
  return (
    <Box
      component="main"
      id="dashboard-content"
      tabIndex={-1}
      {...props}
      className={cn("ui-shell-main", props.className)}
    />
  );
}
function Section({
  grow,
  style,
  type: _type,
  scrollbars: _scrollbars,
  ...props
}: BoxProps & { grow?: boolean; type?: string; scrollbars?: string }) {
  return (
    <Box
      {...props}
      style={{ ...(grow ? { flex: 1, minHeight: 0, overflowY: "auto" } : {}), ...style }}
    />
  );
}
export const AppShell = Object.assign(Shell, { Header, Navbar, Main, Section });
