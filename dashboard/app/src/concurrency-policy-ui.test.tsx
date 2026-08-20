import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { describe, expect, it } from "vitest";
import type {
  DashboardConcurrencyPolicySummary,
  DashboardJobDetail,
  DashboardManagedQueueRow,
  DashboardQueuesPage,
  DashboardRateLimitPolicySummary,
  DashboardSystemPage,
} from "@workhorse-js/dashboard-server/wire";
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
    utilizationKnown: true,
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
    rateLimitPolicy: null,
    ...overrides,
  };
}

function queuesPage(overrides: Partial<DashboardQueuesPage> = {}): DashboardQueuesPage {
  return {
    capturedAt: "2026-08-11T12:00:00.000Z",
    queues: [queueRow()],
    concurrencyPoliciesCapped: false,
    rateLimitPoliciesCapped: false,
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

describe("queues page rate-limit columns", () => {
  it("shows sustained, burst, per-key, and current throttling as separate facts", async () => {
    const { QueuesPage } = await import("./dashboard.js");
    const rateLimitPolicy: DashboardRateLimitPolicySummary = {
      namespace: "demo",
      rate: { limit: 12, intervalMs: 60_000, burst: 3 },
      perKey: { limit: 2, intervalMs: 1_000, burst: 1 },
      availableTokens: 0.25,
      throttledReady: 4,
      throttledKeys: 2,
      nextEligibleAt: "2026-08-11T12:00:01.000Z",
    };
    const html = renderQueues(queuesPage({ queues: [queueRow({ rateLimitPolicy })] }), QueuesPage);

    expect(html).toContain(">Start rate<");
    expect(html).toContain(">Throttled<");
    expect(html).toContain("12/1m · burst 3");
    expect(html).toContain("2/1s · burst 1 per key");
    expect(html).toContain("4 · 2 keys");
    expect(html).toContain("The earliest can start at 2026-08-11T12:00:01.000Z");
    expect(html).toContain("the most idle capacity Workhorse retains");
    expect(html).not.toContain("the most idle capacity PostgreSQL retains");
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
    expect(described?.summary).toBe("in use 6 of 8 · per key 2 · 1 key full · 3+ ready blocked");
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

  it("states the ceiling only when the queue's utilization was never measured", () => {
    // `Queue.health()` measures a bounded number of policies. Past that bound the ceiling is still
    // exact, so the line keeps it and drops every count rather than reporting zeroes as idleness.
    const described = describeTaskConcurrency(
      job({
        runtimeState: "active",
        concurrencyKey: "tenant-a",
        concurrencyPolicy: policy({
          maxActive: 7,
          maxActivePerKey: 3,
          utilizationKnown: false,
          active: 0,
          available: 0,
          blockedReady: 0,
          saturatedKeys: 0,
          highestKeyActive: 0,
        }),
      }),
    );
    expect(described?.utilizationKnown).toBe(false);
    expect(described?.basis).toBe("live");
    expect(described?.summary).toBe("queue limit 7 · per key 3");
    expect(described?.summary).not.toContain("active");
    expect(described?.summary).not.toContain("blocked");
    expect(described?.title).toContain("at most 7 tasks");
    expect(described?.title).toContain("at most 3 tasks per concurrency key");
    expect(described?.title).toContain("competes for its key's capacity as well");
    expect(described?.title).toContain("in use now is unknown");
    expect(described?.title).toContain("this queue fell outside that sample");
    // None of the zeroed placeholders may surface as a claim about the queue.
    expect(described?.title).not.toContain("busiest key");
    expect(described?.title).not.toContain("leaving 0");
    expect(described?.title).not.toContain("0 are active");
  });

  it("keeps unmeasured wording future-facing for a scheduled task without a key", () => {
    const described = describeTaskConcurrency(
      job({
        runtimeState: "scheduled",
        concurrencyPolicy: policy({ maxActive: 1, maxActivePerKey: null, utilizationKnown: false }),
      }),
    );
    expect(described?.utilizationKnown).toBe(false);
    expect(described?.basis).toBe("pending");
    expect(described?.summary).toBe("queue limit 1");
    expect(described?.title).toContain("will enter this budget when it becomes ready");
    expect(described?.title).toContain("at most 1 task");
    expect(described?.title).toContain("will consume queue capacity only");
    expect(described?.title).toContain("does not limit tasks by concurrency key");
    expect(described?.title).not.toContain("This task competes");
  });

  it("does not claim keyed competition for an unmeasured queue with keyed admission off", () => {
    const described = describeTaskConcurrency(
      job({
        runtimeState: "ready",
        concurrencyKey: "tenant-a",
        concurrencyPolicy: policy({ maxActivePerKey: null, utilizationKnown: false }),
      }),
    );
    expect(described?.title).toContain("does not limit tasks by key");
    expect(described?.title).not.toContain("competes for its key's capacity");
  });

  it("reports measured utilization as known so the line is not marked bounded", () => {
    expect(
      describeTaskConcurrency(job({ runtimeState: "ready", concurrencyPolicy: policy() }))
        ?.utilizationKnown,
    ).toBe(true);
    // A settled line makes no utilization claim at all, so it is never marked bounded either.
    expect(
      describeTaskConcurrency(job({ runtimeState: null, concurrencyPolicy: policy() }))
        ?.utilizationKnown,
    ).toBe(true);
    expect(
      describeTaskConcurrency(job({ runtimeState: "ready", concurrencyKey: "tenant-a" }))
        ?.utilizationKnown,
    ).toBe(true);
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
    // Live counts are dropped: a finished task holds no slot, so `in use 6 of 8` would mislead.
    expect(described?.summary).toBe("queue limit 8 · per key 2");
    expect(described?.basisLabel).toBe("queue policy now");
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
    expect(described?.summary).toBe("queue limit 1");
    expect(described?.title).toContain("currently admits at most 1 task");
    expect(described?.title).toContain("does not limit tasks by concurrency key");
  });

  it("tells a terminal task with a key that its queue has no limit now", () => {
    const described = describeTaskConcurrency(
      job({ runtimeState: null, concurrencyKey: "tenant-a", concurrencyPolicy: null }),
    );
    expect(described?.summary).toBe("no queue limit");
    expect(described?.basisLabel).toBe("queue policy now");
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
    expect(html).toContain("in use 4 of 10");
    // The key badge carries its own explanation, so assistive technology hears why it never
    // changes rather than only hearing the raw key echoed back.
    expect(html).toContain("The key is part of the task and never changes");
    expect(html).toContain('aria-label="This task was enqueued with concurrency key tenant-a');
    expect(html).not.toContain("queue policy now");
    expect(html).not.toContain("usage not measured");
  });

  it("visibly labels a scheduled task as entering the budget later", async () => {
    const { ConcurrencyPolicyLine } = await import("./dashboard.js");
    const html = renderToStaticMarkup(
      createElement(
        MantineProvider,
        null,
        createElement(ConcurrencyPolicyLine, {
          job: job({
            runtimeState: "scheduled",
            concurrencyPolicy: policy(),
          }) as unknown as DashboardJobDetail,
        }),
      ),
    );
    // A scheduled task holds no slot, so the marker is visible rather than tooltip-only.
    expect(html).toContain("budget when ready");
    expect(html).toContain("will enter this budget when it becomes ready");
  });

  it("marks an unmeasured queue's line and shows no fabricated counts", async () => {
    const { ConcurrencyPolicyLine } = await import("./dashboard.js");
    const html = renderToStaticMarkup(
      createElement(
        MantineProvider,
        null,
        createElement(ConcurrencyPolicyLine, {
          job: job({
            runtimeState: "ready",
            concurrencyKey: "tenant-a",
            concurrencyPolicy: policy({
              maxActive: 7,
              maxActivePerKey: 3,
              utilizationKnown: false,
              active: 0,
              available: 0,
            }),
          }) as unknown as DashboardJobDetail,
        }),
      ),
    );
    expect(html).toContain("queue limit 7 · per key 3");
    expect(html).toContain("usage not measured");
    expect(html).toContain("this queue fell outside that sample");
    expect(html).not.toContain("0 of 7 active");
    expect(html).not.toContain("in use 4 of 10");
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
    expect(html).toContain("The key is part of the task and never changes");
    expect(html).toContain("queue policy now");
    expect(html).toContain("queue limit 10 · per key 2");
    expect(html).not.toContain("in use 4 of 10");
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
            priorityBacklog: [],
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
    expect(html).toContain(">Admission<");
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
