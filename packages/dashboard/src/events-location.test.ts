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
      "?window=24h&source=attempt&queue=orders&type=order.process&events=failed,timeout&page=3&per=100&event=attempt:42",
    );
    expect(state).toEqual({
      window: "24h",
      kind: "attempt",
      queue: "orders",
      jobType: "order.process",
      types: ["failed", "timeout"],
      page: 3,
      pageSize: 100,
      eventId: "attempt:42",
    });
    expect(parseEventsLocation(eventsLocationHref(state).split("?")[1] ?? "")).toEqual(state);
  });

  it("omits defaults and rejects invalid hand-edited values", () => {
    expect(eventsLocationHref(defaultEventsLocation)).toBe("/events");
    expect(
      parseEventsLocation(
        "?window=7d&source=other&page=0&per=200&events=failed,unknown&event=job:42",
      ),
    ).toEqual({ ...defaultEventsLocation, types: ["failed"] });
  });

  it("closing the drawer keeps every filter and does not change the listing key", () => {
    const opened = parseEventsLocation(
      "?window=6h&queue=orders&events=failed&page=2&event=event:91",
    );
    const closed = { ...opened, eventId: null };
    expect(eventsLocationHref(closed)).toBe("/events?window=6h&queue=orders&events=failed&page=2");
    expect(eventsListingKey(opened)).toBe(eventsListingKey(closed));
  });
});
