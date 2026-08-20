import { defineWorkerProcess } from "@workhorse/core";
import { createDrizzleAdapter } from "@workhorse/drizzle";
import { Pool } from "pg";
import {
  DEMO_QUEUE,
  DEMO_RATE_LIMIT_QUEUE,
  DEMO_SCHEDULE_NAMESPACE,
  DEMO_WORKER_CONCURRENCY,
  DEMO_WORKER_POLL_MS,
} from "./constants.js";
import { DEMO_QUEUE_OPTIONS } from "./contracts.js";
import { createDemoDatabase } from "./database.js";
import { resolveDemoDatabaseUrl } from "./environment.js";
import { demoLogger } from "./logger.js";
import { createDemoWorkerDefinition } from "./worker-definition.js";

/**
 * The demo's dedicated worker process.
 *
 * This is the production topology the documentation recommends: workers own their own process,
 * their own connection pool, and their own lifecycle, and share nothing with the web tier except
 * PostgreSQL. Run it with `workhorse worker --config <compiled module>`.
 *
 * The launcher starts this definition once per profile, so every worker owns a separate process
 * and pool. Both profiles serve the ordinary and rate-limited queues so the fleet demonstrates
 * queue rotation and claim distribution under shared PostgreSQL policies.
 */
const databaseUrl = resolveDemoDatabaseUrl();
const workerPollMs = process.env.WORKHORSE_WORKER_POLL_MS
  ? Number(process.env.WORKHORSE_WORKER_POLL_MS)
  : DEMO_WORKER_POLL_MS;
const profiles = {
  one: {
    queues: [DEMO_QUEUE, DEMO_RATE_LIMIT_QUEUE],
    concurrency: DEMO_WORKER_CONCURRENCY[0],
    scheduleNamespaces: [DEMO_SCHEDULE_NAMESPACE],
  },
  two: {
    queues: [DEMO_QUEUE, DEMO_RATE_LIMIT_QUEUE],
    concurrency: DEMO_WORKER_CONCURRENCY[1],
    scheduleNamespaces: [DEMO_SCHEDULE_NAMESPACE],
  },
} as const;
const profileName = process.env.WORKHORSE_DEMO_WORKER_PROFILE;
const profile = profileName === "one" || profileName === "two" ? profiles[profileName] : undefined;
if (!profile) {
  throw new Error("WORKHORSE_DEMO_WORKER_PROFILE must select a configured worker profile");
}

const pool = new Pool({ connectionString: databaseUrl, max: 10 });
const database = createDemoDatabase(pool);
const adapter = createDrizzleAdapter(database, {
  defaultQueue: DEMO_QUEUE,
  queueOptions: DEMO_QUEUE_OPTIONS,
  close: () => pool.end(),
});

export default defineWorkerProcess({
  adapter: () => adapter,
  workers: [
    createDemoWorkerDefinition(database, adapter.queue, {
      queues: profile.queues,
      concurrency: profile.concurrency,
      scheduleNamespaces: profile.scheduleNamespaces,
      pollMs: workerPollMs,
      onRegistrationError: (error) =>
        demoLogger.error(
          "workhorse.demo.worker_registration_failed",
          "Worker registration failed; the fleet view will not show this worker",
          error,
        ),
    }),
  ],
  logger: {
    info: (message) => demoLogger.info("workhorse.demo.worker_process", message),
    error: (message, error) =>
      demoLogger.error("workhorse.demo.worker_process_error", message, error),
  },
});
