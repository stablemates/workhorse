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
          activeJobs: 0,
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
    expect(html).not.toContain('role="alert"');
  });
});
