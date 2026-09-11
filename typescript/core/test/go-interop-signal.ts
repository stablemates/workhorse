import { Pool } from "pg";

import { Queue } from "../src/queue.js";

const [databaseUrl, taskId] = process.argv.slice(2);
if (databaseUrl === undefined || taskId === undefined) {
  throw new Error("usage: go-interop-signal.ts <database-url> <task-id>");
}

const pool = new Pool({ connectionString: databaseUrl });
try {
  const result = await new Queue(pool).sendSignal(
    taskId,
    "approval",
    { approved: true },
    { idempotencyKey: "approval-delivery", requestedBy: "typescript-billing-service" },
  );
  if (result.status !== "delivered") {
    throw new Error(`TypeScript signal delivery returned ${result.status}`);
  }
} finally {
  await pool.end();
}
