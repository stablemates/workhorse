import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { describe, expect, it } from "vitest";
import type {
  DashboardConcurrencyPolicySummary,
  DashboardJobDetail,
  DashboardManagedQueueRow,
  DashboardQueuesPage,
  DashboardSystemPage,
} from "./model.js";
import {
  concurrencyCappedFootnote,
  describeConcurrencyBlocked,
  describeConcurrencyKeys,
  describeConcurrencyLimit,
  describeTaskConcurrency,
} from "./concurrency-policy.js";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  },
});

function policy(
  overrides: Partial<DashboardConcurrencyPolicySummary> = {},
): DashboardConcurrencyPolicySummary {
  return {
    namespace: "workers",
    maxActive: 10,
    active: 4,
    available: 6,
    blockedReady: 0,
    maxActivePerKey: null,
    saturatedKeys: 0,
    highestKeyActive: 0,
    ...overrides,
  };
}

function queueRow(overrides: Partial<DashboardManagedQueueRow> = {}): DashboardManagedQueueRow {
  return {
    queue: "mail",
    paused: false,
    scheduled: 1,
    ready: 7,
    active: 4,
    succeeded: 20,
    failed: 0,
    canceled: 0,
    terminalCountsApproximate: false,
    concurrencyPolicy: policy(),
    ...overrides,
  };
}

function queuesPage(overrides: Partial<DashboardQueuesPage> = {}): DashboardQueuesPage {
  return {
    capturedAt: "2026-08-11T12:00:00.000Z",
    queues: [queueRow()],
    concurrencyPoliciesCapped: false,
    ...overrides,
  };
}

function renderQueues(data: DashboardQueuesPage, QueuesPage: unknown): string {
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

function renderQueuePressure(
  data: Pick<DashboardSystemPage, "queues" | "concurrencyPoliciesCapped">,
  QueuePressure: unknown,
): string {
  return renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(QueuePressure as never, {
        data: data as DashboardSystemPage,
        navigate: () => undefined,
      }),
    ),
  );
}

function job(overrides: {
  runtimeState: string | null;
  concurrencyKey?: string | null;
  concurrencyPolicy?: DashboardConcurrencyPolicySummary | null;
}) {
  return {
    identity: {
      state: overrides.runtimeState ?? "succeeded",
      concurrencyKey: overrides.concurrencyKey ?? null,
    },
    concurrencyPolicy: overrides.concurrencyPolicy ?? null,
    current: {
      runtime: overrides.runtimeState === null ? null : { state: overrides.runtimeState },
    },
  };
}

describe("concurrency limit text", () => {
  it("reads active out of the fleet-wide budget and names the fleet in its tooltip", () => {
    const limit = describeConcurrencyLimit(policy({ active: 4, maxActive: 10, available: 6 }));
    expect(limit.label).toBe("4 / 10");
    expect(limit.title).toContain("Fleet-wide budget");
    expect(limit.title).toContain("across every worker sharing this database");
    expect(limit.title).toContain("leaving 6");
  });

  it("says a queue without a policy is limited only by worker slots", () => {
    const limit = describeConcurrencyLimit(null);
    expect(limit.label).toBe("—");
    expect(limit.title).toContain("no fleet-wide limit");
    expect(limit.title).toContain("worker slots");
  });

  it("keeps the per-key state compact and reports full keys only when some are full", () => {
    expect(describeConcurrencyKeys(policy({ maxActivePerKey: 2 })).label).toBe("Per key 2");
    const saturated = describeConcurrencyKeys(
      policy({ maxActivePerKey: 2, saturatedKeys: 3, highestKeyActive: 2 }),
    );
    expect(saturated.label).toBe("Per key 2 · 3 keys full");
    expect(saturated.saturated).toBe(true);
    expect(saturated.title).toContain("busiest key is running 2");
  });

  it("treats a null per-key limit as keyed admission being off rather than a limit of zero", () => {
    const keys = describeConcurrencyKeys(policy({ maxActivePerKey: null }));
    expect(keys.label).toBeNull();
    expect(keys.saturated).toBe(false);
    expect(keys.title).toContain("does not limit tasks by concurrency key");
    expect(keys.title).not.toContain("0");
  });

  it("describes blocked ready work as a lower bound and flags it only when positive", () => {
    const none = describeConcurrencyBlocked(policy({ blockedReady: 0 }));
    expect(none.label).toBe("0");
    expect(none.blocking).toBe(false);
    expect(none.title).toContain("lower bound");

    const blocking = describeConcurrencyBlocked(policy({ blockedReady: 5, available: 0 }));
    expect(blocking.label).toBe("5");
    expect(blocking.blocking).toBe(true);
    expect(blocking.title).toContain("At least 5 ready tasks");
    expect(blocking.title).toContain("lower bound");
  });

  it("uses singular wording for a single blocked task", () => {
    expect(describeConcurrencyBlocked(policy({ blockedReady: 1 })).title).toContain(
      "At least 1 ready task cannot start",
    );
  });
});

describe("queues page concurrency columns", () => {
  it("shows the limit, per-key state, and blocked count with accessible explanations", async () => {
    const { QueuesPage } = await import("./dashboard.js");
    const html = renderQueues(
      queuesPage({
        queues: [
          queueRow({
            concurrencyPolicy: policy({
              active: 8,
              maxActive: 8,
              available: 0,
              blockedReady: 12,
              maxActivePerKey: 2,
              saturatedKeys: 3,
              highestKeyActive: 2,
            }),
          }),
        ],
      }),
      QueuesPage,
    );

    expect(html).toContain(">Limit<");
    expect(html).toContain(">Blocked<");
    expect(html).toContain("8 / 8");
    expect(html).toContain("Per key 2 · 3 keys full");
    expect(html).toContain(">12<");
    expect(html).toContain('aria-label="Limit: Fleet-wide budget');
    expect(html).toContain('aria-label="Blocked: At least 12 ready tasks');
    // Blocked work is emphasised amber only while it is positive.
    expect(html).toContain("yellow");
  });

  it("keeps the pause control separate from the limit columns", async () => {
    const { QueuesPage } = await import("./dashboard.js");
    const html = renderQueues(queuesPage(), QueuesPage);
    // Pausing stops new claims entirely; the limit only budgets them. They stay distinct controls.
    expect(html).toContain('aria-label="Pause mail"');
    expect(html).toContain("Worker slots limit one process instead, and pausing is separate.");
    expect(html).not.toContain('aria-label="Limit: Paused');
  });

  it("does not colour a zero blocked count and shows an em dash without a policy", async () => {
    const { QueuesPage } = await import("./dashboard.js");
    const html = renderQueues(
      queuesPage({
        queues: [queueRow({ concurrencyPolicy: null })],
      }),
      QueuesPage,
    );
    expect(html).toContain('aria-label="Limit: This queue has no fleet-wide limit');
    expect(html).not.toContain("Per key");
  });

  it("footnotes a capped read only when the read model reports one", async () => {
    const { QueuesPage } = await import("./dashboard.js");
    expect(renderQueues(queuesPage(), QueuesPage)).not.toContain(concurrencyCappedFootnote);
    expect(renderQueues(queuesPage({ concurrencyPoliciesCapped: true }), QueuesPage)).toContain(
      "bounded sample",
    );
  });
});

describe("task drawer concurrency line", () => {
  it("describes the effective queue and per-key budget for an active task", () => {
    const described = describeTaskConcurrency(
      job({
        runtimeState: "active",
        concurrencyKey: "tenant-a",
        concurrencyPolicy: policy({
          active: 6,
          maxActive: 8,
          available: 2,
          blockedReady: 3,
          maxActivePerKey: 2,
          saturatedKeys: 1,
          highestKeyActive: 2,
        }),
      }),
    );
    expect(described).not.toBeNull();
    expect(described?.concurrencyKey).toBe("tenant-a");
    expect(described?.summary).toBe("6 of 8 active · per key 2 · 1 key full · 3+ ready blocked");
    expect(described?.title).toContain("Fleet-wide budget");
    expect(described?.title).toContain("competes for its key's capacity");
    expect(described?.basis).toBe("live");
  });

  it("frames the queue limits as fleet-wide rather than per worker", () => {
    const described = describeTaskConcurrency(
      job({ runtimeState: "active", concurrencyPolicy: policy() }),
    );
    expect(described?.title).toContain("across every worker sharing this database");
  });

  it("keeps a terminal task's immutable key and marks the policy as the queue's current one", () => {
    const described = describeTaskConcurrency(
      job({
        runtimeState: null,
        concurrencyKey: "tenant-a",
        concurrencyPolicy: policy({ maxActive: 8, active: 6, maxActivePerKey: 2 }),
      }),
    );
    expect(described?.concurrencyKey).toBe("tenant-a");
    expect(described?.basis).toBe("current");
    // Live counts are dropped: a finished task holds no slot, so `6 of 8 active` would mislead.
    expect(described?.summary).toBe("queue now allows 8 at once · 2 per key");
    expect(described?.summary).not.toContain("active");
    expect(described?.title).toContain("no longer competing");
    expect(described?.title).toContain("currently admits at most 8");
    expect(described?.title).toContain("may differ from the limits in force while this task ran");
    // The key is the task's own fact and is described as such, never as queue state.
    expect(described?.keyTitle).toContain("never changes");
  });

  it("gives a terminal task without a key the queue's current limits anyway", () => {
    const described = describeTaskConcurrency(
      job({ runtimeState: null, concurrencyPolicy: policy({ maxActive: 1 }) }),
    );
    expect(described?.concurrencyKey).toBeNull();
    expect(described?.summary).toBe("queue now allows 1 at once");
    expect(described?.title).toContain("currently admits at most 1 task");
    expect(described?.title).toContain("does not limit tasks by concurrency key");
  });

  it("tells a terminal task with a key that its queue has no limit now", () => {
    const described = describeTaskConcurrency(
      job({ runtimeState: null, concurrencyKey: "tenant-a", concurrencyPolicy: null }),
    );
    expect(described?.summary).toBe("queue has no limit now");
    expect(described?.title).toContain("no fleet-wide limit");
    expect(described?.title).toContain("may differ from the limits in force while this task ran");
  });

  it("shows nothing for a terminal task with neither a key nor a current policy", () => {
    expect(describeTaskConcurrency(job({ runtimeState: null }))).toBeNull();
  });

  it("reads a scheduled task as the budget it will enter rather than one it holds", () => {
    const described = describeTaskConcurrency(
      job({
        runtimeState: "scheduled",
        concurrencyKey: "tenant-a",
        concurrencyPolicy: policy({ maxActivePerKey: 2 }),
      }),
    );
    expect(described?.basis).toBe("pending");
    expect(described?.title).toContain("will enter this budget when it becomes ready");
    expect(described?.title).toContain("will compete for its key's capacity");
    expect(described?.title).not.toContain("This task competes");
    expect(described?.title).not.toContain("This task consumes");
    expect(described?.keyTitle).not.toContain("competes");
  });

  it("keeps a scheduled keyless task's capacity wording future-facing", () => {
    const described = describeTaskConcurrency(
      job({ runtimeState: "scheduled", concurrencyPolicy: policy() }),
    );
    expect(described?.title).toContain("will consume queue capacity only");
    expect(described?.title).not.toContain("This task consumes");
    expect(described?.keyTitle).not.toContain("competes");
  });

  it("says a keyless task consumes queue capacity only", () => {
    const described = describeTaskConcurrency(
      job({ runtimeState: "ready", concurrencyPolicy: policy() }),
    );
    expect(described?.concurrencyKey).toBeNull();
    expect(described?.title).toContain("no concurrency key");
  });

  it("does not claim keyed competition when per-key admission is disabled", () => {
    const described = describeTaskConcurrency(
      job({
        runtimeState: "ready",
        concurrencyKey: "tenant-a",
        concurrencyPolicy: policy({ maxActivePerKey: null }),
      }),
    );
    expect(described?.title).toContain("does not limit tasks by key");
    expect(described?.title).not.toContain("competes for its key's capacity");
  });

  it("shows nothing when the task has neither a key nor a queue policy", () => {
    expect(describeTaskConcurrency(job({ runtimeState: "ready" }))).toBeNull();
  });

  it("renders the key and the budget summary in the drawer", async () => {
    const { ConcurrencyPolicyLine } = await import("./dashboard.js");
    const html = renderToStaticMarkup(
      createElement(
        MantineProvider,
        null,
        createElement(ConcurrencyPolicyLine, {
          job: job({
            runtimeState: "ready",
            concurrencyKey: "tenant-a",
            concurrencyPolicy: policy({ maxActivePerKey: 2 }),
          }) as unknown as DashboardJobDetail,
        }),
      ),
    );
    expect(html).toContain("Concurrency");
    expect(html).toContain("tenant-a");
    expect(html).toContain("4 of 10 active");
    expect(html).toContain('aria-label="Concurrency key tenant-a"');
    expect(html).not.toContain("queue policy now");
  });

  it("renders a finished task's key beside the queue's current limits", async () => {
    const { ConcurrencyPolicyLine } = await import("./dashboard.js");
    const html = renderToStaticMarkup(
      createElement(
        MantineProvider,
        null,
        createElement(ConcurrencyPolicyLine, {
          job: job({
            runtimeState: null,
            concurrencyKey: "tenant-a",
            concurrencyPolicy: policy({ maxActivePerKey: 2 }),
          }) as unknown as DashboardJobDetail,
        }),
      ),
    );
    expect(html).toContain("Concurrency");
    expect(html).toContain('aria-label="Concurrency key tenant-a"');
    expect(html).toContain("queue policy now");
    expect(html).toContain("queue now allows 10 at once · 2 per key");
    expect(html).not.toContain("4 of 10 active");
    expect(html).toContain("may differ from the limits in force while this task ran");
  });

  it("renders nothing when a finished task has neither a key nor a current policy", async () => {
    const { ConcurrencyPolicyLine } = await import("./dashboard.js");
    const html = renderToStaticMarkup(
      createElement(
        MantineProvider,
        null,
        createElement(ConcurrencyPolicyLine, {
          job: job({ runtimeState: null }) as unknown as DashboardJobDetail,
        }),
      ),
    );
    expect(html).not.toContain("Concurrency");
  });
});

describe("system queue pressure concurrency column", () => {
  it("shows a fleet-wide limit with blocked-ready context", async () => {
    const { QueuePressure } = await import("./dashboard.js");
    const html = renderQueuePressure(
      {
        queues: [
          {
            queue: "mail",
            paused: false,
            ready: 7,
            oldestReadyMs: 1_000,
            dueSoon: 0,
            active: 4,
            retrying: 0,
            enqueuedPerMinute: 2,
            completedPerMinute: 1,
            concurrencyPolicy: policy({
              active: 4,
              maxActive: 4,
              available: 0,
              blockedReady: 3,
            }),
          },
        ],
        concurrencyPoliciesCapped: false,
      },
      QueuePressure,
    );
    expect(html).toContain(">Limit<");
    expect(html).toContain("4 / 4");
    expect(html).toContain("3 blocked");
    expect(html).toContain('aria-label="Blocked: At least 3 ready tasks');
  });

  it("footnotes a capped policy scan", async () => {
    const { QueuePressure } = await import("./dashboard.js");
    const html = renderQueuePressure(
      { queues: [], concurrencyPoliciesCapped: true },
      QueuePressure,
    );
    expect(html).toContain(concurrencyCappedFootnote);
  });
});
