import { serveWithWorkhorse } from "@workhorse/hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { installSchema } from "@workhorse/core";
import type { PgCronScheduler } from "@workhorse/core";
import { Client, Pool } from "pg";
import {
  createDemoApplication,
  createDemoDatabase,
  createLocalOperator,
  createLocalScheduleController,
  createPgCronSchedulerStatusProvider,
  installDemoSchema,
  seedDemoData,
  syncDemoSchedules,
} from "./app.js";
import { DashboardRefreshHub } from "./dashboard-refresh.js";

const databaseUrl =
  process.env.DATABASE_URL ??
  process.env.WORKHORSE_DEMO_DATABASE_URL ??
  "postgresql://workhorse:workhorse@localhost:5432/workhorse_demo";
const port = Number(process.env.PORT ?? 3000);
const workerPollMs = process.env.WORKHORSE_WORKER_POLL_MS
  ? Number(process.env.WORKHORSE_WORKER_POLL_MS)
  : undefined;
const pool = new Pool({ connectionString: databaseUrl, max: 10 });

function deriveMaintenanceDatabaseUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    parsed.pathname = "/postgres";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

const cronDatabaseUrl = process.env.CRON_DATABASE_URL ?? deriveMaintenanceDatabaseUrl(databaseUrl);
const cronPool = cronDatabaseUrl
  ? new Pool({ connectionString: cronDatabaseUrl, max: 2 })
  : undefined;
const database = createDemoDatabase(pool);
const dashboardRefresh = new DashboardRefreshHub();
const notificationClient = new Client({ connectionString: databaseUrl });

await installSchema(pool);
await installDemoSchema(database);
let demoScheduler: PgCronScheduler | undefined;
if (cronPool) {
  try {
    const { result, scheduler } = await syncDemoSchedules(pool, cronPool);
    demoScheduler = scheduler;
    console.log(
      `Synchronized ${result.schedules.length} recurring demo schedule in ${result.namespace}`,
    );
  } catch (error) {
    console.warn(
      "Recurring demo schedule synchronization is unavailable; continuing without pg_cron",
      error,
    );
  }
} else {
  console.warn(
    "Could not derive CRON_DATABASE_URL; recurring demo schedule synchronization is disabled",
  );
}
await notificationClient.connect();
await notificationClient.query("LISTEN workhorse_jobs");
notificationClient.on("notification", () => dashboardRefresh.publish("postgres"));
notificationClient.on("error", (error) => {
  console.error("Dashboard notification listener stopped; SSE fallback remains active", error);
});

const { app, workhorse } = createDemoApplication(database, {
  dashboardRefresh,
  operator: createLocalOperator(database),
  scheduleController: createLocalScheduleController(database, demoScheduler),
  schedulerStatusProvider: createPgCronSchedulerStatusProvider(demoScheduler),
  workerMaintenance: demoScheduler ? "external" : "worker",
  workerPollMs,
  close: async () => {
    await notificationClient.end();
    await cronPool?.end();
    await pool.end();
  },
  onWorkerError: (error) => console.error("Workhorse worker stopped", error),
});
app.use("/assets/*", serveStatic({ root: "./dist/dashboard" }));
const serveDashboard = serveStatic({
  root: "./dist/dashboard",
  rewriteRequestPath: () => "/index.html",
});
for (const route of ["/tasks", "/cron", "/system", "/workers"]) {
  app.get(route, serveDashboard);
}
if (process.env.SEED_DEMO_DATA !== "false") {
  const seed = await seedDemoData(database, app);
  console.log(
    seed.seeded
      ? `Seeded ${seed.jobIds.length} representative demo jobs`
      : "Representative demo data already exists",
  );
}
const running = await serveWithWorkhorse({
  fetch: app.fetch,
  workhorse,
  port,
  onListen: ({ port: listeningPort }) => {
    console.log(`Workhorse demo listening on http://localhost:${listeningPort}`);
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
