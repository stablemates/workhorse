import { pathToFileURL } from "node:url";
import path from "node:path";
import { Admin, Pool, Queue, Worker } from "@stablemates/workhorse";

export async function runQuickstart(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const queue = new Queue(pool);
    const admin = new Admin(pool);
    const worker = new Worker(queue, { workerId: "quickstart-worker" }).handle(
      "welcome.send",
      async (payload) => ({ message: `Welcome, ${payload.name}!` }),
    );
    const jobId = await queue.enqueue("welcome.send", { name: "Ada" });
    await worker.runOnce();
    const job = await admin.getJob(jobId);
    if (job?.state !== "succeeded") throw new Error(`Quickstart job finished in ${job?.state}`);
    return { jobId, result: job.result };
  } finally {
    await pool.end();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (import.meta.url === invokedPath) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  process.stdout.write(`${JSON.stringify(await runQuickstart(databaseUrl))}\n`);
}
