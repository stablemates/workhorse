import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { describe, expect, it } from "vitest";
import { Worker } from "../../core/src/index.js";
import { createIntegrationTestContext } from "../../core/test/support/integration.js";
import { createDashboardHost } from "../src/server/host.js";
import { createDashboardOperatorControllers } from "../src/server/operator-controllers.js";
import { readDashboardHumanWaits } from "../src/server/read-model.js";
import type { DashboardRouter } from "../src/server/router.js";
import { dashboardDatabase } from "../src/server/sql.js";

const { pool, queue, admin } = createIntegrationTestContext(import.meta.url);

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
          taskId: id,
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
      tasks: [
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
    await expect(admin.getTask(id)).resolves.toMatchObject({
      state: "succeeded",
      result: { approved: true },
    });
  });
});

describe("dashboard human waits health input", () => {
  // The procedure falls back to queue_health_v1() when no document arrives, so a broken
  // pass-through would still return plausible numbers. A sentinel the database could never
  // produce proves the supplied document is the one projected.
  it("projects the diagnostics from the supplied health document instead of recomputing them", async () => {
    const page = await readDashboardHumanWaits(
      dashboardDatabase(pool),
      admin,
      true,
      true,
      async () => ({
        pending_human_waits: 42,
        pending_signal_waits: 7,
        overdue_external_waits: 3,
        oldest_external_wait_age_ms: 1234.5,
        rejected_wait_deliveries: 2,
        external_wait_counts_capped: true,
      }),
    );

    expect(page.diagnostics).toEqual({
      pendingHumanDecisions: 42,
      pendingSignals: 7,
      overdue: 3,
      oldestPendingAgeMs: 1234.5,
      rejectedDeliveries: 2,
      capped: true,
    });
  });

  it("does not recompute health when system, queues, and settings receive a document", async () => {
    const connection = await pool.connect();
    try {
      await connection.query("BEGIN");
      const health = await connection.query<{ document: unknown }>(
        "SELECT workhorse.queue_health_v1() AS document",
      );
      await connection.query(`
        CREATE OR REPLACE FUNCTION workhorse.queue_health_v1(
          p_rejected_since timestamptz DEFAULT clock_timestamp() - interval '1 day'
        ) RETURNS jsonb
        LANGUAGE plpgsql
        VOLATILE
        SET jit = off
        AS $function$
        BEGIN
          RAISE EXCEPTION 'queue_health_v1 must not be called';
        END;
        $function$
      `);
      const input = JSON.stringify({ health: health.rows[0]?.document });

      await expect(
        connection.query(
          `SELECT workhorse.dashboard_queues_v1($1::jsonb) AS queues,
                  workhorse.dashboard_settings_v1($1::jsonb) AS settings,
                  workhorse.dashboard_system_v1($1::jsonb) AS system`,
          [input],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await connection.query("ROLLBACK");
      connection.release();
    }
  });
});
