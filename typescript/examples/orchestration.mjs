import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { Admin, Pool, Queue, Worker } from "@stablemates/workhorse";

export function createOrderWorkers(queue) {
  const parentWorker = new Worker(queue, {
    queue: "orders",
    workerId: "orders-orchestrator",
  }).handle("order.process", async (payload, context) => {
    const children = await context.runChildrenAll([
      { name: "invoice", type: "invoice.create", payload },
      { name: "receipt", type: "receipt.send", payload },
    ]);
    return { children };
  });

  const childWorker = new Worker(queue, {
    queue: "orders",
    workerId: "orders-steps",
    concurrency: 2,
  })
    .handle("invoice.create", async (payload) => ({ completed: true, payload }))
    .handle("receipt.send", async (payload) => ({ completed: true, payload }));

  return { parentWorker, childWorker };
}

export async function runOrchestrationExample(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    const queue = new Queue(pool, "orders");
    const admin = new Admin(pool);
    const workers = createOrderWorkers(queue);
    const jobId = await queue.enqueue("order.process", { orderId: "order-42" });

    for (let pass = 0; pass < 100; pass += 1) {
      await workers.parentWorker.runOnce();
      await workers.childWorker.runOnce();
      const job = await admin.getJob(jobId);
      if (job?.state === "succeeded") return { jobId, result: job.result };
      if (job?.state === "failed" || job?.state === "canceled") {
        throw new Error(`Order orchestration finished in ${job.state} state`);
      }
      await delay(20);
    }
    throw new Error(`Order orchestration did not finish ${jobId}`);
  } finally {
    await pool.end();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (import.meta.url === invokedPath) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  process.stdout.write(`${JSON.stringify(await runOrchestrationExample(databaseUrl))}\n`);
}
