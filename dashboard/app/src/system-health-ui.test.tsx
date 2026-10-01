import { MantineProvider } from "@mantine/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DashboardSystemPage } from "@stablemates/workhorse-dashboard-server/wire";
import type { QueueHealthReason } from "@stablemates/workhorse";
import { SystemHealthChecks } from "./components/system-health-checks.js";

Object.defineProperty(globalThis, "localStorage", {
  value: { getItem: () => null, setItem: () => undefined },
});

const systemPage: DashboardSystemPage = {
  capturedAt: "2026-09-29T12:00:00.000Z",
  window: "1h",
  windowSeconds: 3_600,
  status: { level: "healthy", reasons: [] },
  pausedQueues: [],
  outcomes: [],
  retryStorm: { buckets: [], topTypes: [] },
  failingTypes: [],
  integrity: {
    dueButUnpromoted: 0,
    partitions: [],
    defaultEventRows: 0,
    defaultAttemptRows: 0,
    retention: {
      policyUpdatedAt: "2026-09-29T12:00:00.000Z",
      categories: [],
      maxLagMs: null,
      maxLagCategory: null,
      oldestRetainedAt: null,
      oldestRetainedCategory: null,
      eligibleHistoryPartitions: { taskEvents: 0, attemptHistory: 0 },
      defaultHistoryRows: { taskEvents: 0, attemptHistory: 0 },
      defaultHistoryRowsCapped: { taskEvents: false, attemptHistory: false },
    },
    storage: {
      rollup: {
        rolledUpThrough: "2026-09-29T11:59:00.000Z",
        lagMs: 60_000,
        lastRunAt: "2026-09-29T12:00:00.000Z",
        buckets: 0,
        oldestBucketAt: null,
        newestBucketAt: null,
        stalled: false,
      },
      relations: [],
      totalBytes: 0,
    },
  },
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
  budgets: [],
  budgetsCapped: false,
  kpis: {
    drain: { enqueuedPerMinute: 1, completedPerMinute: 2, netPerMinute: 1 },
    backlog: { ready: 3, oldestReadyMs: 4_000 },
    errorRate: { current: 0, previous: 0, delta: 0 },
    queueWait: { p50Ms: 10, p95Ms: 20, p99Ms: 30 },
    retry: { backoff: 4, dueSoon: 1, buckets: [] },
    lease: { active: 2, expired: 0, expiringSoon: 1, recovered: 1 },
    dependencies: {
      blockedTasks: 5,
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
};

function renderChecks(reasons: QueueHealthReason[]): string {
  return renderToStaticMarkup(
    createElement(MantineProvider, null, createElement(SystemHealthChecks, { reasons })),
  );
}

describe("individual system health checks", () => {
  it("shows every check when none needs attention", () => {
    const html = renderChecks([]);
    expect(html.match(/<li\b/g)).toHaveLength(13);
    expect(html.match(/>Passing<\/span>/g)).toHaveLength(13);
    expect(html).toContain("Worker leases");
    expect(html).toContain("Retention cleanup");
    expect(html).toContain("Rate limits");
    expect(html).toContain("Shared budgets");
    expect(html).not.toContain("All checks pass.");
  });

  it("shows all failures first with separate severities and resolution links", () => {
    const html = renderChecks([
      {
        code: "retention-lag",
        severity: "degraded",
        observed: 90_000_000,
        budget: 21_600_000,
        category: "taskEvents",
      },
      { code: "expired-leases", severity: "critical", observed: 1, budget: 0 },
      { code: "overdue-deadlines", severity: "critical", observed: 2, budget: 0 },
      { code: "overdue-execution-timeouts", severity: "critical", observed: 3, budget: 0 },
      { code: "missing-history-partitions", severity: "critical", observed: 4, budget: 0 },
    ]);
    expect(html.match(/<li\b/g)).toHaveLength(13);
    expect(html.match(/>Critical<\/span>/g)).toHaveLength(4);
    expect(html.match(/>Degraded<\/span>/g)).toHaveLength(1);
    expect(html).toContain("Tasks are past their deadlines");
    expect(html).toContain("Attempts are past their execution limits");
    expect(html).toContain("Daily history storage is missing");
    expect(html).toContain("Retention cleanup is late for task events");
    expect(html).toContain("check your worker processes");
    expect(html).toContain('href="https://workhorse.run/docs/maintenance"');
    expect(html.indexOf("Daily history partitions")).toBeLessThan(
      html.indexOf("Retention cleanup"),
    );
    expect(html.indexOf("Retention cleanup")).toBeLessThan(html.indexOf("External waits"));
  });

  it("keeps every queue's admission controls informational while a real check is degraded", () => {
    const html = renderChecks([
      {
        code: "rate-limit-throttled",
        severity: "degraded",
        observed: 4,
        budget: 0,
        queue: "payments",
      },
      {
        code: "rate-limit-throttled",
        severity: "degraded",
        observed: 12_500,
        budget: 0,
        queue: "emails",
      },
      {
        code: "concurrency-blocked",
        severity: "degraded",
        observed: 3,
        budget: 0,
        queue: "payments",
      },
      {
        code: "budget-blocked",
        severity: "degraded",
        observed: 5,
        budget: 0,
        budgetName: "vendor-api",
      },
      { code: "rollup-stalled", severity: "degraded", observed: 7_200_000, budget: 1_800_000 },
    ]);
    expect(html.match(/>Throttling<\/span>/g)).toHaveLength(1);
    expect(html.match(/>Limiting<\/span>/g)).toHaveLength(2);
    expect(html.match(/>Degraded<\/span>/g)).toHaveLength(1);
    expect(html).toContain(
      "Queue <strong>payments</strong> has 4+ ready tasks waiting for rate-limit tokens",
    );
    expect(html).toContain(
      "Queue <strong>emails</strong> has 12,500+ ready tasks waiting for rate-limit tokens",
    );
    expect(html).toContain("Budget <strong>vendor-api</strong> holds 5+ ready tasks across queues");
    expect(html).toContain("The statistics summary is behind");
    expect(html).not.toContain("Raise the rate");
    expect(html).not.toContain("Raise the limit");
    expect(html).not.toContain("Raise the budget");
  });

  it("scopes the time range to activity and omits the aggregate verdict", async () => {
    const { SystemPage } = await import("./pages/overview.js");
    const html = renderToStaticMarkup(
      createElement(
        MantineProvider,
        null,
        createElement(SystemPage, {
          data: {
            ...systemPage,
            status: {
              level: "degraded",
              reasons: [
                {
                  code: "rate-limit-throttled",
                  severity: "degraded",
                  observed: 4,
                  budget: 0,
                  queue: "demo",
                },
              ],
            },
          },
          setWindow: () => undefined,
          navigate: () => undefined,
        }),
      ),
    );
    expect(html).toContain("Health checks");
    expect(html).toContain(">Throttling</span>");
    expect(html).not.toContain(">Expected</span>");
    expect(html).not.toContain(">degraded</span>");
    expect(html).not.toContain(">Degraded</span>");
    expect(html).not.toContain("All checks pass.");

    const activity = html.match(
      /<section[^>]*aria-labelledby="system-activity-title"[^>]*>([\s\S]*?)<\/section>/,
    )?.[1];
    const current = html.match(
      /<section[^>]*aria-labelledby="system-current-title"[^>]*>([\s\S]*?)<\/section>/,
    )?.[1];
    expect(activity).toBeDefined();
    expect(current).toBeDefined();
    for (const label of [
      "Full + fast tiers",
      "Activity time range",
      "Completion rate",
      "Failed attempts",
      "Wait for first claim",
      "Recovered leases",
      "Task activity",
      "Queue activity",
      "Added/min",
      "Finished/min",
      "Task types with failures",
    ]) {
      expect(activity).toContain(label);
      expect(current).not.toContain(label);
    }
    for (const label of [
      "Ready backlog",
      "Retries in backoff",
      "Expired leases",
      "Queue backlog",
      "Upcoming retries",
      "Background maintenance",
      "Storage",
    ]) {
      expect(current).toContain(label);
      expect(activity).not.toContain(label);
    }
    expect(activity).not.toContain("Health checks");
    expect(html.indexOf("Health checks")).toBeLessThan(html.indexOf("Activity over time"));
  });
});

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
    expect(html).not.toContain("Added/min");
    expect(html).not.toContain("Finished/min");
  });
});
