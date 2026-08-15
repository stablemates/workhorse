import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { describe, expect, it } from "vitest";
import { Worker } from "../../core/src/index.js";
import { createIntegrationTestContext } from "../../core/test/support/integration.js";
import { createDashboardHost } from "../src/server/host.js";
import { createDashboardOperatorControllers } from "../src/server/operator-controllers.js";
import type { DashboardRouter } from "../src/server/router.js";

const { pool, queue } = createIntegrationTestContext(import.meta.url);

describe("dashboard signal integration", () => {
  it("rejects an unauthorized delivery before it mutates the waiting execution", async () => {
    const id = await queue.enqueue("signal-unauthorized", {});
    const worker = new Worker(queue, { workerId: "signal-unauthorized-worker" }).handle(
      "signal-unauthorized",
      async (_payload, context) => context.waitForSignal("approval"),
    );
    expect(await worker.runOnce()).toBe(true);

    const controllers = createDashboardOperatorControllers({
      run: (_action, operation) => operation(queue),
    });
    const host = createDashboardHost({
      database: pool,
      path: "/",
      authorize: (request) =>
        request.headers.get("authorization") === "Bearer valid"
          ? { actor: "authenticated-operator" }
          : false,
      ...controllers,
    });
    const client = (authorized: boolean): RouterClient<DashboardRouter> =>
      createORPCClient(
        new RPCLink({
          url: "http://dashboard.test/rpc",
          fetch: async (request) => {
            const headers = new Headers(request.headers);
            headers.set("origin", "http://dashboard.test");
            if (authorized) headers.set("authorization", "Bearer valid");
            return (
              (await host.handle(new Request(request, { headers }))) ??
              new Response(null, { status: 404 })
            );
          },
        }),
      );
    const input = {
      id,
      name: "approval",
      payload: { approved: true },
      idempotencyKey: "dashboard-delivery",
      audit: {
        actor: "spoofed-operator",
        reason: "approve",
        requestId: "dashboard-request",
      },
    };

    await expect(client(false).dashboard.signalTask(input)).rejects.toThrow(/Forbidden/);
    await expect(client(true).dashboard.signalTask(input)).resolves.toMatchObject({
      status: "delivered",
      deliveredBy: "authenticated-operator",
    });
    expect(await worker.runOnce()).toBe(true);
    await expect(queue.getJob(id)).resolves.toMatchObject({
      state: "succeeded",
      result: { approved: true },
    });
  });
});
