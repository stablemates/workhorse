import { describe, expect, it } from "vitest";
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
