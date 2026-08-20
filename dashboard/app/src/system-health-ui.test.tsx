import { MantineProvider } from "@mantine/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DashboardSystemPage } from "@workhorse-js/dashboard-server/wire";

Object.defineProperty(globalThis, "localStorage", {
  value: { getItem: () => null, setItem: () => undefined },
});

const systemPage = {
  window: "1h",
  outcomes: [],
  queues: [
    {
      queue: "demo",
      paused: false,
      ready: 5,
      oldestReadyMs: 90_000,
      priorityBacklog: [
        { priority: 90, ready: 2, oldestReadyMs: 5_000 },
        { priority: 0, ready: 3, oldestReadyMs: 90_000 },
      ],
      dueSoon: 0,
      active: 1,
      retrying: 0,
      enqueuedPerMinute: 1,
      completedPerMinute: 1,
      concurrencyPolicy: null,
      rateLimitPolicy: null,
    },
  ],
  concurrencyPoliciesCapped: false,
  rateLimitPoliciesCapped: false,
  kpis: {
    drain: { enqueuedPerMinute: 1, completedPerMinute: 2, netPerMinute: 1 },
    backlog: { ready: 3, oldestReadyMs: 4_000 },
    errorRate: { current: 0, previous: 0, delta: 0 },
    queueWait: { p50Ms: 10, p95Ms: 20, p99Ms: 30 },
    retry: { backoff: 4, dueSoon: 1, buckets: [] },
    lease: { active: 2, expired: 0, expiringSoon: 1, recovered: 1 },
    dependencies: {
      blockedJobs: 5,
      pendingEdges: 7,
      failedResolutions: 2,
      retentionPruneStarved: true,
      capped: false,
    },
    children: {
      waitingParents: 3,
      pendingChildren: 4,
      unjoinedResults: 6,
      failedParents: 1,
      canceledParents: 2,
      capped: false,
    },
    externalWaits: {
      pendingSignals: 8,
      pendingHumanDecisions: 9,
      overdue: 2,
      oldestPendingAgeMs: 60_000,
      rejectedDeliveries: 3,
      capped: true,
    },
  },
} as DashboardSystemPage;

describe("system health counters", () => {
  it("shows orchestration pressure with task and human-wait drill-downs", async () => {
    const { SystemKpiList } = await import("./dashboard.js");
    const html = renderToStaticMarkup(
      createElement(
        MantineProvider,
        null,
        createElement(SystemKpiList, { data: systemPage, navigate: () => undefined }),
      ),
    );

    expect(html).toContain("Blocked dependencies");
    expect(html).toContain("7 pending edges");
    expect(html).toContain("2 failed resolutions");
    expect(html).toContain("View blocked tasks");
    expect(html).toContain("Waiting parents");
    expect(html).toContain("4 pending children");
    expect(html).toContain("6 unjoined results");
    expect(html).toContain("Pending external waits");
    expect(html).toContain("8 signals");
    expect(html).toContain("9 human decisions");
    expect(html).toContain("2 overdue");
    expect(html).toContain("3 rejected deliveries/24h");
    expect(html).toContain("Review waiting tasks");
    expect(html).toContain("Counts reached the scan limit");
  });

  it("explains overdue external waits beside a human-wait drill-down", async () => {
    const { ExternalWaitAlert } = await import("./dashboard.js");
    const html = renderToStaticMarkup(
      createElement(
        MantineProvider,
        null,
        createElement(ExternalWaitAlert, {
          externalWaits: systemPage.kpis.externalWaits,
          navigate: () => undefined,
        }),
      ),
    );

    expect(html).toContain("External waits are overdue");
    expect(html).toContain("A signal or human decision passed its deadline");
    expect(html).toContain("Review waiting tasks");
  });

  it("shows ready age per priority so lower lanes cannot starve invisibly", async () => {
    const { QueuePressure } = await import("./dashboard.js");
    const html = renderToStaticMarkup(
      createElement(
        MantineProvider,
        null,
        createElement(QueuePressure, { data: systemPage, navigate: () => undefined }),
      ),
    );

    expect(html).toContain("Ready by priority");
    expect(html).toContain("P90");
    expect(html).toContain("2 ready");
    expect(html).toContain("P0");
    expect(html).toContain("oldest 2 min");
  });
});
