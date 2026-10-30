import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { describe, expect, it } from "vitest";
import type {
  DashboardManagedQueueRow,
  DashboardQueuesPage,
} from "@stablemates/workhorse-dashboard-server/wire";
import { describeQueueTier, describeTierSwitch, queueTierActions } from "./queue-tier.js";
import { GraphicalProvider, theme } from "./ui.js";

/** The Graphical controls on this page need their theme provider beside Mantine's. */
function ThemeProviders({ children }: { children: ReactNode }) {
  return createElement(
    MantineProvider,
    null,
    createElement(GraphicalProvider, { document: theme, colorMode: "light" }, children),
  );
}

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
      ThemeProviders,
      null,
      createElement(QueuesPage as never, {
        data,
        togglingQueue: null,
        purgingQueue: null,
        confirmingQueue: null,
        setQueuePaused: () => undefined,
        setConfirmingQueue: () => undefined,
        purgeQueue: () => undefined,
        changingQueue: null,
        tierCapabilities: { canSetTier: true, canSetHistory: true },
        setQueueTier: () => undefined,
        setQueueHistory: () => undefined,
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
    expect(markup).toContain(">. Full tier: Workhorse records every attempt");
    expect(markup).toContain(">Fast<");
    expect(markup).toContain(">Records claims<");
  });

  it("renders a dash when the schema predates tier reporting", async () => {
    const { tier: _tier, recordAttempts: _attempts, recordClaims: _claims, ...legacy } = queueRow();
    const markup = await renderQueues(queuesPage([legacy]));
    expect(markup).toContain("does not report queue tiers");
  });
});

describe("queue tier actions", () => {
  const capable = { canSetTier: true, canSetHistory: true };

  it("offers the other tier and the history of a fast-tier queue", () => {
    const actions = queueTierActions(queueRow({ tier: "fast", recordClaims: true }), capable);
    expect(actions.map((action) => [action.id, action.label, action.unavailable])).toEqual([
      ["tier", "Move to the full tier", null],
      ["recordAttempts", "Record attempts", null],
      ["recordClaims", "Stop recording claims", null],
    ]);
  });

  it("keeps the history actions of a full-tier queue disabled with the reason", () => {
    const [tier, attempts, claims] = queueTierActions(queueRow({ tier: "full" }), capable);
    expect(tier?.label).toBe("Move to the fast tier");
    expect(tier?.unavailable).toBeNull();
    expect(attempts?.unavailable).toContain("records attempts and claims regardless");
    expect(claims?.unavailable).toContain("records attempts and claims regardless");
  });

  it("states that the host cannot change the tier or history", () => {
    const actions = queueTierActions(queueRow({ tier: "fast" }), {
      canSetTier: false,
      canSetHistory: false,
    });
    expect(actions[0]?.unavailable).toBe("This host cannot change the tier of a queue.");
    expect(actions[1]?.unavailable).toBe("This host cannot change the history of a queue.");
  });

  it("disables every action when the schema does not report tiers", () => {
    for (const action of queueTierActions({}, capable)) {
      expect(action.unavailable).toContain("does not report queue tiers");
    }
  });
});

describe("tier switch outcome", () => {
  it("confirms a switch", () => {
    const fast = describeTierSwitch("mail", "fast", "set");
    expect(fast).toMatchObject({ title: "Queue tier changed", tone: "success" });
    expect(fast.message).toContain("mail is on the fast tier");
    expect(describeTierSwitch("mail", "full", "set").message).toContain("full tier");
  });

  it("names the guard that refused a switch", () => {
    const live = describeTierSwitch("mail", "fast", "live_tasks");
    expect(live).toMatchObject({ title: "Queue tier not changed", tone: "failure" });
    expect(live.message).toContain("still holds tasks that are not finished");
    expect(describeTierSwitch("mail", "fast", "concurrency_policy").message).toContain(
      "has a concurrency policy",
    );
    expect(describeTierSwitch("mail", "fast", "rate_limit_policy").message).toContain(
      "has a rate-limit policy",
    );
  });
});

describe("queues page tier menu", () => {
  it("offers one row menu for clear, tier, and history on each row", async () => {
    const markup = await renderQueues(queuesPage([queueRow({ queue: "events", tier: "fast" })]));
    expect(markup).toContain('aria-label="Actions for events: clear, tier, and history"');
    expect(markup).toContain("from the queue&#x27;s row menu");
    // Clear moved into the row menu; the row itself keeps only the pause switch.
    expect(markup).not.toContain(">Clear<");
  });
});

describe("queues page linked row", () => {
  it("reads the queue from the fragment and ignores a malformed fragment", async () => {
    const { queueFromFragment } = await import("./pages/queues.js");
    expect(queueFromFragment("#queue-billing%20jobs")).toBe("billing jobs");
    expect(queueFromFragment("#budgets")).toBeNull();
    expect(queueFromFragment("")).toBeNull();
    expect(queueFromFragment("#%")).toBeNull();
    expect(queueFromFragment("#queue-%E0%A4%A")).toBeNull();
  });

  it("renders the page for the malformed fragment of /queues#%", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { hash: "#%" } },
    });
    try {
      const html = await renderQueues(queuesPage([queueRow({ queue: "mail" })]));
      expect(html).toContain("mail");
    } finally {
      Reflect.deleteProperty(globalThis, "window");
    }
  });
});
