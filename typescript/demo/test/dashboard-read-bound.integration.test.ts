/**
 * The dashboard read bound over the demo's own Drizzle adapter, which is how the demo serves it.
 *
 * One piece of the demo integration suite. Every piece owns a scratch database, so the pieces run
 * in parallel; see ./support/demo-integration.ts for the harness they share.
 */
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { ORPCError, type RouterClient } from "@orpc/server";
import { createDrizzleAdapter } from "@stablemates/workhorse-drizzle";
import {
  createDashboardHost,
  type DashboardRouter,
} from "@stablemates/workhorse-dashboard-server/server";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { createDemoDatabase, DEMO_QUEUE } from "../src/app.js";
import { DEMO_QUEUE_OPTIONS } from "../src/contracts.js";
import { createDemoIntegrationSuite } from "./support/demo-integration.js";

const { pool } = createDemoIntegrationSuite(import.meta.url);

const MARKER = "dashboard_task_counts_v1";

/** The marked statement sleeps in the database, standing in for a read that outgrew its bound on a
 * strained database. It keeps its own parameters, whichever form the caller passed them in. */
function slowly<T>(statement: T): T {
  const text = typeof statement === "string" ? statement : (statement as { text?: string }).text;
  if (!text?.includes(MARKER)) return statement;
  const slow = `SELECT original.* FROM pg_sleep(5) CROSS JOIN (${text}) original`;
  return (typeof statement === "string" ? slow : { ...statement, text: slow }) as T;
}

/** The suite's pool, except that the marked statement sleeps on whichever path it takes. */
function sleepingPool(): Pool {
  const query = ((statement: unknown, ...rest: unknown[]) =>
    (pool.query as (...args: unknown[]) => unknown)(slowly(statement), ...rest)) as Pool["query"];
  const connect = (async () => {
    const client = await pool.connect();
    return Object.assign(Object.create(client) as PoolClient, {
      query: (statement: unknown, ...rest: unknown[]) =>
        (client.query as (...args: unknown[]) => unknown)(slowly(statement), ...rest),
      release: (error?: Error | boolean) => client.release(error),
    });
  }) as Pool["connect"];
  return Object.assign(Object.create(pool) as Pool, { query, connect });
}

function dashboardClient(host: ReturnType<typeof createDashboardHost>) {
  return createORPCClient<RouterClient<DashboardRouter>>(
    new RPCLink({
      url: "http://dashboard.test/rpc",
      fetch: async (request) => {
        const headers = new Headers(request.headers);
        headers.set("origin", "http://dashboard.test");
        return (
          (await host.handle(new Request(request, { headers }))) ??
          new Response(null, { status: 404 })
        );
      },
    }),
  );
}

describe("dashboard read bound over an ORM adapter", () => {
  it("answers a slow read with TIMEOUT and returns the connection it borrowed", async () => {
    const adapter = createDrizzleAdapter(createDemoDatabase(sleepingPool()), {
      defaultQueue: DEMO_QUEUE,
      queueOptions: DEMO_QUEUE_OPTIONS,
    });
    const host = createDashboardHost({
      database: adapter.database,
      path: "/",
      statementTimeoutMs: 150,
      authorize: () => true,
    });
    const idleBefore = pool.idleCount;
    const started = performance.now();

    const failure = await dashboardClient(host)
      .dashboard.taskCounts()
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ORPCError);
    expect(failure).toMatchObject({ code: "TIMEOUT", status: 408 });
    expect(performance.now() - started).toBeLessThan(4_000);
    // The connection is back in the pool rather than parked inside an abandoned transaction.
    expect(pool.idleCount).toBe(idleBefore);
    await expect(pool.query("SELECT 1 AS live")).resolves.toMatchObject({ rows: [{ live: 1 }] });
  });
});
