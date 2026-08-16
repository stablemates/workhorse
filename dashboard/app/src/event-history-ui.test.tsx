import { MantineProvider } from "@mantine/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DashboardEventRow, DashboardJobDetail } from "@workhorse/dashboard-server/wire";
import { dashboardJobEventTypes } from "./presentation.js";

Object.defineProperty(globalThis, "localStorage", {
  value: { getItem: () => null, setItem: () => undefined },
});

const newlyPersistedEventTypes = [
  "debounced",
  "debounce_rejected",
  "throttled",
  "dependency_blocked",
  "dependency_released",
  "dependency_failed",
  "dependency_canceled",
  "child_created",
  "child_joined",
  "children_created",
  "children_joined",
  "parent_linked",
  "human_wait_created",
  "human_wait_completed",
  "human_wait_replayed",
  "human_wait_rejected",
] as const;

function jobWithEvents(events: DashboardJobDetail["events"]): DashboardJobDetail {
  return {
    identity: { id: "job-1", type: "example", state: "scheduled" },
    events,
  } as DashboardJobDetail;
}

async function renderExport(
  name: "BoundaryTimeline" | "CoalescingSection",
  job: DashboardJobDetail,
) {
  const dashboard = await import("./dashboard.js");
  const Component = dashboard[name];
  return renderToStaticMarkup(
    createElement(MantineProvider, null, createElement(Component, { job })),
  );
}

describe("dashboard event history", () => {
  it("opens the event task in a new window without replacing the Events page", async () => {
    const { EventDetails } = await import("./dashboard.js");
    const event = {
      id: "event:42",
      kind: "event",
      recordId: "42",
      jobId: "job-123",
      queue: "billing",
      jobType: "invoice.send",
      occurredAt: "2026-08-16T12:00:00.000Z",
      attempt: 1,
      type: "claimed",
      details: null,
      workerId: null,
      fenceToken: null,
      durationMs: null,
      errorMessage: null,
    } satisfies DashboardEventRow;
    const html = renderToStaticMarkup(
      createElement(
        MantineProvider,
        null,
        createElement(EventDetails, {
          event,
          taskLinkHref: (jobId: string) => `/dashboard/tasks?task=${jobId}`,
        }),
      ),
    );

    expect(html).toContain('href="/dashboard/tasks?task=job-123"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('aria-label="Open task job-123 in a new window"');
  });

  it("offers every new lifecycle type as an Events feed filter", () => {
    expect(dashboardJobEventTypes).toEqual(expect.arrayContaining(newlyPersistedEventTypes));
  });

  it("renders known and future event types instead of dropping them", async () => {
    const html = await renderExport(
      "BoundaryTimeline",
      jobWithEvents([
        {
          id: "known",
          attempt: null,
          type: "dependency_blocked",
          details: { prerequisite_job_id: "parent-1" },
          occurredAt: "2026-08-15T12:00:00.000Z",
        },
        {
          id: "future",
          attempt: null,
          type: "future_boundary_added_by_sql",
          details: { reason: "new protocol" },
          occurredAt: "2026-08-15T12:01:00.000Z",
        },
      ]),
    );
    expect(html).toContain("Dependency blocked");
    expect(html).toContain("Future boundary added by sql");
    expect(html).toContain("parent-1");
    expect(html).toContain("new protocol");
  });

  it("attributes operator-initiated boundary events", async () => {
    const html = await renderExport(
      "BoundaryTimeline",
      jobWithEvents([
        {
          id: "cancel-request",
          attempt: 2,
          type: "cancel_requested",
          details: { requested_by: "operator@example.com", reason: "stuck deployment" },
          occurredAt: "2026-08-15T12:00:00.000Z",
        },
      ]),
    );

    expect(html).toContain("operator@example.com");
    expect(html).toContain("stuck deployment");
  });

  it("attributes a finalized cancellation to Workhorse", async () => {
    const html = await renderExport(
      "BoundaryTimeline",
      jobWithEvents([
        {
          id: "canceled",
          attempt: 2,
          type: "canceled",
          details: { source: "acknowledged" },
          occurredAt: "2026-08-15T12:01:00.000Z",
        },
      ]),
    );

    expect(html).toContain("Workhorse recorded");
    expect(html).not.toContain("PostgreSQL recorded");
  });

  it("gives the new Events feed categories meaningful colors", async () => {
    const { eventTypeColor } = await import("./dashboard.js");
    expect(eventTypeColor("dependency_blocked")).toBe("orange");
    expect(eventTypeColor("dependency_released")).toBe("teal");
    expect(eventTypeColor("child_created")).toBe("blue");
    expect(eventTypeColor("human_wait_completed")).toBe("teal");
    expect(eventTypeColor("debounce_rejected")).toBe("orange");
  });

  it("explains debounce replacement using safe key evidence and absorbed counts", async () => {
    const html = await renderExport(
      "CoalescingSection",
      jobWithEvents([
        {
          id: "accepted",
          attempt: null,
          type: "enqueued",
          details: {
            debounce: {
              scope: "search",
              key_digest: "0123456789ab",
              key_length: 18,
              window_ms: 60000,
              schedule: "reset",
              expires_at: "2026-08-15T12:01:00.000Z",
            },
          },
          occurredAt: "2026-08-15T12:00:00.000Z",
        },
        {
          id: "absorbed",
          attempt: null,
          type: "debounced",
          details: {},
          occurredAt: "2026-08-15T12:00:30.000Z",
        },
        {
          id: "rejected",
          attempt: null,
          type: "debounce_rejected",
          details: { reason: "not_pending" },
          occurredAt: "2026-08-15T12:00:45.000Z",
        },
      ]),
    );
    expect(html).toContain("Debounce");
    expect(html).toContain("scope search");
    expect(html).toContain("digest 0123456789ab");
    expect(html).toContain("1 absorbed enqueue");
    expect(html).toContain("1 rejected enqueue");
    expect(html).not.toContain("super-secret");
  });

  it("explains a non-replaceable debounce attempt from its rejection evidence", async () => {
    const html = await renderExport(
      "CoalescingSection",
      jobWithEvents([
        {
          id: "rejected",
          attempt: null,
          type: "debounce_rejected",
          details: {
            reason: "incompatible_key_mode",
            debounce: {
              scope: "search",
              key_digest: "0123456789ab",
              key_length: 18,
              window_ms: 60000,
              schedule: "reset",
            },
          },
          occurredAt: "2026-08-15T12:00:45.000Z",
        },
      ]),
    );
    expect(html).toContain("Debounce");
    expect(html).toContain("scope search");
    expect(html).toContain("0 absorbed enqueues");
    expect(html).toContain("1 rejected enqueue");
  });
});
