import { MantineProvider } from "@mantine/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DashboardWorkersPage } from "@workhorse/dashboard-server/wire";

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
});
