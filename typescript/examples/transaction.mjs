import { pathToFileURL } from "node:url";
import path from "node:path";
import { Pool, Queue } from "@stablemates/workhorse";

export async function enqueueInTransaction(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const jobId = await new Queue(client, "orders").enqueue(
      "order.accepted",
      { orderId: "order-42" },
      {
        maxAttempts: 3,
        retryPolicy: {
          type: "exponential",
          initialDelayMs: 1_000,
          multiplier: 2,
          maxDelayMs: 60_000,
        },
      },
    );
    await client.query("COMMIT");
    return jobId;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (import.meta.url === invokedPath) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  process.stdout.write(`${await enqueueInTransaction(databaseUrl)}\n`);
}
