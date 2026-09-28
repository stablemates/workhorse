import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { describe, expect, it } from "vitest";
import type {
  DashboardManagedQueueRow,
  DashboardQueuesPage,
} from "@stablemates/workhorse-dashboard-server/wire";
import { describeQueueTier } from "./queue-tier.js";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  },
});

function queueRow(overrides: Partial<DashboardManagedQueueRow> = {}): DashboardManagedQueueRow {
  return {
    queue: "mail",
    paused: false,
    scheduled: 0,
    ready: 0,
    active: 0,
    succeeded: 0,
    failed: 0,
    canceled: 0,
    terminalCountsApproximate: false,
    concurrencyPolicy: null,
    rateLimitPolicy: null,
    tier: "full",
    recordAttempts: false,
    recordClaims: false,
    ...overrides,
  };
}

function queuesPage(queues: DashboardManagedQueueRow[]): DashboardQueuesPage {
  return {
    capturedAt: "2026-09-27T12:00:00.000Z",
    queues,
    concurrencyPoliciesCapped: false,
    rateLimitPoliciesCapped: false,
    budgets: [],
    budgetsCapped: false,
  };
}

async function renderQueues(data: DashboardQueuesPage): Promise<string> {
  const { QueuesPage } = await import("./dashboard.js");
  return renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(QueuesPage as never, {
        data,
        togglingQueue: null,
        purgingQueue: null,
        confirmingQueue: null,
        setQueuePaused: () => undefined,
        setConfirmingQueue: () => undefined,
        purgeQueue: () => undefined,
      }),
    ),
  );
}

describe("queue tier text", () => {
  it("names the full tier without a history line", () => {
    const tier = describeQueueTier(queueRow({ tier: "full" }));
    expect(tier.label).toBe("Full");
    expect(tier.historyLabel).toBeNull();
    expect(tier.title).toContain("records every attempt and claim");
  });

  it("says a fast-tier queue with both settings off keeps no history", () => {
    const tier = describeQueueTier(queueRow({ tier: "fast" }));
    expect(tier.label).toBe("Fast");
    expect(tier.historyLabel).toBe("No history");
    expect(tier.title).toContain("keeps no attempt history");
  });

  it("lists the history a fast-tier queue records", () => {
    expect(describeQueueTier(queueRow({ tier: "fast", recordAttempts: true })).historyLabel).toBe(
      "Records attempts",
    );
    expect(describeQueueTier(queueRow({ tier: "fast", recordClaims: true })).historyLabel).toBe(
      "Records claims",
    );
    const both = describeQueueTier(
      queueRow({ tier: "fast", recordAttempts: true, recordClaims: true }),
    );
    expect(both.historyLabel).toBe("Records attempts, claims");
    expect(both.title).toContain("records attempts and claims");
  });

  it("does not guess a tier the installed schema does not report", () => {
    const tier = describeQueueTier({});
    expect(tier.label).toBe("—");
    expect(tier.historyLabel).toBeNull();
    expect(tier.title).toContain("does not report queue tiers");
  });
});

describe("queues page tier column", () => {
  it("shows each queue's tier and a fast queue's history", async () => {
    const markup = await renderQueues(
      queuesPage([
        queueRow({ queue: "mail", tier: "full" }),
        queueRow({ queue: "events", tier: "fast", recordClaims: true }),
      ]),
    );
    expect(markup).toContain(">Tier<");
    expect(markup).toContain('aria-label="Tier: Full tier: Workhorse records every attempt');
    expect(markup).toContain(">Fast<");
    expect(markup).toContain(">Records claims<");
  });

  it("renders a dash when the schema predates tier reporting", async () => {
    const { tier: _tier, recordAttempts: _attempts, recordClaims: _claims, ...legacy } = queueRow();
    const markup = await renderQueues(queuesPage([legacy]));
    expect(markup).toContain("does not report queue tiers");
  });
});
