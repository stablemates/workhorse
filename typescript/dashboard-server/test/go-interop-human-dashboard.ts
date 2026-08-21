import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { Pool } from "pg";

import { Queue } from "../../core/src/queue.js";
import { createDashboardHost } from "../src/server/host.js";
import { createDashboardOperatorControllers } from "../src/server/operator-controllers.js";
import type { DashboardRouter } from "../src/server/router.js";

const [databaseUrl, jobId] = process.argv.slice(2);
if (databaseUrl === undefined || jobId === undefined) {
  throw new Error("usage: go-interop-human-dashboard.ts <database-url> <job-id>");
}

const pool = new Pool({ connectionString: databaseUrl });
try {
  const queue = new Queue(pool);
  const host = createDashboardHost({
    database: pool,
    path: "/",
    authorize: (request) =>
      request.headers.get("authorization") === "Bearer valid"
        ? { actor: "dashboard-go-interop" }
        : false,
    ...createDashboardOperatorControllers({ run: (_action, operation) => operation(queue) }),
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
  const completion = await client.dashboard.completeHumanWait({
    id: jobId,
    name: "review",
    result: { approved: true },
    idempotencyKey: "review-completion",
    audit: { actor: "spoofed", reason: "review", requestId: "go-interop" },
  });
  if (completion.status !== "completed" || completion.completedBy !== "dashboard-go-interop") {
    throw new Error(`dashboard human completion returned ${completion.status}`);
  }
} finally {
  await pool.end();
}
