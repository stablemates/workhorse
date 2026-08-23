import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { describe, expect, it } from "vitest";
import { Worker } from "../../core/src/index.js";
import { createIntegrationTestContext } from "../../core/test/support/integration.js";
import { createDashboardHost } from "../src/server/host.js";
import { createDashboardOperatorControllers } from "../src/server/operator-controllers.js";
import type { DashboardRouter } from "../src/server/router.js";

const { pool, queue, admin } = createIntegrationTestContext(import.meta.url);

describe("dashboard signal waits", () => {
  it("lists actionable signals, marks their tasks, and delivers an operator payload", async () => {
    const id = await queue.enqueue("dashboard-signal-wait", { accountId: "account-1" });
    const worker = new Worker(queue, { workerId: "dashboard-signal-wait-worker" }).handle(
      "dashboard-signal-wait",
      async (_payload, context) => ({
        approval: await context.waitForSignal("account-approval"),
      }),
    );
    expect(await worker.runOnce()).toBe(true);

    const controllers = createDashboardOperatorControllers({
      run: (_action, operation) => operation({ admin, queue }),
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
    const client: RouterClient<DashboardRouter> = createORPCClient(
      new RPCLink({
        url: "http://dashboard.test/rpc",
        fetch: async (request) => {
          const headers = new Headers(request.headers);
          headers.set("origin", "http://dashboard.test");
          headers.set("authorization", "Bearer valid");
          return (
            (await host.handle(new Request(request, { headers }))) ??
            new Response(null, { status: 404 })
          );
        },
      }),
    );

    await expect(client.dashboard.humanWaits()).resolves.toMatchObject({
      canSignal: true,
      signalWaits: [
        {
          jobId: id,
          queue: "default",
          jobType: "dashboard-signal-wait",
          name: "account-approval",
          attempt: 1,
          createdAt: expect.any(String),
          deadlineAt: expect.any(String),
        },
      ],
    });
    await expect(
      client.dashboard.tasks({ filter: "all", page: 1, pageSize: 25 }),
    ).resolves.toMatchObject({
      jobs: [
        expect.objectContaining({
          id,
          signalWait: {
            name: "account-approval",
            deadlineAt: expect.any(String),
          },
        }),
      ],
    });
    await expect(client.dashboard.jobDetail({ id })).resolves.toMatchObject({
      canSignal: true,
      signalWait: {
        name: "account-approval",
        deadlineAt: expect.any(String),
      },
    });

    await expect(
      client.dashboard.signalTask({
        id,
        name: "account-approval",
        payload: { approved: true },
        idempotencyKey: "dashboard-signal-delivery",
        audit: { actor: "spoofed", reason: "approve account", requestId: "browser-request" },
      }),
    ).resolves.toMatchObject({
      status: "delivered",
      deliveredBy: "authenticated-operator",
    });

    expect(await worker.runOnce()).toBe(true);
    await expect(admin.getJob(id)).resolves.toMatchObject({
      state: "succeeded",
      result: { approval: { approved: true } },
    });
  });
});
