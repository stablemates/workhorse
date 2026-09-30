import { Pool } from "pg";

import type { Json } from "../src/types.js";
import { Queue } from "../src/queue.js";
import { Worker } from "../src/worker.js";

// The TypeScript side of the Ruby Active Job typed-job tests. `enqueue` writes a task that the Ruby
// class runs, and `run` runs one task that a Ruby typed job enqueued, printing its payload as JSON.
const [command, databaseUrl, queueName, taskType, payload] = process.argv.slice(2);
if (
  (command !== "enqueue" && command !== "run") ||
  databaseUrl === undefined ||
  queueName === undefined ||
  taskType === undefined
) {
  throw new Error(
    "usage: ruby-active-job-peer.ts enqueue|run <database-url> <queue-name> <task-type> [payload-json]",
  );
}

const pool = new Pool({ connectionString: databaseUrl });
try {
  const queue = new Queue(pool, queueName);
  if (command === "enqueue") {
    process.stdout.write(await queue.enqueue(taskType, JSON.parse(payload ?? "{}") as Json));
  } else {
    let received: Json | undefined;
    const worker = new Worker(queue, { queue: queueName, workerId: "typescript-active-job-peer" });
    worker.handle(taskType, async (input) => {
      received = input;
      return {};
    });
    if (!(await worker.runOnce()) || received === undefined) {
      throw new Error(`the TypeScript worker ran no ${taskType} task`);
    }
    process.stdout.write(JSON.stringify(received));
  }
} finally {
  await pool.end();
}
