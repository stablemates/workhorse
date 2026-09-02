import { logs, type LogRecord, type LoggerProvider } from "@opentelemetry/api-logs";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { Queryable } from "@stablemates/workhorse";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDashboardHost } from "../src/server/host.js";
import type { DashboardRouter } from "../src/server/router.js";
import { PROTOCOL_VERSION, WORKHORSE_SCHEMA_VERSION } from "@stablemates/workhorse";

const records: LogRecord[] = [];
const provider: LoggerProvider = {
  getLogger: () => ({
    enabled: () => true,
    emit: (record) => records.push(record),
  }),
};

const database = {
  query: async () => ({
    rows: [
      { kind: "protocol", version: PROTOCOL_VERSION },
      { kind: "schema", version: WORKHORSE_SCHEMA_VERSION },
    ],
  }),
} as unknown as Queryable;

function dashboardClient(): RouterClient<DashboardRouter> {
  const host = createDashboardHost({ database, path: "/", authorize: () => true });
  return createORPCClient(
    new RPCLink({
      url: "http://dashboard.test/rpc",
      fetch: async (request) => (await host.handle(request)) ?? new Response(null, { status: 404 }),
    }),
  );
}

function workspaceClient(): RouterClient<DashboardRouter> {
  const host = createDashboardHost({
    workspaces: { production: { database }, staging: { database } },
    defaultWorkspace: "production",
    path: "/",
    authorize: () => true,
  });
  return createORPCClient(
    new RPCLink({
      url: "http://dashboard.test/production/rpc",
      fetch: async (request) => (await host.handle(request)) ?? new Response(null, { status: 404 }),
    }),
  );
}

beforeAll(() => logs.setGlobalLoggerProvider(provider));
beforeEach(() => (records.length = 0));
afterAll(() => logs.disable());

describe("dashboard RPC logging", () => {
  it("records a successful procedure without its input or output", async () => {
    await dashboardClient().dashboard.meta();

    expect(records).toEqual([
      expect.objectContaining({
        eventName: "workhorse.dashboard.rpc_completed",
        severityText: "DEBUG",
        body: "Dashboard RPC request completed",
        attributes: expect.objectContaining({
          "rpc.system": "orpc",
          "rpc.method": "dashboard.meta",
          "http.response.status_code": 200,
          "workhorse.dashboard.rpc.duration_ms": expect.any(Number),
        }),
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain("unknown");
    expect(records[0]?.attributes).not.toHaveProperty("workhorse.dashboard.workspace");
  });

  it("records a failed procedure without its input or error details", async () => {
    const sensitiveInput = "customer-secret-that-is-not-a-uuid";

    await expect(dashboardClient().dashboard.jobDetail({ id: sensitiveInput })).rejects.toThrow(
      /validation/i,
    );

    expect(records).toEqual([
      expect.objectContaining({
        eventName: "workhorse.dashboard.rpc_failed",
        severityText: "ERROR",
        body: "Dashboard RPC request failed",
        attributes: expect.objectContaining({
          "rpc.system": "orpc",
          "rpc.method": "dashboard.jobDetail",
          "http.response.status_code": 400,
          "workhorse.dashboard.rpc.duration_ms": expect.any(Number),
        }),
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain(sensitiveInput);
    expect(records[0]).not.toHaveProperty("exception");
  });

  it("announces the configured workspaces once at construction", () => {
    workspaceClient();

    expect(records).toEqual([
      expect.objectContaining({
        eventName: "workhorse.dashboard.workspaces_configured",
        severityText: "INFO",
        body: "Dashboard host serves named workspaces",
        attributes: {
          "workhorse.dashboard.workspace_count": 2,
          "workhorse.dashboard.workspace_names": ["production", "staging"],
          "workhorse.dashboard.default_workspace": "production",
        },
      }),
    ]);
  });

  it("attributes RPC records to the workspace that served them", async () => {
    const client = workspaceClient();
    records.length = 0;

    await client.dashboard.meta();

    expect(records).toEqual([
      expect.objectContaining({
        eventName: "workhorse.dashboard.rpc_completed",
        attributes: expect.objectContaining({
          "rpc.method": "dashboard.meta",
          "workhorse.dashboard.workspace": "production",
        }),
      }),
    ]);
  });

  it("promotes a slow successful procedure to warning severity", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValueOnce(1_101);

    try {
      await dashboardClient().dashboard.meta();
    } finally {
      clock.mockRestore();
    }

    expect(records).toEqual([
      expect.objectContaining({
        eventName: "workhorse.dashboard.rpc_completed",
        severityText: "WARN",
        body: "Dashboard RPC request completed slowly",
        attributes: expect.objectContaining({
          "rpc.method": "dashboard.meta",
          "workhorse.dashboard.rpc.duration_ms": 1_001,
        }),
      }),
    ]);
  });
});
