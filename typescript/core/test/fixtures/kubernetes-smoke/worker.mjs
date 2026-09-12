import { setTimeout as sleep } from "node:timers/promises";
import { createWorkhorseAdapter, defineWorkerProcess, Pool } from "@stablemates/workhorse";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });

export default defineWorkerProcess({
  adapter() {
    return createWorkhorseAdapter({
      database: pool,
      adaptTransaction: (transaction) => transaction,
      close: () => pool.end(),
    });
  },
  workers: [
    {
      options: {
        queue: "kubernetes-smoke",
        concurrency: 1,
        pollMs: 100,
        registryIntervalMs: 100,
      },
      configure(worker) {
        worker.handle("smoke.drain", async ({ durationMs }) => {
          process.stdout.write(`SMOKE_HANDLER_STARTED ${process.env.HOSTNAME}\n`);
          await sleep(durationMs);
          process.stdout.write(`SMOKE_HANDLER_FINISHED ${process.env.HOSTNAME}\n`);
          return { drainedBy: process.env.HOSTNAME };
        });
      },
    },
  ],
  probes: {
    hostname: "0.0.0.0",
    port: 9090,
  },
});
