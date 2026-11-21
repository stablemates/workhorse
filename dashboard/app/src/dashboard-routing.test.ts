import { afterEach, describe, expect, it, vi } from "vitest";
import { createDashboardRouter } from "./dashboard-routing.js";

describe("dashboard router", () => {
  it("mounts paths and returns the parsed location after navigation", () => {
    const paths: string[] = [];
    let route: "/tasks" | "/events" = "/tasks";
    const router = createDashboardRouter("/console", {
      readLocation: () => ({ route }) as ReturnType<typeof routerReadLocation>,
      pushState: (path) => {
        paths.push(path);
        route = "/events";
      },
      replaceState: (path) => {
        paths.push(path);
        route = "/tasks";
      },
    });
    expect(router.href("/events")).toBe("/console/events");
    expect(router.push("/events").route).toBe("/events");
    expect(paths).toEqual(["/console/events"]);
    expect(router.replace("/tasks?page=2").route).toBe("/tasks");
  });
});

function routerReadLocation() {
  return { route: "/tasks" as const };
}

describe("task page location", () => {
  const taskId = "019a0000-0000-7000-8000-0000000000aa";

  it("round-trips one task through the address bar", async () => {
    const { parseTaskPageLocation, taskPageHref } = await import("./core.js");
    expect(taskPageHref(taskId)).toBe(`/task?id=${taskId}`);
    const [pathname, search] = taskPageHref(taskId).split("?");
    expect(parseTaskPageLocation(pathname!, `?${search}`)).toBe(taskId);
    expect(parseTaskPageLocation("/task", `?id=${taskId.toUpperCase()}`)).toBe(taskId);
  });

  it("names no task for another route or a value that is not a task identity", async () => {
    const { parseTaskPageLocation } = await import("./core.js");
    expect(parseTaskPageLocation("/tasks", `?id=${taskId}`)).toBeNull();
    expect(parseTaskPageLocation("/task", "?id=not-a-task")).toBeNull();
    expect(parseTaskPageLocation("/task", "")).toBeNull();
  });
});

describe("task page route", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the task page route for an id that is not valid, so the page can report it", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
    vi.stubGlobal("window", { location: { pathname: "/task", search: "?id=garbage" } });
    const { readLocation } = await import("./core.js");
    expect(readLocation()).toMatchObject({ route: "/task", taskPageId: null });
  });
});
