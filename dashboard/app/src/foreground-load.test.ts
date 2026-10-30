import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createForegroundLoads } from "./foreground-load.js";
import { createPageLoadClaims } from "./page-load-claims.js";

const controllerSource = readFileSync(new URL("./shell/controller.tsx", import.meta.url), "utf8");

/** The foreground spinner state, held as React holds it. */
function spinner() {
  let current: number | null = null;
  const loads = createForegroundLoads((update) => {
    current = update(current);
  });
  return { loads, busy: () => current !== null };
}

describe("foreground page loads", () => {
  it("stops the spinner when a cached page replaces a slow page load", async () => {
    const claims = createPageLoadClaims();
    const { loads, busy } = spinner();
    // 1. The operator opens Queues, and its read is slow.
    const queues = claims.claim("queues");
    loads.start(queues.id);
    const queuesRead = Promise.withResolvers<string>();
    const queuesLoad = queuesRead.promise.then(() => loads.settle(queues.id));
    expect(busy()).toBe(true);
    // 2. The operator opens Schedules. A fresh cached answer serves it at once.
    claims.claim("cron");
    loads.supersede();
    // 3. Refresh is not busy on Schedules while the Queues read runs.
    expect(busy()).toBe(false);
    // 4. The Queues answer arrives late. It cannot write, and the spinner stays off.
    queuesRead.resolve("queues answer");
    await queuesLoad;
    expect(claims.holds(queues, "cron")).toBe(false);
    expect(busy()).toBe(false);
  });

  it("keeps the spinner of a newer load when an older load settles", async () => {
    const { loads, busy } = spinner();
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    loads.start(1);
    const firstLoad = first.promise.then(() => loads.settle(1));
    loads.start(2);
    const secondLoad = second.promise.then(() => loads.settle(2));
    first.resolve();
    await firstLoad;
    expect(busy()).toBe(true);
    second.resolve();
    await secondLoad;
    expect(busy()).toBe(false);
  });

  it("supersedes the load in progress before a cached navigation returns", () => {
    const cacheHit = controllerSource.indexOf(
      "if (navigation && pageCache.holdsFresh(key, prefetchFreshMs)) {",
    );
    const branch = controllerSource.slice(
      cacheHit,
      controllerSource.indexOf("\n      }\n", cacheHit),
    );
    const supersede = branch.indexOf("if (!background) foregroundLoads.supersede();");
    expect(supersede).toBeGreaterThan(-1);
    expect(supersede).toBeLessThan(branch.indexOf("return applyNothing;"));
  });
});
