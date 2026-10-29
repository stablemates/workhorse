import { readFileSync } from "node:fs";

import { MantineProvider } from "@mantine/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

Object.defineProperty(globalThis, "localStorage", {
  value: { getItem: () => null, setItem: () => undefined },
});

const { TaskStatusTabs, taskStatusTabs } = await import("./components/task-status-tabs.js");
const { blockedTaskDescription } = await import("./core.js");
const { parseTaskLocation } = await import("./task-location.js");

type TaskStatusTabsProps = Parameters<typeof TaskStatusTabs>[0];

function render(props: Partial<TaskStatusTabsProps> = {}): string {
  return renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(TaskStatusTabs, {
        location: parseTaskLocation(""),
        taskCounts: null,
        href: (path) => `/ops${path}`,
        followLink: () => undefined,
        ...props,
      }),
    ),
  );
}

/** The markup of the one tab whose visible label is `label`. */
function tabFor(html: string, label: string): string {
  const links = html.match(/<a\b[^>]*>(?:(?!<\/a>).)*<\/a>/g) ?? [];
  const found = links.filter((link) =>
    link.includes(`<span class="task-status-tabs__label" data-text="${label}">${label}</span>`),
  );
  expect(found, `one tab labeled ${label}`).toHaveLength(1);
  return found[0]!;
}

describe("task status tabs", () => {
  it("lists the ten status views in order as links in a named navigation", () => {
    const html = render();

    expect(html).toContain('<nav class="task-status-tabs" aria-label="Task status">');
    expect(html).not.toContain('role="tab');
    expect(taskStatusTabs(parseTaskLocation(""), null).map((tab) => tab.label)).toEqual([
      "All tasks",
      "Blocked",
      "Waiting",
      "Scheduled",
      "Retried",
      "Queued",
      "Running",
      "Completed",
      "Discarded",
      "Canceled",
    ]);
  });

  it("marks the view that the URL names, and All tasks when the URL names none", () => {
    expect(tabFor(render(), "All tasks")).toContain('aria-current="page"');

    const waiting = render({ location: parseTaskLocation("?filter=waiting&queue=emails") });
    expect(tabFor(waiting, "Waiting")).toContain('aria-current="page"');
    expect(tabFor(waiting, "All tasks")).not.toContain("aria-current");
    expect(waiting.match(/aria-current="page"/g)).toHaveLength(1);
  });

  it("reads an unknown filter in an old URL as All tasks", () => {
    const html = render({ location: parseTaskLocation("?filter=archived") });
    expect(tabFor(html, "All tasks")).toContain('aria-current="page"');
  });

  it("links each view to a fresh list that keeps the other filters", () => {
    const location = parseTaskLocation("?filter=running&queue=emails&q=receipt&page=3&task=t-1");
    const html = render({ location });

    expect(tabFor(html, "Blocked")).toContain(
      'href="/ops/tasks?filter=blocked&amp;q=receipt&amp;queue=emails"',
    );
    expect(tabFor(html, "All tasks")).toContain('href="/ops/tasks?q=receipt&amp;queue=emails"');
  });

  it("gives a click the unmounted path of the view", () => {
    const retried = taskStatusTabs(parseTaskLocation("?worker=w-1"), null).find(
      (tab) => tab.value === "retried",
    );
    expect(retried?.path).toBe("/tasks?filter=retried&worker=w-1");

    const source = readFileSync(
      new URL("./components/task-status-tabs.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain("onClick={(event) => followLink(event, tab.path)}");
  });

  it("shows counts as plain numbers, zero as a quiet 0, and an unavailable count as nothing", () => {
    const html = render({ taskCounts: { all: 384_205, blocked: 0, running: 12 } });

    expect(tabFor(html, "All tasks")).toContain(
      '<span class="task-status-tabs__count" aria-hidden="true">384,205</span>',
    );
    expect(tabFor(html, "Blocked")).toContain(
      '<span class="task-status-tabs__count" data-zero="true" aria-hidden="true">0</span>',
    );
    expect(tabFor(html, "Waiting")).not.toContain("task-status-tabs__count");
    expect(tabFor(html, "Running")).toContain('aria-label="Running, 12 tasks"');
    expect(tabFor(html, "Waiting")).not.toContain("aria-label");
  });

  it("shows no count before the counts load", () => {
    expect(render({ taskCounts: null })).not.toContain("task-status-tabs__count");
  });

  it("explains Blocked in a tooltip so it does not read as Waiting", () => {
    const html = render();
    const blocked = tabFor(html, "Blocked");

    // The tooltip replaces the slow native title, and an info mark says that the tab explains.
    expect(blocked).not.toContain("title=");
    expect(blocked).toContain("task-status-tabs__info");
    const source = readFileSync(
      new URL("./components/task-status-tabs.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toMatch(/<Tooltip\s+label=\{description\}/);
    // Keyboard focus and touch open it too, not only a mouse hover.
    expect(source).toContain("events={{ hover: true, focus: true, touch: true }}");
    const describedBy = /aria-describedby="([^"]+)"/.exec(blocked)?.[1];
    expect(describedBy).toBeDefined();
    expect(html).toContain(`id="${describedBy}" hidden="">${blockedTaskDescription}</span>`);
    expect(tabFor(html, "Waiting")).not.toContain("aria-describedby");
  });
});

describe("a status change that keeps the page in place", () => {
  it("draws one underline for the row, so it can slide to the new tab", () => {
    const html = render({ location: parseTaskLocation("?filter=waiting") });
    expect(html.match(/task-status-tabs__indicator/g)).toHaveLength(1);
    expect(html).toContain('<li class="task-status-tabs__indicator" aria-hidden="true"></li>');
  });

  it("reserves the width of the heavier current label on every tab", () => {
    const css = readFileSync(new URL("./components/task-status-tabs.css", import.meta.url), "utf8");
    expect(css).toMatch(
      /\.task-status-tabs__label::after \{[^}]*font-weight: 500;[^}]*content: attr\(data-text\);/,
    );
    expect(css).not.toContain('[aria-current="page"]::after');
  });

  it("keeps the Tasks header the same for every view", () => {
    const pageSource = readFileSync(new URL("./pages/tasks.tsx", import.meta.url), "utf8");
    expect(pageSource).not.toContain("blockedTaskDescription");
    expect(pageSource).not.toMatch(/description=\{data\.filter/);
    expect(pageSource).toContain("inlineActions");
  });
});

describe("task status tabs on the Tasks page", () => {
  const pageSource = readFileSync(new URL("./pages/tasks.tsx", import.meta.url), "utf8");
  const controllerSource = readFileSync(new URL("./shell/controller.tsx", import.meta.url), "utf8");

  it("sit above the filter bar and get the task counts", () => {
    expect(pageSource.indexOf("<TaskStatusTabs")).toBeGreaterThan(-1);
    expect(pageSource.indexOf("<TaskStatusTabs")).toBeLessThan(
      pageSource.indexOf("<TaskFilterBar"),
    );
    expect(controllerSource).toContain("taskCounts={taskCounts}");
    expect(controllerSource).toMatch(/followLink: handleLink/);
  });
});
