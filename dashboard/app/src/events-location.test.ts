import { describe, expect, it } from "vitest";
import { dashboardPageMax } from "@stablemates/workhorse-dashboard-server/wire";
import {
  defaultEventsLocation,
  eventsListingKey,
  eventsLocationHref,
  eventsLocationWithEvent,
  eventsLocationWithoutEvent,
  parseEventsLocation,
} from "./events-location.js";

describe("events location state", () => {
  it("round-trips every shareable filter and the open event", () => {
    const state = parseEventsLocation(
      "?window=24h&from=2026-08-15T12%3A00%3A00.000Z&to=2026-08-16T12%3A00%3A00.000Z&source=attempt&queue=orders&type=order.process&worker=worker-1&q=invoice&task=3f1c0c8e-0000-4000-8000-000000000001&events=failed,timeout&page=3&per=100&event=attempt:018f0000-0000-7000-8000-000000000042&eventTask=018f0000-0000-7000-8000-000000000007",
    );
    expect(state).toEqual({
      window: "24h",
      from: "2026-08-15T12:00:00.000Z",
      to: "2026-08-16T12:00:00.000Z",
      kind: "attempt",
      queue: "orders",
      taskType: "order.process",
      worker: "worker-1",
      search: "invoice",
      taskId: "3f1c0c8e-0000-4000-8000-000000000001",
      types: ["failed", "timeout"],
      page: 3,
      pageSize: 100,
      eventId: "attempt:018f0000-0000-7000-8000-000000000042",
      eventTaskId: "018f0000-0000-7000-8000-000000000007",
    });
    expect(parseEventsLocation(eventsLocationHref(state).split("?")[1] ?? "")).toEqual(state);
  });

  it("omits defaults and rejects invalid hand-edited values", () => {
    expect(eventsLocationHref(defaultEventsLocation)).toBe("/events");
    expect(
      parseEventsLocation(
        "?window=7d&source=other&page=0&per=200&events=failed,unknown&task=not-a-task&event=task:42",
      ),
    ).toEqual({ ...defaultEventsLocation, types: ["failed"] });
    expect(parseEventsLocation("?from=2026-08-16T12:00:00Z&to=2026-08-15T12:00:00Z")).toEqual(
      defaultEventsLocation,
    );
  });

  it("opens a record that the dashboard derives for a fast-tier task", () => {
    // A derived identity is an MD5 value cast to uuid, so its version digit is rarely 7.
    const derived = "event:9e71565f-a9e8-f2c9-939b-0e7ff240bf26";
    expect(parseEventsLocation(`?event=${derived}`).eventId).toBe(derived);
    expect(parseEventsLocation("?event=attempt:a326ee37-afbc-b371-de56-c85313ead889").eventId).toBe(
      "attempt:a326ee37-afbc-b371-de56-c85313ead889",
    );
    expect(parseEventsLocation("?event=event:9e71565f-a9e8-f2c9-939b").eventId).toBeNull();
  });

  it("keeps the task of the open record only with a valid record identity", () => {
    const record = "event:9e71565f-a9e8-f2c9-939b-0e7ff240bf26";
    const task = "018f0000-0000-7000-8000-000000000007";
    // An address from a released page names no task, and the drawer still opens its record.
    expect(parseEventsLocation(`?event=${record}`)).toMatchObject({
      eventId: record,
      eventTaskId: null,
    });
    expect(parseEventsLocation(`?event=${record}&eventTask=${task}`).eventTaskId).toBe(task);
    expect(parseEventsLocation(`?event=${record}&eventTask=not-a-task`).eventTaskId).toBeNull();
    expect(parseEventsLocation(`?eventTask=${task}`)).toEqual(defaultEventsLocation);
    expect(parseEventsLocation(`?event=task:42&eventTask=${task}`)).toEqual(defaultEventsLocation);
    expect(
      eventsLocationHref({ ...defaultEventsLocation, eventId: record, eventTaskId: task }),
    ).toBe(`/events?event=${encodeURIComponent(record)}&eventTask=${task}`);
  });

  it("opens a feed row with its task and closes the drawer without either", () => {
    const filtered = parseEventsLocation("?window=6h&queue=orders");
    const row = {
      id: "attempt:a326ee37-afbc-b371-de56-c85313ead889",
      taskId: "018f0000-0000-7000-8000-000000000007",
    };
    const opened = eventsLocationWithEvent(filtered, row);
    expect(eventsLocationHref(opened)).toBe(
      `/events?window=6h&queue=orders&event=${encodeURIComponent(row.id)}&eventTask=${row.taskId}`,
    );
    expect(parseEventsLocation(eventsLocationHref(opened).split("?")[1]!)).toEqual(opened);
    expect(eventsLocationWithoutEvent(opened)).toEqual(filtered);
  });

  it("never asks for a page past the one the server accepts", () => {
    // A bookmarked or hand-edited URL would otherwise send a page the router rejects.
    expect(parseEventsLocation(`?page=${dashboardPageMax + 1}`).page).toBe(dashboardPageMax);
    expect(parseEventsLocation(`?page=${dashboardPageMax}`).page).toBe(dashboardPageMax);
    expect(eventsLocationHref({ ...defaultEventsLocation, page: dashboardPageMax + 5 })).toBe(
      `/events?page=${dashboardPageMax}`,
    );
  });

  it("builds an exact task-scoped Events link", () => {
    expect(
      eventsLocationHref({
        ...defaultEventsLocation,
        taskId: "3f1c0c8e-0000-4000-8000-000000000001",
      }),
    ).toBe("/events?task=3f1c0c8e-0000-4000-8000-000000000001");
  });

  it("closing the drawer keeps every filter and does not change the listing key", () => {
    const opened = parseEventsLocation(
      "?window=6h&queue=orders&events=failed&page=2&event=event:018f0000-0000-7000-8000-000000000091",
    );
    const closed = eventsLocationWithoutEvent(opened);
    expect(eventsLocationHref(closed)).toBe("/events?window=6h&queue=orders&events=failed&page=2");
    expect(eventsListingKey(opened)).toBe(eventsListingKey(closed));
  });
});
