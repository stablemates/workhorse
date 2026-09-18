import type { Queryable } from "@stablemates/workhorse";
import { describe, expect, it, vi } from "vitest";
import { createDashboardHost } from "../src/server/host.js";
import { PROTOCOL_VERSION, WORKHORSE_SCHEMA_VERSION } from "@stablemates/workhorse";

const database = {
  query: async () => ({
    rows: [
      { kind: "protocol", version: PROTOCOL_VERSION },
      { kind: "schema", version: WORKHORSE_SCHEMA_VERSION },
    ],
  }),
} as unknown as Queryable;

describe("dashboard host address check", () => {
  it("answers 421 to a foreign host before authorization runs", async () => {
    const authorize = vi.fn<() => boolean>(() => true);
    const host = createDashboardHost({
      database,
      path: "/workhorse",
      authorize,
      allowedHosts: ["127.0.0.1:4100"],
    });

    const response = await host.handle(
      new Request("http://rebound.example:4100/workhorse/rpc/dashboard/queues", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );

    expect(response?.status).toBe(421);
    await expect(response?.json()).resolves.toEqual({ error: "Misdirected Request" });
    expect(authorize).not.toHaveBeenCalled();
  });

  it("serves a listed host regardless of letter case and a default port", async () => {
    const authorize = vi.fn<() => boolean>(() => false);
    const host = createDashboardHost({
      database,
      path: "/workhorse",
      authorize,
      allowedHosts: ["Dashboard.Example:80", "127.0.0.1:4100"],
    });

    for (const url of ["http://dashboard.example/workhorse", "http://127.0.0.1:4100/workhorse"]) {
      const response = await host.handle(new Request(url));
      expect(response?.status).toBe(403);
    }
    expect(authorize).toHaveBeenCalledTimes(2);
  });

  it("checks no host when none is configured", async () => {
    const host = createDashboardHost({ database, path: "/workhorse", authorize: () => false });
    const response = await host.handle(new Request("http://anything.example/workhorse"));
    expect(response?.status).toBe(403);
  });

  it("leaves requests outside its mount path to the application", async () => {
    const host = createDashboardHost({
      database,
      path: "/workhorse",
      authorize: () => true,
      allowedHosts: ["127.0.0.1:4100"],
    });
    await expect(host.handle(new Request("http://rebound.example/other"))).resolves.toBeNull();
  });

  it("rejects a configured entry that is not a bare host", () => {
    expect(() =>
      createDashboardHost({
        database,
        authorize: () => true,
        allowedHosts: ["http://127.0.0.1:4100/"],
      }),
    ).toThrow(/host/i);
  });
});
