import { MantineProvider, Table } from "@mantine/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusBadge } from "./status-badge.js";
import { taskStatusColors } from "./status-colors.js";
import type { DashboardEventRow } from "./wire.js";

Object.defineProperty(globalThis, "localStorage", {
  value: { getItem: () => null, setItem: () => undefined },
});

const render = (state: string) =>
  renderToStaticMarkup(createElement(MantineProvider, null, createElement(StatusBadge, { state })));

describe("compact status presentation", () => {
  it.each([
    ["succeeded", "succeeded"],
    ["failed", "failed"],
    ["claimed", "active"],
    ["batch_dispatched", "active"],
    ["batch_failed", "failed"],
    ["promoted", "ready"],
    ["retry_scheduled", "scheduled"],
    ["retry", "scheduled"],
    ["dependency_blocked", "blocked"],
    ["canceled", "canceled"],
    ["signal_waiting", "signalWait"],
    ["human_wait_created", "humanWait"],
    ["wait_scheduled", "durableWait"],
  ] as const)("matches %s events to the %s task color", async (event, status) => {
    const { eventTypeColor } = await import("./pages/events.js");
    expect(eventTypeColor(event)).toBe(taskStatusColors[status]);
  });
  it("gives active a color distinct from succeeded", () => {
    expect(render("active")).toContain("--mantine-color-blue");
    expect(render("succeeded")).toContain("--mantine-color-teal");
  });
  it.each(["event", "attempt"] as const)(
    "shows %s success as a colored badge after the task ID",
    async (kind) => {
      const { EventRow } = await import("./pages/events.js");
      const event = {
        kind,
        id: `${kind}:1`,
        recordId: "1",
        taskId: "task-123",
        taskType: "billing.invoice",
        queue: "billing",
        type: "succeeded",
        occurredAt: "2026-09-10T12:00:00Z",
        attempt: 1,
        workerId: "worker-123",
        fenceToken: null,
        durationMs: 10,
        details: null,
        errorMessage: null,
      } satisfies DashboardEventRow;
      const html = renderToStaticMarkup(
        createElement(
          MantineProvider,
          null,
          createElement(
            Table,
            null,
            createElement(
              Table.Tbody,
              null,
              createElement(EventRow, { event, inspectEvent: () => undefined }),
            ),
          ),
        ),
      );
      expect(html).toContain(kind === "attempt" ? ">Attempt succeeded<" : ">Task succeeded<");
      expect(html).not.toContain("status-square");
      expect(html).toContain("mantine-Badge-root");
      expect(html).toContain("--mantine-color-teal-light");
      expect(html.indexOf(">billing<")).toBeLessThan(html.indexOf(">billing.invoice<"));
      expect(html).toContain('title="worker-123"');
      expect(html).not.toContain("Copy event ID");
      expect(html.indexOf('aria-label="Copy task ID task-123"')).toBeLessThan(
        html.indexOf(kind === "attempt" ? ">Attempt succeeded<" : ">Task succeeded<"),
      );
    },
  );
});
