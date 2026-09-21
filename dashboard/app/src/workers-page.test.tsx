import { MantineProvider } from "@mantine/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DashboardWorkersPage } from "@stablemates/workhorse-dashboard-server/wire";

Object.defineProperty(globalThis, "localStorage", {
  value: { getItem: () => null, setItem: () => undefined },
});

describe("workers page", () => {
  it("attributes fleet registration and active-task counts to Workhorse", async () => {
    const { WorkersPage } = await import("./dashboard.js");
    const data: DashboardWorkersPage = {
      capturedAt: "2026-08-16T12:00:00.000Z",
      canManageWorkers: false,
      workers: [],
    };
    const html = renderToStaticMarkup(
      createElement(
        MantineProvider,
        null,
        createElement(WorkersPage, {
          data,
          togglingWorker: null,
          setWorkerPaused: () => undefined,
        }),
      ),
    );

    expect(html).toContain("workers register with Workhorse");
    expect(html).toContain("Workhorse counts active tasks");
    expect(html).not.toContain("workers register in PostgreSQL");
  });

  it("attaches process-local pause guidance to the Claims toggle", async () => {
    const { WorkersPage } = await import("./dashboard.js");
    const data: DashboardWorkersPage = {
      capturedAt: "2026-08-16T12:00:00.000Z",
      canManageWorkers: true,
      workers: [
        {
          id: "worker-1",
          queues: ["default"],
          scheduleNamespaces: ["billing"],
          hostname: "worker-host",
          pid: 123,
          activeTasks: 0,
          concurrency: 4,
          activeSlots: 0,
          draining: false,
          completedAttempts: 0,
          failedAttempts: 0,
          averageExecutionMs: null,
          lastSeenAt: "2026-08-16T12:00:00.000Z",
          startedAt: "2026-08-16T11:00:00.000Z",
          registered: true,
          lastHeartbeatAt: "2026-08-16T12:00:00.000Z",
          paused: false,
        },
      ],
    };
    const html = renderToStaticMarkup(
      createElement(
        MantineProvider,
        null,
        createElement(WorkersPage, {
          data,
          togglingWorker: null,
          setWorkerPaused: () => undefined,
        }),
      ),
    );

    expect(html).toContain('aria-label="Pause worker-1"');
    expect(html).toContain("billing");
    expect(html).toContain("Several workers can offer the same namespace safely");
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain("deploy that replaces it clears the pause");
    expect(html).not.toContain('role="alert"');
    // The row says when the worker started, so a deploy's replacement reads as new.
    expect(html).toContain("Started");
    expect(html).toContain("the instances they sunset");
  });

  it("counts the schedule namespaces the compact column does not show", async () => {
    const { WorkersPage } = await import("./dashboard.js");
    const data: DashboardWorkersPage = {
      capturedAt: "2026-08-16T12:00:00.000Z",
      canManageWorkers: false,
      workers: [
        {
          id: "worker-1",
          queues: ["default"],
          scheduleNamespaces: ["billing", "reports", "digests"],
          hostname: "worker-host",
          pid: 123,
          activeTasks: 0,
          concurrency: 4,
          activeSlots: 0,
          draining: false,
          completedAttempts: 0,
          failedAttempts: 0,
          averageExecutionMs: null,
          lastSeenAt: "2026-08-16T12:00:00.000Z",
          startedAt: "2026-08-16T11:00:00.000Z",
          registered: true,
          lastHeartbeatAt: "2026-08-16T12:00:00.000Z",
          paused: false,
        },
      ],
    };
    const html = renderToStaticMarkup(
      createElement(
        MantineProvider,
        null,
        createElement(WorkersPage, {
          data,
          togglingWorker: null,
          setWorkerPaused: () => undefined,
        }),
      ),
    );

    // The column shows one namespace and says how many it holds back.
    expect(html).toContain("billing");
    expect(html).toContain("+2");
    // The full list stays reachable from the cell itself.
    expect(html).toContain('title="billing, reports, digests"');
    // The hour window reads without widening its column.
    expect(html).toContain("Avg execution");
    expect(html).not.toContain("Avg execution · 1h");
  });

  it("renders inert Claims cells for draining and offline workers", async () => {
    const { WorkersPage } = await import("./dashboard.js");
    const worker = {
      queues: ["default"],
      scheduleNamespaces: [],
      hostname: "worker-host",
      pid: 123,
      activeTasks: 0,
      concurrency: 4,
      activeSlots: 0,
      completedAttempts: 0,
      failedAttempts: 0,
      averageExecutionMs: null,
      registered: true,
      paused: false,
      sdkLanguage: "typescript",
      sdkVersion: "1.2.3",
    };
    const data: DashboardWorkersPage = {
      capturedAt: "2026-08-16T12:00:00.000Z",
      canManageWorkers: true,
      workers: [
        {
          ...worker,
          id: "sunsetting-1",
          draining: true,
          lastSeenAt: "2026-08-16T11:59:59.000Z",
          startedAt: "2026-08-14T09:00:00.000Z",
          lastHeartbeatAt: "2026-08-16T11:59:59.000Z",
        },
        {
          ...worker,
          id: "gone-1",
          draining: false,
          lastSeenAt: "2026-08-16T11:30:00.000Z",
          startedAt: "2026-08-14T09:00:00.000Z",
          lastHeartbeatAt: "2026-08-16T11:30:00.000Z",
        },
        {
          ...worker,
          id: "replacement-1",
          draining: false,
          lastSeenAt: "2026-08-16T12:00:00.000Z",
          startedAt: "2026-08-16T11:58:00.000Z",
          lastHeartbeatAt: "2026-08-16T12:00:00.000Z",
        },
      ],
    };
    const html = renderToStaticMarkup(
      createElement(
        MantineProvider,
        null,
        createElement(WorkersPage, {
          data,
          togglingWorker: null,
          setWorkerPaused: () => undefined,
        }),
      ),
    );

    // A draining worker states the fact instead of offering an enabled switch.
    expect(html).toContain("sunsetting-1 is draining and accepts no new claims");
    expect(html).not.toContain('aria-label="Pause sunsetting-1"');
    // An offline worker's cell is inert because a pause cannot reach it.
    expect(html).toContain("gone-1 is offline, so claims cannot be paused");
    expect(html).not.toContain('aria-label="Pause gone-1"');
    // A live replacement keeps the working control.
    expect(html).toContain('aria-label="Pause replacement-1"');
  });
});
