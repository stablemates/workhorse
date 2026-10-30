import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { DashboardClient } from "@stablemates/workhorse-dashboard-server";
import type { PageData } from "./core.js";
import { defaultEventsLocation } from "./events-location.js";
import {
  createPageCache,
  fetchPageData,
  pageRequestKey,
  readPage,
  type PageRequest,
} from "./page-cache.js";
import { createRefreshRequests } from "./refresh-requests.js";
import { parseTaskGroupsLocation } from "./task-groups-location.js";
import { parseTaskLocation } from "./task-location.js";

const controllerSource = readFileSync(new URL("./shell/controller.tsx", import.meta.url), "utf8");

function request(overrides: Partial<PageRequest> = {}): PageRequest {
  return {
    route: "/tasks",
    listing: parseTaskLocation(""),
    events: defaultEventsLocation,
    groups: parseTaskGroupsLocation(""),
    systemWindow: "1h",
    ...overrides,
  };
}

const queuesPage = { route: "/queues", value: { queues: [] } } as unknown as PageData;
const workersPage = { route: "/workers", value: { workers: [] } } as unknown as PageData;

describe("page request key", () => {
  it("holds only the parameters that the route reads", () => {
    expect(pageRequestKey(request({ route: "/queues" }))).toBe(
      pageRequestKey(request({ route: "/queues", systemWindow: "24h" })),
    );
    expect(pageRequestKey(request())).toBe(pageRequestKey(request({ systemWindow: "24h" })));
    expect(pageRequestKey(request({ route: "/system" }))).not.toBe(
      pageRequestKey(request({ route: "/system", systemWindow: "24h" })),
    );
  });

  it("tells task listings apart by their filters", () => {
    expect(pageRequestKey(request())).not.toBe(
      pageRequestKey(request({ listing: parseTaskLocation("filter=discarded") })),
    );
    // Opening a task drawer changes the URL, not the listing.
    expect(pageRequestKey(request())).toBe(
      pageRequestKey(request({ listing: parseTaskLocation("task=abc") })),
    );
  });

  it("tells routes apart", () => {
    const keys = ["/tasks", "/events", "/groups", "/cron", "/queues", "/system", "/workers"].map(
      (route) => pageRequestKey(request({ route: route as PageRequest["route"] })),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("page cache", () => {
  it("returns the last answer for a key and its time", () => {
    const cache = createPageCache();
    expect(cache.read("queues")).toBeNull();
    cache.write("queues", queuesPage, cache.generation(), Date.parse("2026-10-27T12:00:00.000Z"));
    expect(cache.read("queues")).toEqual({
      data: queuesPage,
      refreshedAt: "2026-10-27T12:00:00.000Z",
      receivedAt: Date.parse("2026-10-27T12:00:00.000Z"),
    });
  });

  it("judges an answer fresh only while it is younger than the age limit", () => {
    const cache = createPageCache();
    cache.write("queues", queuesPage, cache.generation(), 1_000);
    expect(cache.holdsFresh("queues", 5_000, 5_999)).toBe(true);
    expect(cache.holdsFresh("queues", 5_000, 6_000)).toBe(false);
    expect(cache.holdsFresh("workers", 5_000, 1_000)).toBe(false);
  });

  it("keeps the most recently written answers up to its limit", () => {
    const cache = createPageCache(2);
    cache.write("a", queuesPage, 0);
    cache.write("b", workersPage, 0);
    cache.write("a", queuesPage, 0);
    cache.write("c", workersPage, 0);
    expect(cache.read("b")).toBeNull();
    expect(cache.read("a")?.data).toBe(queuesPage);
    expect(cache.read("c")?.data).toBe(workersPage);
  });

  it("drops every answer when a mutation invalidates it", () => {
    const cache = createPageCache();
    cache.write("queues", queuesPage, cache.generation(), 1_000);
    cache.write("workers", workersPage, cache.generation(), 1_000);
    cache.invalidate();
    expect(cache.read("queues")).toBeNull();
    expect(cache.read("workers")).toBeNull();
    expect(cache.holdsFresh("queues", 5_000, 1_000)).toBe(false);
  });

  it("refuses the answer of a read that started before the mutation", () => {
    const cache = createPageCache();
    // A prefetch of the queues page starts, then the operator pauses a queue.
    const startedIn = cache.generation();
    cache.invalidate();
    // The prefetch answer holds the state from before the pause.
    expect(cache.write("queues", queuesPage, startedIn)).toBe(false);
    expect(cache.read("queues")).toBeNull();
    // A read that starts after the pause can write.
    expect(cache.write("queues", queuesPage, cache.generation())).toBe(true);
    expect(cache.read("queues")?.data).toBe(queuesPage);
  });

  it("belongs to one dashboard client, so a workspace never shows the answer of another", () => {
    expect(controllerSource).toContain(
      "const pageCache = useMemo(() => createPageCache(), [client]);",
    );
  });
});

/** The rows that a read for one task listing answers. */
function rowsOf(sent: PageRequest): string {
  return `rows:${sent.listing.queue}`;
}

describe("read page", () => {
  it("keeps the rows of each filter under its own key when the filters change during a Refresh", async () => {
    const requests = createRefreshRequests();
    const cache = createPageCache<string>();
    const filterA = request({ listing: parseTaskLocation("queue=alpha") });
    const filterB = request({ listing: parseTaskLocation("queue=beta") });
    const reads: string[] = [];
    let finishPoll!: () => void;
    const read = (sent: PageRequest) => {
      reads.push(sent.listing.queue ?? "");
      if (reads.length === 1) {
        return new Promise<string>((resolve) => {
          finishPoll = () => resolve(rowsOf(sent));
        });
      }
      return Promise.resolve(rowsOf(sent));
    };
    // 1. A poll reads filter A, and the read is slow.
    const poll = readPage({ requests, cache, request: filterA, read });
    await Promise.resolve();
    // 2. The operator clicks Refresh on filter A. The fresh read waits for the poll.
    const refresh = readPage({ requests, cache, request: filterA, read, fresh: true });
    // 3. The operator changes the filters to B, which reads B.
    expect(await readPage({ requests, cache, request: filterB, read })).toEqual({
      data: "rows:beta",
      kept: true,
    });
    // 4. The poll ends, and the Refresh then sends its own read.
    finishPoll();
    await poll;
    expect(await refresh).toEqual({ data: "rows:alpha", kept: true });
    expect(reads).toEqual(["alpha", "beta", "alpha"]);
    // 5. The operator goes back to filter A and sees the rows of filter A.
    expect(cache.read(pageRequestKey(filterA))?.data).toBe("rows:alpha");
    expect(cache.read(pageRequestKey(filterB))?.data).toBe("rows:beta");
  });

  it("is the read of each page load, which takes its request before the read starts", () => {
    expect(controllerSource).toMatch(
      /const request: PageRequest = \{\s*route,\s*listing: listingRef\.current,[\s\S]*?const key = pageRequestKey\(request\);/,
    );
    expect(controllerSource).toContain("read: (sent) => fetchPageData(client, sent),");
    expect(controllerSource).not.toMatch(/\(\) =>\s*fetchPageData\(client, \{/);
  });
});

describe("fetch page data", () => {
  it("reads the read model of the requested route", async () => {
    const calls: string[] = [];
    const client = {
      queues: async () => {
        calls.push("queues");
        return { queues: [] };
      },
      system: async ({ window }: { window: string }) => {
        calls.push(`system ${window}`);
        return { window };
      },
    } as unknown as DashboardClient;

    expect(await fetchPageData(client, request({ route: "/queues" }))).toEqual({
      route: "/queues",
      value: { queues: [] },
    });
    expect(await fetchPageData(client, request({ route: "/system", systemWindow: "6h" }))).toEqual({
      route: "/system",
      value: { window: "6h" },
    });
    expect(calls).toEqual(["queues", "system 6h"]);
  });
});
