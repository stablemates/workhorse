import { MantineProvider } from "@mantine/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DashboardClient } from "@stablemates/workhorse-dashboard-server";
import type {
  DashboardTaskRow,
  DashboardTasksPage,
} from "@stablemates/workhorse-dashboard-server/wire";
import { DashboardClientContext } from "./core.js";
import { describeRedriveSelection } from "./presentation.js";
import {
  confirmedRedriveBatch,
  redriveSelectionBlocked,
  type RedriveConfirmation,
} from "./redrive-guard.js";
import { parseTaskLocation } from "./task-location.js";

// The page reads stored preferences as it loads.
Object.defineProperty(globalThis, "localStorage", {
  value: { getItem: () => null, setItem: () => undefined },
});

function deadLetter(): DashboardTaskRow {
  return {
    id: "3f1c0c8e-0000-4000-8000-000000000001",
    queue: "billing",
    type: "billing.invoice.issue",
    priority: 0,
    state: "discarded",
    blockedReason: null,
    prerequisiteTaskIds: [],
    attempt: 5,
    maxAttempts: 5,
    retryPolicy: null,
    tags: [],
    keyed: false,
    cancellation: null,
    runAt: null,
    workerId: null,
    lastWorkerId: "worker-1",
    finishedAt: "2026-09-20T12:00:00.000Z",
    errorMessage: "card declined",
    createdAt: "2026-09-20T11:59:00.000Z",
    updatedAt: "2026-09-20T12:00:00.000Z",
    durability: null,
    waitName: null,
    wakeAt: null,
    wait: null,
    signalWait: null,
    humanWait: null,
  };
}

// The rows on screen answer the unfiltered Discarded listing.
const unfiltered = {
  capturedAt: "2026-09-20T12:00:00.000Z",
  canCompleteHumanWait: false,
  filter: "discarded",
  queue: null,
  worker: null,
  taskType: null,
  priority: null,
  sort: "updated",
  tags: [],
  search: null,
  page: 1,
  pageSize: 50,
  count: "exact",
  hasMore: false,
  total: 1,
  tasks: [deadLetter()],
} satisfies DashboardTasksPage;

async function renderTasks({ pending }: { pending: boolean }) {
  const { TasksPage } = await import("./pages/tasks.js");
  const { PagePendingContext } = await import("./pending-results.js");
  const { GraphicalProvider, theme } = await import("./ui.js");
  // The operator has asked for queue=billing. While pending, the rows still answer no queue.
  const taskLocation = parseTaskLocation(
    pending ? "?filter=discarded&queue=billing" : "?filter=discarded",
  );
  return renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(
        GraphicalProvider,
        { document: theme, colorMode: "light" },
        createElement(
          DashboardClientContext.Provider,
          {
            value: {
              taskFacets: async () => ({ queues: [], workers: [], taskTypes: [], tags: [] }),
              redriveDeadLetters: async () => ({ results: [], nextCursor: null }),
            } as unknown as DashboardClient,
          },
          createElement(
            PagePendingContext.Provider,
            { value: pending },
            createElement(TasksPage, {
              data: unfiltered,
              navigate: () => undefined,
              replace: () => undefined,
              taskLocation,
              runDemoTask: null,
              runningDemoTask: null,
              inspectTask: () => undefined,
              taskEventsHref: (id: string) => `/events?task=${id}`,
              runTaskNow: null,
              auditActor: "operator",
              reload: async () => undefined,
              activityPollTick: 0,
              taskCounts: null,
              statusNavigation: { href: (path: string) => path, followLink: () => undefined },
            }),
          ),
        ),
      ),
    ),
  );
}

function redriveButton(html: string): string {
  const match = html.match(/<button[^>]*aria-label="Redrive these dead letters"[^>]*>/);
  if (match === null) throw new Error("The page shows no Redrive button");
  return match[0];
}

describe("batch redrive while new results load", () => {
  it("disables Redrive while the rows answer the previous filters", async () => {
    const button = redriveButton(await renderTasks({ pending: true }));
    expect(button).toMatch(/\sdisabled=""/);
    expect(button).toContain("Wait for the new results");
  });

  it("enables Redrive once the rows answer the filters shown", async () => {
    const button = redriveButton(await renderTasks({ pending: false }));
    expect(button).not.toMatch(/\sdisabled=""/);
    expect(button).toContain('title="Redrive every dead letter"');
  });

  it("states why the listing cannot open a redrive", () => {
    const selection = describeRedriveSelection(unfiltered);
    expect(redriveSelectionBlocked({ selection, shownTasks: 1, pending: true })).toContain(
      "Wait for the new results",
    );
    expect(redriveSelectionBlocked({ selection, shownTasks: 0, pending: false })).toContain(
      "nothing to redrive",
    );
    expect(redriveSelectionBlocked({ selection, shownTasks: 1, pending: false })).toBeNull();
  });
});

function confirmation(view: Parameters<typeof describeRedriveSelection>[0]): RedriveConfirmation {
  return { selection: describeRedriveSelection(view), cursor: null, redriven: 0, running: false };
}

describe("a confirmed batch redrive", () => {
  it("asks for the selection that the dialog showed, not a newer listing", () => {
    const shown = confirmation({ ...unfiltered, queue: "billing" });
    expect(confirmedRedriveBatch(shown, false)).toEqual({
      queue: "billing",
      taskType: null,
      tags: [],
      cursor: null,
      selected: "every dead letter in queue billing",
    });
  });

  it("asks for nothing while new results load", () => {
    expect(confirmedRedriveBatch(confirmation(unfiltered), true)).toBeNull();
  });

  it("asks for nothing while a batch runs, or without a dialog", () => {
    expect(confirmedRedriveBatch({ ...confirmation(unfiltered), running: true }, false)).toBeNull();
    expect(confirmedRedriveBatch(null, false)).toBeNull();
  });

  it("asks for nothing when the selection cannot be redriven", () => {
    expect(confirmedRedriveBatch(confirmation({ ...unfiltered, search: "card" }), false)).toBe(
      null,
    );
  });
});
