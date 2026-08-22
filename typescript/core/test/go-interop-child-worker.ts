import { Pool } from "pg";

import { Queue } from "../src/queue.js";
import { Worker } from "../src/worker.js";

const [databaseUrl, queueName] = process.argv.slice(2);
if (databaseUrl === undefined || queueName === undefined) {
  throw new Error("usage: go-interop-child-worker.ts <database-url> <queue-name>");
}

const pool = new Pool({ connectionString: databaseUrl });
try {
  const worker = new Worker(new Queue(pool, queueName), {
    queue: queueName,
    workerId: "typescript-child-worker",
  });
  worker.handle<{ value: number }, { value: number }>("typescript.child", async ({ value }) => ({
    value: value * 10,
  }));
  if (!(await worker.runOnce()) || !(await worker.runOnce())) {
    throw new Error("TypeScript worker did not process both Go-created children");
  }
} finally {
  await pool.end();
}
