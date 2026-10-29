import { MantineProvider } from "@mantine/core";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LoadState, PageData } from "./core.js";
import {
  PendingResults,
  focusAfterBlur,
  pagePending,
  restoreFocus,
  settleResults,
} from "./pending-results.js";

/** The source of a module of the app, read from disk. */
function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const queuesData: PageData = {
  route: "/queues",
  value: {
    capturedAt: "2026-10-27T12:00:00.000Z",
    queues: [],
    concurrencyPoliciesCapped: false,
    rateLimitPoliciesCapped: false,
    budgets: [],
    budgetsCapped: false,
  },
};

function render(pending: boolean): string {
  return renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(PendingResults, { pending }, createElement("table", null, "rows")),
    ),
  ).replace(/<style[^>]*>[\s\S]*?<\/style>/g, "");
}

function state(key: string, count: number, pending = false) {
  return { key, count, pending, message: `The table shows ${count} tasks.` };
}

describe("page pending state", () => {
  it("is pending while the rows on screen answer another request", () => {
    const loading: LoadState = { status: "loading", data: queuesData, error: null };
    expect(pagePending(loading, '["/queues","a"]', '["/queues","b"]')).toBe(true);
    // The click renders once before the load starts. The rows are pending already.
    const ready: LoadState = { status: "ready", data: queuesData, error: null };
    expect(pagePending(ready, '["/queues","a"]', '["/queues","b"]')).toBe(true);
  });

  it("is not pending for a refresh of the same request or with no rows", () => {
    const loading: LoadState = { status: "loading", data: queuesData, error: null };
    expect(pagePending(loading, '["/queues","a"]', '["/queues","a"]')).toBe(false);
    expect(pagePending({ status: "loading", data: null, error: null }, null, "x")).toBe(false);
    // A failed load of the new request shows its error, not dimmed rows.
    const failed: LoadState = {
      status: "error",
      data: queuesData,
      error: "down",
      route: "/queues",
    };
    expect(pagePending(failed, '["/queues","a"]', '["/queues","b"]')).toBe(false);
  });

  it("keeps the rows mounted, dimmed and busy, instead of a loader", () => {
    expect(render(true)).toBe(
      '<div class="pending-results" data-pending="true" aria-busy="true"><table>rows</table></div>',
    );
    expect(render(false)).toBe('<div class="pending-results"><table>rows</table></div>');
  });

  it("mounts only the rows again, so the scroll area of a table keeps its position", () => {
    // A key on the wrapper would mount the ScrollArea again and reset its horizontal scroll.
    expect(source("./pending-results.tsx")).not.toMatch(/<Fragment key=\{renderedKey\}>/);
    for (const listing of ["./pages/tasks.tsx", "./pages/events.tsx"]) {
      expect(source(listing)).toMatch(/<Table\.Tbody>\s*<PendingRows>/);
    }
  });
});

describe("result count announcement", () => {
  it("says nothing on the first answer, while a request loads, or on a poll", () => {
    const first = settleResults(null, state("a", 50));
    expect(first).toEqual({ key: "a", count: 50, message: "" });
    expect(settleResults(first, state("b", 12, true))).toBe(first);
    // A poll answers the same request again, also when the count changed.
    expect(settleResults(first, state("a", 49))).toBe(first);
  });

  it("says the new count when a new request settles with a different count", () => {
    const first = settleResults(null, state("a", 50));
    expect(settleResults(first, state("b", 12))).toEqual({
      key: "b",
      count: 12,
      message: "The table shows 12 tasks.",
    });
    // The same count says nothing, so a page change does not repeat the total.
    expect(settleResults(first, state("c", 50))).toEqual({ key: "c", count: 50, message: "" });
  });
});

// Stand-ins for the document and the rows. The suite has no DOM, and the rule needs only these.
function control(id: string) {
  const calls: unknown[] = [];
  const element = { id, focus: (options: unknown) => calls.push(options) };
  return { element: element as unknown as HTMLElement, calls };
}
function page(active: "body" | "other", controls: HTMLElement[]) {
  const body = {} as HTMLElement;
  return {
    body,
    activeElement: (active === "body" ? body : {}) as Element,
    getElementById: (id: string) => controls.find((element) => element.id === id) ?? null,
  };
}
function rows(members: HTMLElement[]) {
  return { contains: (node: Node | null) => members.includes(node as HTMLElement) };
}

describe("focus across new rows", () => {
  it("focuses the control with the same id when the old one took focus with it", () => {
    const next = control("task-row-7");
    restoreFocus(page("body", [next.element]), rows([next.element]), "task-row-7");
    expect(next.calls).toEqual([{ preventScroll: true }]);
  });

  it("leaves focus alone when the operator moved it, or when no control had it", () => {
    const next = control("task-row-7");
    restoreFocus(page("other", [next.element]), rows([next.element]), "task-row-7");
    restoreFocus(page("body", [next.element]), rows([next.element]), null);
    expect(next.calls).toEqual([]);
  });

  it("does not focus a control with the same id outside the rows, or a control that is gone", () => {
    const elsewhere = control("task-row-7");
    restoreFocus(page("body", [elsewhere.element]), rows([]), "task-row-7");
    expect(elsewhere.calls).toEqual([]);
    expect(() => restoreFocus(page("body", []), rows([]), "task-row-7")).not.toThrow();
  });

  it("remembers a removed control and forgets it after a move out of the rows", () => {
    const inside = control("task-row-8").element;
    const outside = control("search").element;
    const container = rows([inside]);
    expect(focusAfterBlur("task-row-7", null, container)).toBe("task-row-7");
    expect(focusAfterBlur("task-row-7", inside as unknown as Node, container)).toBe("task-row-7");
    expect(focusAfterBlur("task-row-7", outside as unknown as Node, container)).toBeNull();
  });
});
