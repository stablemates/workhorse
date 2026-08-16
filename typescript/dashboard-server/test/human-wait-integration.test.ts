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

describe("dashboard human waits", () => {
  it("lists bounded decision context and derives completion attribution from the session", async () => {
    const id = await queue.enqueue("dashboard-human-wait", { accountId: "account-1" });
    const worker = new Worker(queue, { workerId: "dashboard-human-wait-worker" }).handle(
      "dashboard-human-wait",
      async (_payload, context) =>
        context.waitForHuman("account-review", {
          prompt: "Approve this account?",
          accountId: "account-1",
          dashboard: { quickAction: { label: "Approve", result: { approved: true } } },
        }),
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

    await expect(client(true).dashboard.humanWaits()).resolves.toMatchObject({
      canComplete: true,
      diagnostics: {
        pendingHumanDecisions: 1,
        pendingSignals: 0,
        overdue: 0,
        rejectedDeliveries: 0,
        capped: false,
      },
      waits: [
        expect.objectContaining({
          jobId: id,
          name: "account-review",
          context: {
            prompt: "Approve this account?",
            accountId: "account-1",
            dashboard: { quickAction: { label: "Approve", result: { approved: true } } },
          },
          deadlineAt: expect.any(String),
        }),
      ],
    });
    await expect(
      client(true).dashboard.tasks({ filter: "waiting", page: 1, pageSize: 25 }),
    ).resolves.toMatchObject({
      canCompleteHumanWait: true,
      jobs: [
        expect.objectContaining({
          id,
          humanWait: {
            name: "account-review",
            context: {
              prompt: "Approve this account?",
              accountId: "account-1",
              dashboard: { quickAction: { label: "Approve", result: { approved: true } } },
            },
            deadlineAt: expect.any(String),
          },
        }),
      ],
    });

    const input = {
      id,
      name: "account-review",
      result: { approved: true },
      idempotencyKey: "dashboard-human-completion",
      audit: { actor: "spoofed", reason: "approve account", requestId: "browser-request" },
    };
    await expect(client(false).dashboard.completeHumanWait(input)).rejects.toThrow(/Forbidden/);
    await expect(client(true).dashboard.completeHumanWait(input)).resolves.toMatchObject({
      status: "completed",
      completedBy: "authenticated-operator",
    });

    expect(await worker.runOnce()).toBe(true);
    await expect(queue.getJob(id)).resolves.toMatchObject({
      state: "succeeded",
      result: { approved: true },
    });
  });
});
