import { serveWithWorkhorse } from "@workhorse/hono";
import { installSchema } from "@workhorse/core";
import { Client, Pool } from "pg";
import {
  createDemoApplication,
  createDemoDatabase,
  createLocalOperator,
  createLocalQueueController,
  createLocalScheduleController,
  installDemoSchema,
  seedDemoData,
  syncDemoSchedules,
} from "./app.js";
import { DashboardRefreshHub } from "@workhorse/dashboard/server";
import { requireDevelopmentApiPort } from "./development-port.js";
import { resolveDemoDatabaseUrl } from "./environment.js";

const databaseUrl = resolveDemoDatabaseUrl();
const mode = process.env.WORKHORSE_DEMO_MODE ?? "production";
if (mode !== "development" && mode !== "production") {
  throw new Error("WORKHORSE_DEMO_MODE must be either development or production");
}
const port =
  mode === "development"
    ? requireDevelopmentApiPort(process.env.WORKHORSE_API_PORT)
    : Number(process.env.PORT ?? 3000);
const environment = process.env.WORKHORSE_ENV ?? mode;
const workerPollMs = process.env.WORKHORSE_WORKER_POLL_MS
  ? Number(process.env.WORKHORSE_WORKER_POLL_MS)
  : undefined;
const pool = new Pool({ connectionString: databaseUrl, max: 10 });

const database = createDemoDatabase(pool);
const dashboardRefresh = new DashboardRefreshHub();
const notificationClient = new Client({ connectionString: databaseUrl });

await installSchema(pool);
await installDemoSchema(database);
await syncDemoSchedules(pool);
console.log("Synchronized recurring demo schedules for worker-owned execution");
await notificationClient.connect();
await notificationClient.query("LISTEN workhorse_jobs");
notificationClient.on("notification", () => dashboardRefresh.publish("postgres"));
notificationClient.on("error", (error) => {
  console.error("Dashboard notification listener stopped; SSE fallback remains active", error);
});

const { app, workhorse } = createDemoApplication(database, {
  dashboardRefresh,
  environment,
  operator: createLocalOperator(database),
  queueController: createLocalQueueController(database),
  scheduleController: createLocalScheduleController(database),
  workerPollMs,
  close: async () => {
    await notificationClient.end();
    await pool.end();
  },
  onWorkerError: (error) => console.error("Workhorse worker stopped", error),
});
if (process.env.SEED_DEMO_DATA !== "false") {
  const seed = await seedDemoData(database);
  console.log(
    seed.seeded
      ? `Seeded ${seed.jobIds.length} live showcase and ${seed.historicalJobCount} historical demo jobs`
      : "Live showcase and historical demo data already exist",
  );
}
const running = await serveWithWorkhorse({
  fetch: app.fetch,
  workhorse,
  port,
  onListen: ({ port: listeningPort }) => {
    if (process.env.PORTLESS_URL) {
      console.log(`Workhorse demo available at ${process.env.PORTLESS_URL}`);
      console.log(`Internal API listening on http://localhost:${listeningPort}`);
    } else {
      console.log(`Workhorse demo listening on http://localhost:${listeningPort}`);
    }
  },
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down`);
  await running.shutdown();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
