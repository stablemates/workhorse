import { Pool } from "pg";

import { Queue } from "../src/queue.js";

const [databaseUrl, jobId] = process.argv.slice(2);
if (databaseUrl === undefined || jobId === undefined) {
  throw new Error("usage: go-interop-signal.ts <database-url> <job-id>");
}

const pool = new Pool({ connectionString: databaseUrl });
try {
  const result = await new Queue(pool).sendSignal(
    jobId,
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
