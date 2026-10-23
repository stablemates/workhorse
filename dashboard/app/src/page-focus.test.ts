import { describe, expect, it } from "vitest";

import { firstConnected, navigationMovesFocus, pageHeadingMayTakeFocus } from "./page-focus.js";

describe("focus after page navigation", () => {
  it("moves focus when the route changes, including Back and Forward", () => {
    expect(navigationMovesFocus("/tasks", "/queues")).toBe(true);
    expect(navigationMovesFocus("/queues", "/tasks")).toBe(true);
  });

  it("does not move focus for polling, filters, the pager, or the task drawer", () => {
    // These change the URL or the data, not the route.
    expect(navigationMovesFocus("/tasks", "/tasks")).toBe(false);
  });

  const ready = {
    route: "/workers" as const,
    shownRoute: "/workers" as const,
    focusInPage: false,
    focusInDrawer: false,
  };

  it("focuses the heading once the page area shows the new route", () => {
    expect(pageHeadingMayTakeFocus(ready)).toBe(true);
  });

  it("waits while the page area still shows the previous page or the loading screen", () => {
    // Queues to Workers: for one render the Queues heading is still there, and focusing it
    // would drop focus to the body when the loading screen replaces it.
    expect(pageHeadingMayTakeFocus({ ...ready, shownRoute: "/queues" })).toBe(false);
    expect(pageHeadingMayTakeFocus({ ...ready, shownRoute: null })).toBe(false);
  });

  it("leaves focus where the user put it before the heading arrived", () => {
    expect(pageHeadingMayTakeFocus({ ...ready, focusInPage: true })).toBe(false);
    expect(pageHeadingMayTakeFocus({ ...ready, focusInDrawer: true })).toBe(false);
  });
});

describe("focus when the task drawer closes", () => {
  it("returns to the opener while it is in the document", () => {
    const opener = { isConnected: true };
    expect(firstConnected([opener, { isConnected: true }])).toBe(opener);
  });

  it("uses the row's new element when a refresh replaced the opener", () => {
    const replacement = { isConnected: true };
    expect(firstConnected([{ isConnected: false }, replacement])).toBe(replacement);
  });

  it("reports none when a refresh removed the row, so the page heading takes focus", () => {
    expect(firstConnected([{ isConnected: false }, null])).toBeNull();
  });
});
