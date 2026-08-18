import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { Queryable } from "@workhorse/core";
import { describe, expect, it, vi } from "vitest";
import { createDashboardHost } from "../src/server/host.js";
import type { DashboardRouter } from "../src/server/router.js";
import type { DashboardTaskController } from "../src/server/types.js";

const database = {
  query: async () => ({ rows: [{ version: 45 }] }),
} as unknown as Queryable;

describe("signal RPC authentication", () => {
  it("rejects an unauthorized delivery before invoking the controller", async () => {
    const signalTask = vi.fn<NonNullable<DashboardTaskController["signalTask"]>>();
    const host = createDashboardHost({
      database,
      path: "/",
      authorize: () => false,
      operator: { mode: "writable" },
      taskController: { signalTask },
    });
    const client: RouterClient<DashboardRouter> = createORPCClient(
      new RPCLink({
        url: "http://dashboard.test/rpc",
        fetch: async (request) =>
          (await host.handle(request)) ?? new Response(null, { status: 404 }),
      }),
    );

    await expect(
      client.dashboard.signalTask({
        id: "10000000-0000-4000-8000-000000000001",
        name: "approval",
        payload: { approved: true },
        idempotencyKey: "request-1",
        audit: { actor: "spoofed", reason: "approve", requestId: "browser-request" },
      }),
    ).rejects.toThrow(/Forbidden/);
    expect(signalTask).not.toHaveBeenCalled();
  });

  it("derives signal attribution from the authenticated server principal", async () => {
    const signalTask = vi
      .fn<NonNullable<DashboardTaskController["signalTask"]>>()
      .mockResolvedValue({
        status: "delivered",
        jobId: "10000000-0000-4000-8000-000000000001",
        name: "approval",
        payload: { approved: true },
        deliveredAt: "2026-08-15T12:00:00.000Z",
        deliveredBy: "server-user",
      });
    const host = createDashboardHost({
      database,
      path: "/",
      authorize: (request) =>
        request.headers.get("authorization") === "Bearer valid" ? { actor: "server-user" } : false,
      operator: { mode: "writable" },
      taskController: { signalTask },
    });
    const client: RouterClient<DashboardRouter> = createORPCClient(
      new RPCLink({
        url: "http://dashboard.test/rpc",
        fetch: async (request) => {
          const headers = new Headers(request.headers);
          headers.set("authorization", "Bearer valid");
          headers.set("origin", "http://dashboard.test");
          return (
            (await host.handle(new Request(request, { headers }))) ??
            new Response(null, { status: 404 })
          );
        },
      }),
    );

    await client.dashboard.signalTask({
      id: "10000000-0000-4000-8000-000000000001",
      name: "approval",
      payload: { approved: true },
      idempotencyKey: "request-1",
      audit: { actor: "spoofed", reason: "approve", requestId: "browser-request" },
    });

    expect(signalTask).toHaveBeenCalledWith(
      "10000000-0000-4000-8000-000000000001",
      "approval",
      { approved: true },
      "request-1",
      expect.objectContaining({ actor: "server-user", reason: "approve" }),
    );
  });
});
