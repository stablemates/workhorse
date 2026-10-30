import { readFileSync } from "node:fs";

import { MantineProvider } from "@mantine/core";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

Object.defineProperty(globalThis, "localStorage", {
  value: { getItem: () => null, setItem: () => undefined },
});

const {
  activeTaskFilters,
  clearedTaskFilters,
  hasTaskFilters,
  keepFocusOnRemoval,
  TaskFilterBar,
  TaskFilterEditor,
  taskFilterChipText,
  taskFilterFacets,
  taskFilterFocusAfterRemoval,
  taskFilterUpdate,
  taskFilterValues,
} = await import("./components/task-filter-bar.js");
const { Combobox, GraphicalProvider, theme } = await import("./ui.js");
const { parseTaskLocation, taskFilterHref, taskListingKey, taskLocationHref } =
  await import("./task-location.js");

type TaskLocationState = ReturnType<typeof parseTaskLocation>;

const cursor = {
  id: "01890abc-0000-7000-8000-000000000001",
  updatedAt: "2026-09-08T01:02:03.123456Z",
  priority: 50,
};

function render(node: ReactNode): string {
  return renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(GraphicalProvider, { document: theme, colorMode: "light" }, node),
    ),
  );
}

/** What the task page's `updateLocation` does: apply the change and start a fresh list. */
function applyUpdate(
  state: TaskLocationState,
  updates: Partial<TaskLocationState>,
): TaskLocationState {
  const href = taskLocationHref({
    ...state,
    page: 1,
    cursor: null,
    direction: "next",
    ...updates,
  });
  return parseTaskLocation(href.split("?")[1] ?? "");
}

function facet(id: (typeof taskFilterFacets)[number]["id"]) {
  const found = taskFilterFacets.find((one) => one.id === id);
  if (!found) throw new Error(`No facet ${id}`);
  return found;
}

const taskFacets = (overrides: { loading?: boolean; error?: string | null } = {}) => ({
  facets: { queues: ["emails"], workers: [], taskTypes: [], tags: ["billing", "weekly"] },
  loading: overrides.loading ?? false,
  error: overrides.error ?? null,
  load: () => undefined,
});

describe("task filter URLs", () => {
  it("reads a URL from before the filter bar into the same chips", () => {
    const legacy = new URLSearchParams({
      filter: "discarded",
      queue: "emails",
      worker: "worker-emails-1",
      type: "welcome.send",
      tags: "tenant:acme, weekly,tenant:acme",
      q: "invoice*",
      sort: "priority",
      per: "25",
      period: "6h",
      group: "queue",
      task: "3f1c0c8e-0000-4000-8000-000000000001",
      // Bookmarks from before SM-728 carry the cursor as JSON.
      cursor: JSON.stringify(cursor),
      direction: "previous",
    });
    const state = parseTaskLocation(legacy);

    expect(state).toEqual({
      filter: "discarded",
      queue: "emails",
      worker: "worker-emails-1",
      taskType: "welcome.send",
      tags: ["tenant:acme", "weekly"],
      search: "invoice*",
      sort: "priority",
      page: 1,
      pageSize: 25,
      period: "6h",
      group: "queue",
      taskId: "3f1c0c8e-0000-4000-8000-000000000001",
      cursor,
      direction: "previous",
    });
    expect(
      activeTaskFilters(state).map(({ facet: one, values }) => taskFilterChipText(one, values)),
    ).toEqual([
      "Queue: emails",
      "Worker: worker-emails-1",
      "Task type: welcome.send",
      "Tags: tenant:acme +1",
    ]);
  });

  it("round-trips every task location key", () => {
    const state: TaskLocationState = {
      filter: "retried",
      queue: "emails",
      worker: "worker-1",
      taskType: "order.process",
      tags: ["billing", "weekly"],
      search: "invoice*",
      sort: "priority",
      page: 3,
      pageSize: 100,
      period: "7d",
      group: "worker",
      taskId: "3f1c0c8e-0000-4000-8000-000000000001",
      cursor,
      direction: "previous",
    };
    const href = taskLocationHref(state);
    const keys = [...new URLSearchParams(href.split("?")[1]).keys()];

    expect(keys.toSorted()).toEqual(
      [
        "cursor",
        "direction",
        "filter",
        "group",
        "page",
        "per",
        "period",
        "q",
        "queue",
        "sort",
        "tags",
        "task",
        "type",
        "worker",
      ].toSorted(),
    );
    expect(href).toContain("tags=billing%2Cweekly");
    expect(href).toMatch(/cursor=v1\.[A-Za-z0-9_-]+/);
    expect(parseTaskLocation(href.split("?")[1]!)).toEqual(state);
  });

  it("writes each chip to the URL key its select wrote", () => {
    const base = parseTaskLocation("?page=4");

    expect(taskLocationHref(applyUpdate(base, taskFilterUpdate("queue", ["emails"])))).toBe(
      "/tasks?queue=emails",
    );
    expect(taskLocationHref(applyUpdate(base, taskFilterUpdate("worker", ["w-1"])))).toBe(
      "/tasks?worker=w-1",
    );
    expect(taskLocationHref(applyUpdate(base, taskFilterUpdate("taskType", ["a.b"])))).toBe(
      "/tasks?type=a.b",
    );
    expect(
      taskLocationHref(applyUpdate(base, taskFilterUpdate("tags", ["billing", "weekly"]))),
    ).toBe("/tasks?tags=billing%2Cweekly");
  });

  it("removes the URL key when a chip is removed, and resets the page", () => {
    const state = parseTaskLocation("?queue=emails&tags=billing,weekly&page=3&per=25");

    const withoutQueue = applyUpdate(state, taskFilterUpdate("queue", []));
    expect(taskLocationHref(withoutQueue)).toBe("/tasks?tags=billing%2Cweekly&per=25");

    const oneTag = applyUpdate(withoutQueue, taskFilterUpdate("tags", ["weekly"]));
    expect(oneTag.tags).toEqual(["weekly"]);
    expect(taskLocationHref(applyUpdate(oneTag, taskFilterUpdate("tags", [])))).toBe(
      "/tasks?per=25",
    );
  });

  it("gives a row action that filters by a value the same chip as the menu", () => {
    const state = parseTaskLocation("?filter=failed");
    // `useTaskActions` sends exactly these updates for "Only this queue", type, and worker.
    const fromRow = applyUpdate(state, { queue: "emails" });
    const fromChip = applyUpdate(state, taskFilterUpdate("queue", ["emails"]));

    expect(taskLocationHref(fromRow)).toBe(taskLocationHref(fromChip));
    expect(activeTaskFilters(fromRow)).toEqual(activeTaskFilters(fromChip));
    expect(taskLocationHref(applyUpdate(state, { taskType: "a.b" }))).toBe(
      taskLocationHref(applyUpdate(state, taskFilterUpdate("taskType", ["a.b"]))),
    );
    expect(taskLocationHref(applyUpdate(state, { worker: "w-1" }))).toBe(
      taskLocationHref(applyUpdate(state, taskFilterUpdate("worker", ["w-1"]))),
    );
  });

  it("clears the search and facets and keeps the status and view preferences", () => {
    const state = parseTaskLocation(
      "?filter=completed&q=nomatch&queue=emails&worker=w&type=t&tags=a,b&sort=priority&per=25&period=6h&group=queue&page=2&task=abc",
    );
    const cleared = applyUpdate(state, clearedTaskFilters);

    expect(hasTaskFilters(state)).toBe(true);
    expect(hasTaskFilters(cleared)).toBe(false);
    expect(activeTaskFilters(cleared)).toEqual([]);
    expect(cleared).toMatchObject({
      filter: "completed",
      sort: "priority",
      pageSize: 25,
      period: "6h",
      group: "queue",
      page: 1,
      search: null,
      taskId: "abc",
    });
    expect(taskLocationHref(cleared)).toBe(
      "/tasks?filter=completed&sort=priority&per=25&period=6h&group=queue&task=abc",
    );
  });

  it("keeps the sidebar and drawer rules the filter bar depends on", () => {
    const state = parseTaskLocation("?queue=emails&page=2&task=abc");
    // A status change from the sidebar starts a fresh list and closes the details.
    expect(taskFilterHref(state, "discarded")).toBe("/tasks?filter=discarded&queue=emails");
    // Opening and closing details does not change the listing request.
    expect(taskListingKey({ ...state, taskId: null })).toBe(taskListingKey(state));
  });
});

describe("task filter bar", () => {
  it("shows one chip for each facet in use, with separate edit and remove targets", () => {
    const html = render(
      createElement(TaskFilterBar, {
        selection: { ...parseTaskLocation("?queue=emails&tags=billing,weekly,eu") },
        searchInput: "",
        setSearchInput: () => undefined,
        taskFacets: taskFacets(),
        updateLocation: () => undefined,
        onClearFilters: () => undefined,
      }),
    );

    expect(html).toContain('aria-label="Edit queue filter: emails"');
    expect(html).toContain('aria-label="Remove queue filter"');
    expect(html).toContain('aria-label="Edit tags filter: billing, weekly, eu"');
    expect(html).toContain('aria-label="Remove tags filter"');
    expect(html).toContain(">+2<");
    expect(html).not.toContain("worker filter");
    expect(html).not.toContain("task type filter");
    expect(html).toContain("Add filter");
    expect(html).toContain("Clear filters");
    expect(html).toContain('aria-label="Search tasks"');
    // The bar has no status selector: the sidebar owns the status view.
    expect(html).not.toMatch(/status/i);
  });

  it("moves focus to the next chip, else the previous chip, else Add filter, when a chip goes", () => {
    const chips = ["queue", "worker", "tags"] as const;
    expect(taskFilterFocusAfterRemoval(chips, "queue")).toEqual({ kind: "chip", facet: "worker" });
    expect(taskFilterFocusAfterRemoval(chips, "worker")).toEqual({ kind: "chip", facet: "tags" });
    expect(taskFilterFocusAfterRemoval(chips, "tags")).toEqual({ kind: "chip", facet: "worker" });
    expect(taskFilterFocusAfterRemoval(["tags"], "tags")).toEqual({ kind: "addFilter" });
  });

  it("moves focus only when the control that leaves the page has it", () => {
    const focused: string[] = [];
    const target = { focus: () => focused.push("next") };
    const removeButton = { id: "remove" } as unknown as Element;
    const elsewhere = { id: "row" } as unknown as Element;
    const chip = { contains: (node: Node | null) => node === removeButton };
    // 1. The operator presses Enter on the remove button, so focus moves before the chip goes.
    keepFocusOnRemoval({ removed: chip, active: removeButton, target });
    expect(focused).toEqual(["next"]);
    // 2. A pointer click left focus on a table row, so the row keeps it.
    keepFocusOnRemoval({ removed: chip, active: elsewhere, target });
    keepFocusOnRemoval({ removed: chip, active: null, target });
    expect(focused).toEqual(["next"]);
    // 3. With no control to take focus, nothing happens.
    keepFocusOnRemoval({ removed: chip, active: removeButton, target: null });
    expect(focused).toEqual(["next"]);
  });

  it("moves focus before a chip remove or Clear filters takes its control off the page", () => {
    const source = readFileSync(
      new URL("./components/task-filter-bar.tsx", import.meta.url),
      "utf8",
    );
    // The chip remove button and Clear filters both move focus first, then change the filters.
    expect(source).toMatch(
      /keepFocusOnRemoval\(\{\s*removed: chip,[\s\S]*?\}\);\s*updateLocation\(taskFilterUpdate\(facet\.id, \[\]\)\);/,
    );
    expect(source).toMatch(
      /keepFocusOnRemoval\(\{\s*removed: event\.currentTarget,\s*active: document\.activeElement,\s*target: searchField\.current,\s*\}\);\s*setEditing\(null\);\s*onClearFilters\(\);/,
    );
    expect(source).toContain("ref={searchField}");
    expect(source).toContain("ref={addFilter}");
    expect(source).toContain("ref={triggerRef}");
  });

  it("offers no Clear filters while nothing narrows the list", () => {
    const html = render(
      createElement(TaskFilterBar, {
        selection: parseTaskLocation("?filter=discarded&sort=priority"),
        searchInput: "",
        setSearchInput: () => undefined,
        taskFacets: taskFacets(),
        updateLocation: () => undefined,
        onClearFilters: () => undefined,
      }),
    );

    expect(html).not.toContain("Clear filters");
    expect(html).not.toContain("Remove");
  });

  it("states loading, failure with a retry, and an empty match in the editor", () => {
    const editor = (state: ReturnType<typeof taskFacets>) =>
      render(
        createElement(
          Combobox.Root<string>,
          { items: state.facets.queues, open: true },
          createElement(TaskFilterEditor, { facet: facet("queue"), taskFacets: state }),
        ),
      );

    const loading = editor(taskFacets({ loading: true }));
    expect(loading).toContain('role="status"');
    expect(loading).toContain("Loading queues…");

    const failed = editor(taskFacets({ error: "failed" }));
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Workhorse could not load the queues.");
    expect(failed).toContain(">Retry<");

    const ready = editor(taskFacets());
    expect(ready).not.toContain("Loading queues");
    expect(ready).not.toContain("Retry");
    expect(ready).toContain('aria-label="Search queues"');
  });

  it("reads the values of each facet from its location key", () => {
    const state = parseTaskLocation("?queue=q&worker=w&type=t&tags=a,b");
    expect(taskFilterFacets.map((one) => taskFilterValues(state, one.id))).toEqual([
      ["q"],
      ["w"],
      ["t"],
      ["a", "b"],
    ]);
    expect(taskFilterChipText(facet("tags"), [])).toBe("Tags");
  });

  it("keeps the view controls apart from the filters on the task page", () => {
    const page = readFileSync(new URL("./pages/tasks.tsx", import.meta.url), "utf8");
    const filterBar = page.indexOf("<TaskFilterBar");
    const viewControls = page.indexOf("<TaskViewControls>");
    expect(filterBar).toBeGreaterThan(0);
    expect(viewControls).toBeGreaterThan(filterBar);
    expect(page.indexOf("<TaskSortSelect")).toBeGreaterThan(viewControls);
    expect(page.indexOf('label="Tasks per page"')).toBeGreaterThan(viewControls);
    expect(page.indexOf("<TaskChartToggle")).toBeGreaterThan(viewControls);
  });
});

describe("task filter popups", () => {
  const source = readFileSync(new URL("./components/task-filter-bar.tsx", import.meta.url), "utf8");

  it("own Escape ahead of the task drawer without pausing refresh", () => {
    // An open editor or menu is tracked, so Escape closes it first. It is not a task action
    // menu, so it must not pause refresh with that reason.
    expect(source.match(/useControlledPopupActivity\(/g)?.length).toBe(3);
    expect(source).not.toContain("useConfirmationActivity");
  });
});
