import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
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

const LANGUAGE_TASK_TYPE = "demo.language-worker";
const SHARED_TASK_TYPE = "demo.shared-worker";
const TYPESCRIPT_QUEUE = "demo-typescript";
const SHARED_QUEUE = "demo-shared";

export function createDemoWorker(databaseUrl) {
  const workerId = `demo-typescript-${hostname().replaceAll(/[^\w.-]/g, "-")}-${process.pid}-${randomUUID().slice(0, 8)}`;
  return defineWorkerProcess({
    adapter() {
      const pool = new Pool({ connectionString: databaseUrl, max: 5 });
      return createWorkhorseAdapter({
        database: pool,
        adaptTransaction: (transaction) => transaction,
        close: () => pool.end(),
      });
    },
    workers: [
      {
        options: {
          queues: [TYPESCRIPT_QUEUE, SHARED_QUEUE],
          workerId,
          concurrency: 3,
          pollMs: Number(process.env.WORKHORSE_WORKER_POLL_MS ?? 15_000),
          scheduleNamespaces: ["workhorse-demo"],
        },
        configure(worker) {
          worker
            .handle(LANGUAGE_TASK_TYPE, async (payload, context) => {
              if (payload.language !== "typescript") {
                throw new TypeError("TypeScript worker received a task for another language");
              }
              return { language: "typescript", runtime: "node", attempt: context.task.attempt };
            })
            .handle(SHARED_TASK_TYPE, async (payload, context) => {
              if (typeof payload.source !== "string") {
                throw new TypeError("Shared worker requires a source");
              }
              return { source: payload.source, runtime: "node", attempt: context.task.attempt };
            });
        },
      },
    ],
  });
}

async function verifyDemoWorker(databaseUrl) {
  const runtime = await startWorkerProcess(createDemoWorker(databaseUrl));
  const observer = new Pool({ connectionString: databaseUrl });
  try {
    const queue = new Queue(observer);
    const admin = new Admin(observer);
    const taskIds = await Promise.all([
      queue.enqueue(LANGUAGE_TASK_TYPE, { language: "typescript" }, { queue: TYPESCRIPT_QUEUE }),
      queue.enqueue(SHARED_TASK_TYPE, { source: "typescript-example" }, { queue: SHARED_QUEUE }),
    ]);
    for (let pass = 0; pass < 100; pass += 1) {
      const tasks = await Promise.all(taskIds.map((taskId) => admin.getTask(taskId)));
      if (tasks.every((task) => task?.state === "succeeded")) {
        return { taskIds, results: tasks.map((task) => task.result) };
      }
      const terminalFailure = tasks.find(
        (task) => task?.state === "failed" || task?.state === "canceled",
      );
      if (terminalFailure) throw new Error(`Demo worker task finished in ${terminalFailure.state}`);
      await delay(20);
    }
    throw new Error("Demo worker tasks did not finish");
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
    process.stdout.write(`${JSON.stringify(await verifyDemoWorker(databaseUrl))}\n`);
  } else {
    await runWorkerProcess(createDemoWorker(databaseUrl));
  }
}
