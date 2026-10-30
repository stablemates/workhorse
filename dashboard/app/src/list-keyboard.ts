import { useEffect, useRef } from "react";

/**
 * Keyboard movement through a list of rows that open a detail panel.
 *
 * ArrowDown and `j` move to the next row, and ArrowUp and `k` move to the previous row. While no
 * panel is open, the move puts focus on the row's open control, so Enter opens it. While a panel
 * is open, the move opens the next or previous row in the same panel, and Escape closes it.
 */
export type ListMove = "next" | "previous";

/** The roles of widgets that use the arrow keys themselves, such as a menu or a resize handle. */
const arrowKeyRoles = [
  "combobox",
  "grid",
  "listbox",
  "menu",
  "menubar",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "radiogroup",
  "separator",
  "slider",
  "spinbutton",
  "tab",
  "tablist",
  "tree",
  "treegrid",
  "treeitem",
] as const;

const arrowKeyWidgetSelector = [
  "input",
  "textarea",
  "select",
  "[contenteditable]:not([contenteditable='false'])",
  ...arrowKeyRoles.map((role) => `[role='${role}']`),
].join(", ");

/** The parts of a key event that decide a move. */
export interface ListKeyEvent {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
  isComposing?: boolean;
}

/** Where the key event happened, relative to the list and its detail panel. */
export type ListKeyTarget =
  /** Typing in a field, or a widget such as a menu that uses the arrow keys itself. */
  | "widget"
  /** The page itself, the list, or the open detail panel. The arrow keys move here. */
  | "list"
  /** Any other control, such as a filter button. Only `j` and `k` move here. */
  | "control";

/**
 * The move that a key asks for, or null when the key does something else.
 *
 * A key with Alt, Control, Meta, or Shift is never a move, so browser and system shortcuts keep
 * working. The arrow keys move only from the list, its panel, or the page, so they still scroll a
 * region or move inside a control elsewhere. `j` and `k` move from any control that does not
 * take text.
 */
export function listMove(event: ListKeyEvent, target: ListKeyTarget): ListMove | null {
  if (event.defaultPrevented || event.isComposing === true) return null;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (target === "widget") return null;
  switch (event.key) {
    case "ArrowDown":
      return target === "list" ? "next" : null;
    case "ArrowUp":
      return target === "list" ? "previous" : null;
    case "j":
      return "next";
    case "k":
      return "previous";
    default:
      return null;
  }
}

/**
 * The index after a move in a list of `length` rows, or null when the list is empty.
 *
 * With no current row, a move starts at the first row. The move stops at each end, because a
 * jump from the last row to the first loses the operator's place.
 */
export function movedIndex({
  current,
  length,
  move,
}: {
  current: number | null;
  length: number;
  move: ListMove;
}): number | null {
  if (length === 0) return null;
  if (current === null || current < 0 || current >= length) return 0;
  return move === "next" ? Math.min(current + 1, length - 1) : Math.max(current - 1, 0);
}

/** The parts of an element that decide where a key event happened. */
export interface ListKeyNode {
  closest(selector: string): unknown;
  matches(selector: string): boolean;
}

/** A region, such as the list or its panel, that can hold the element of a key event. */
export interface ListKeyRegion<Node> {
  contains(node: Node): boolean;
}

/** Classifies the element that received a key event. No element means the document itself. */
export function listKeyTarget<Node extends ListKeyNode>({
  target,
  regions,
}: {
  target: Node | null;
  /** The list and the panel it opens. A key in one of them can move with the arrow keys. */
  regions: ReadonlyArray<ListKeyRegion<Node> | null>;
}): ListKeyTarget {
  if (target === null) return "list";
  if (target.closest(arrowKeyWidgetSelector) !== null) return "widget";
  const inRegion = regions.some((region) => region !== null && region.contains(target));
  // A modal dialog other than the list's own panel, such as a confirmation, keeps its keys.
  if (!inRegion && target.closest("[role='dialog'], [role='alertdialog']") !== null) {
    return "widget";
  }
  if (inRegion || target.matches("html, body, main")) return "list";
  return "control";
}

/** The detail panel that a row opens beside the list. */
interface RowDetailPanel {
  /** The id of the panel element, so keys inside it can move to another row. */
  id: string;
  /** The row ids in their order on screen. */
  ids: readonly string[];
  /** The row that the panel shows, or null when the panel is closed. */
  openId: string | null;
  /** Opens a row in the panel. */
  open: (id: string) => void;
  /** Finds the open control of a row, to keep it in view and to give it focus again. */
  rowControl: (id: string) => HTMLElement | null;
}

export interface RowKeyboardNavigation {
  /** Finds the element that holds the rows, or null while the list is not on screen. */
  list: () => HTMLElement | null;
  /** Selects the control in each row that opens it. The order in the document is the row order. */
  rowSelector: string;
  /** The panel that a row opens, or null when a row control opens another page. */
  panel: RowDetailPanel | null;
}

/** Scrolls a row into view without moving the page more than it must. */
function revealRow(control: HTMLElement) {
  control.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/**
 * Moves through a list of rows with ArrowDown, ArrowUp, `j`, and `k`.
 *
 * The listener is on the document, so the keys work as soon as the page shows. A key in a text
 * field or a widget that uses the arrow keys does nothing here. When the panel closes and focus
 * is lost or still in the panel, focus goes back to the row that the panel showed.
 */
export function useRowKeyboardNavigation(options: RowKeyboardNavigation) {
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const { list, rowSelector, panel } = latest.current;
      const container = list();
      if (container === null) return;
      const panelElement = panel === null ? null : document.getElementById(panel.id);
      const target = listKeyTarget<Element>({
        target: event.target instanceof Element ? event.target : null,
        regions: [container, panelElement],
      });
      const move = listMove(event, target);
      if (move === null) return;

      if (panel !== null && panel.openId !== null) {
        const { ids, openId } = panel;
        const at = ids.indexOf(openId);
        const index = movedIndex({ current: at === -1 ? null : at, length: ids.length, move });
        if (index === null) return;
        event.preventDefault();
        const id = ids[index];
        if (id === undefined || id === openId) return;
        panel.open(id);
        const control = panel.rowControl(id);
        if (control === null) return;
        // Focus in the list follows the open row, so Escape returns to the row the panel shows.
        if (container.contains(document.activeElement)) control.focus({ preventScroll: true });
        revealRow(control);
        return;
      }

      const controls = Array.from(container.querySelectorAll<HTMLElement>(rowSelector));
      const focused = controls.findIndex(
        (control) => control === document.activeElement || control.contains(document.activeElement),
      );
      const index = movedIndex({
        current: focused === -1 ? null : focused,
        length: controls.length,
        move,
      });
      if (index === null) return;
      event.preventDefault();
      const control = controls[index];
      if (control === undefined) return;
      control.focus({ preventScroll: true });
      revealRow(control);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const openId = options.panel?.openId ?? null;
  const previousOpenId = useRef(openId);
  useEffect(() => {
    const closedId = previousOpenId.current;
    previousOpenId.current = openId;
    const panel = latest.current.panel;
    if (closedId === null || openId !== null || panel === null) return;
    const active = document.activeElement;
    const panelElement = document.getElementById(panel.id);
    const focusLost = active === null || active === document.body;
    if (!focusLost && !(panelElement?.contains(active) ?? false)) return;
    panel.rowControl(closedId)?.focus();
  }, [openId]);
}
