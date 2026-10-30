import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  listKeyTarget,
  listMove,
  movedIndex,
  type ListKeyEvent,
  type ListKeyNode,
} from "./list-keyboard.js";

function key(name: string, changes: Partial<ListKeyEvent> = {}): ListKeyEvent {
  return {
    key: name,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    defaultPrevented: false,
    ...changes,
  };
}

/** An element that matches the selectors it names, as `closest` and `matches` see it. */
function node({
  inside = [],
  is = [],
}: {
  inside?: readonly string[];
  is?: readonly string[];
}): ListKeyNode {
  return {
    closest: (selector) =>
      selector.split(",").some((part) => inside.some((one) => part.trim().startsWith(one)))
        ? {}
        : null,
    matches: (selector) => selector.split(",").some((part) => is.includes(part.trim())),
  };
}

function region(...members: ListKeyNode[]) {
  return { contains: (target: ListKeyNode) => members.includes(target) };
}

describe("keys that move through a list", () => {
  it("moves down with ArrowDown and j, and up with ArrowUp and k", () => {
    expect(listMove(key("ArrowDown"), "list")).toBe("next");
    expect(listMove(key("j"), "list")).toBe("next");
    expect(listMove(key("ArrowUp"), "list")).toBe("previous");
    expect(listMove(key("k"), "list")).toBe("previous");
    expect(listMove(key("Enter"), "list")).toBeNull();
  });

  it("leaves the arrow keys to a control outside the list, but moves with j and k", () => {
    expect(listMove(key("ArrowDown"), "control")).toBeNull();
    expect(listMove(key("ArrowUp"), "control")).toBeNull();
    expect(listMove(key("j"), "control")).toBe("next");
    expect(listMove(key("k"), "control")).toBe("previous");
  });

  it("ignores every key while the operator types or uses a widget with its own arrow keys", () => {
    for (const name of ["ArrowDown", "ArrowUp", "j", "k"]) {
      expect(listMove(key(name), "widget")).toBeNull();
    }
  });

  it("ignores a key with a modifier, a handled key, and a key during text composition", () => {
    expect(listMove(key("j", { metaKey: true }), "list")).toBeNull();
    expect(listMove(key("j", { ctrlKey: true }), "list")).toBeNull();
    expect(listMove(key("ArrowDown", { altKey: true }), "list")).toBeNull();
    expect(listMove(key("J", { shiftKey: true }), "list")).toBeNull();
    expect(listMove(key("ArrowDown", { defaultPrevented: true }), "list")).toBeNull();
    expect(listMove(key("j", { isComposing: true }), "list")).toBeNull();
  });
});

describe("the row after a move", () => {
  it("starts at the first row when no row has focus", () => {
    expect(movedIndex({ current: null, length: 5, move: "next" })).toBe(0);
    expect(movedIndex({ current: null, length: 5, move: "previous" })).toBe(0);
  });

  it("moves one row and stops at each end", () => {
    expect(movedIndex({ current: 1, length: 5, move: "next" })).toBe(2);
    expect(movedIndex({ current: 1, length: 5, move: "previous" })).toBe(0);
    expect(movedIndex({ current: 4, length: 5, move: "next" })).toBe(4);
    expect(movedIndex({ current: 0, length: 5, move: "previous" })).toBe(0);
  });

  it("does nothing in an empty list, and starts again when the row left the list", () => {
    expect(movedIndex({ current: null, length: 0, move: "next" })).toBeNull();
    expect(movedIndex({ current: 7, length: 3, move: "next" })).toBe(0);
  });
});

describe("where a key event happened", () => {
  it("reads the page, the list, and the open panel as the list", () => {
    const row = node({ is: ["button"] });
    const inPanel = node({ inside: ["[role='dialog']"] });
    const regions = [region(row), region(inPanel)];

    expect(listKeyTarget({ target: null, regions })).toBe("list");
    expect(listKeyTarget({ target: node({ is: ["body"] }), regions })).toBe("list");
    expect(listKeyTarget({ target: node({ is: ["main"] }), regions })).toBe("list");
    expect(listKeyTarget({ target: row, regions })).toBe("list");
    expect(listKeyTarget({ target: inPanel, regions })).toBe("list");
  });

  it("reads fields, menus, tabs, and resize handles as widgets, also inside the panel", () => {
    const field = node({ inside: ["input"] });
    const menuItem = node({ inside: ["[role='menuitem']"] });
    const handle = node({ inside: ["[role='separator']"] });
    const regions = [region(field, menuItem, handle)];

    expect(listKeyTarget({ target: field, regions })).toBe("widget");
    expect(listKeyTarget({ target: menuItem, regions })).toBe("widget");
    expect(listKeyTarget({ target: handle, regions })).toBe("widget");
    expect(listKeyTarget({ target: node({ inside: ["[contenteditable]"] }), regions })).toBe(
      "widget",
    );
  });

  it("leaves a confirmation dialog its keys, and reads other controls as controls", () => {
    expect(listKeyTarget({ target: node({ inside: ["[role='dialog']"] }), regions: [] })).toBe(
      "widget",
    );
    expect(listKeyTarget({ target: node({ is: ["a"] }), regions: [] })).toBe("control");
  });
});

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("keyboard movement on the list pages", () => {
  it("moves through tasks and through the task drawer", () => {
    const source = read("./pages/tasks.tsx");
    expect(source).toContain("useRowKeyboardNavigation({");
    expect(source).toContain('id: "task-detail-drawer"');
    expect(source).toContain("openId: taskLocation.taskId");
    expect(source).toContain("open: inspectTask");
    expect(source).toContain("<TaskKeyboardHint />");
  });

  it("moves through events and through the event drawer", () => {
    const source = read("./pages/events.tsx");
    expect(source).toContain('id: "event-detail-drawer"');
    expect(source).toContain("openId: query.eventId");
    expect(source).toContain("data-event-id={event.id}");
  });

  it("moves through the task group links", () => {
    const source = read("./pages/task-groups.tsx");
    expect(source).toContain('rowSelector: ".task-group-row__link"');
    expect(source).toContain('className="task-group-row__link"');
  });
});
