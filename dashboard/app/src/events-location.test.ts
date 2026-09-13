import { describe, expect, it } from "vitest";
import {
  defaultEventsLocation,
  eventsListingKey,
  eventsLocationHref,
  parseEventsLocation,
} from "./events-location.js";

describe("events location state", () => {
  it("round-trips every shareable filter and the open event", () => {
    const state = parseEventsLocation(
      "?window=24h&source=attempt&queue=orders&type=order.process&worker=worker-1&q=invoice&task=3f1c0c8e-0000-4000-8000-000000000001&events=failed,timeout&page=3&per=100&event=attempt:018f0000-0000-7000-8000-000000000042",
    );
    expect(state).toEqual({
      window: "24h",
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
    const closed = { ...opened, eventId: null };
    expect(eventsLocationHref(closed)).toBe("/events?window=6h&queue=orders&events=failed&page=2");
    expect(eventsListingKey(opened)).toBe(eventsListingKey(closed));
  });
});
