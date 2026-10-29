import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createPageLoadClaims } from "./page-load-claims.js";

const controllerSource = readFileSync(new URL("./shell/controller.tsx", import.meta.url), "utf8");

describe("page load claims", () => {
  it("refuses a slow answer for the page that the operator left", () => {
    const claims = createPageLoadClaims();
    // The operator opens Queues, and its load is slow.
    const queues = claims.claim("queues");
    // The operator opens Schedules, and the cache serves it at once.
    const schedules = claims.claim("cron");
    // The Queues answer arrives late.
    expect(claims.holds(queues, "cron")).toBe(false);
    expect(claims.holds(schedules, "cron")).toBe(true);
  });

  it("refuses an answer for another page before the next load takes its claim", () => {
    const claims = createPageLoadClaims();
    const queues = claims.claim("queues");
    // The location already asks for Schedules, but no Schedules load started yet.
    expect(claims.holds(queues, "cron")).toBe(false);
    expect(claims.holds(queues, "queues")).toBe(true);
  });

  it("lets only the newest load of one page write", () => {
    const claims = createPageLoadClaims();
    const first = claims.claim("queues");
    const second = claims.claim("queues");
    expect(claims.holds(first, "queues")).toBe(false);
    expect(claims.holds(second, "queues")).toBe(true);
  });

  it("is taken by each navigation before the cache can serve it", () => {
    const claim = controllerSource.indexOf("const claim = pageLoads.current.claim(key);");
    const cacheHit = controllerSource.indexOf(
      "if (navigation && pageCache.holdsFresh(key, prefetchFreshMs)) {",
    );
    expect(claim).toBeGreaterThan(-1);
    expect(cacheHit).toBeGreaterThan(claim);
    // The cached answer, the read answer, and the failure check the claim against the page in
    // the location.
    expect(
      controllerSource.split("if (!pageLoads.current.holds(claim, pageKeyRef.current)) return;"),
    ).toHaveLength(4);
  });

  it("shows a cached answer that a prefetch wrote after the render read the cache", () => {
    const cacheHit = controllerSource.indexOf(
      "if (navigation && pageCache.holdsFresh(key, prefetchFreshMs)) {",
    );
    const branch = controllerSource.slice(
      cacheHit,
      controllerSource.indexOf("\n      }\n", cacheHit),
    );
    // The navigation skips the read only if the page on screen is already this answer.
    expect(branch).toContain(
      "if (cached === null || loadedPage.current?.key === key) return applyNothing;",
    );
    expect(branch).toContain("setLoadState((current) => readyLoadState(current, cached.data));");
  });
});
