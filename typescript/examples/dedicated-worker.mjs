import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import {
  Admin,
  createWorkhorseAdapter,
  defineWorkerProcess,
  Pool,
  Queue,
  runWorkerProcess,
  startWorkerProcess,
} from "@stablemates/workhorse";

export function createDedicatedWorker(databaseUrl) {
  return defineWorkerProcess({
    adapter() {
      const pool = new Pool({ connectionString: databaseUrl, max: 10 });
      return createWorkhorseAdapter({
        database: pool,
        adaptTransaction: (transaction) => transaction,
        defaultQueue: "orders",
        close: () => pool.end(),
      });
    },
    workers: [
      {
        options: { concurrency: 8, workerId: "orders-worker" },
        configure(worker) {
          worker.handle("order.accepted", async (payload, context) =>
            context.checkpoint("prepare", async () => ({ payload, prepared: true })),
          );
        },
      },
    ],
    shutdownTimeoutMs: 20_000,
  });
}

async function verifyDedicatedWorker(databaseUrl) {
  const runtime = await startWorkerProcess(createDedicatedWorker(databaseUrl));
  const observer = new Pool({ connectionString: databaseUrl });
  try {
    const taskId = await new Queue(observer, "orders").enqueue("order.accepted", {
      orderId: "order-42",
    });
    const admin = new Admin(observer);
    for (let pass = 0; pass < 100; pass += 1) {
      const task = await admin.getTask(taskId);
      if (task?.state === "succeeded") return { taskId, result: task.result };
      if (task?.state === "failed" || task?.state === "canceled") {
        throw new Error(`Dedicated worker task finished in ${task.state} state`);
      }
      await delay(20);
    }
    throw new Error(`Dedicated worker did not finish ${taskId}`);
  } finally {
    await runtime.shutdown();
    await observer.end();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (import.meta.url === invokedPath) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (process.argv.includes("--verify")) {
    process.stdout.write(`${JSON.stringify(await verifyDedicatedWorker(databaseUrl))}\n`);
  } else {
    await runWorkerProcess(createDedicatedWorker(databaseUrl));
  }
}
