import { serveWithWorkhorse } from "@workhorse/hono";
import { installSchema } from "@workhorse/core";
import { Pool } from "pg";
import {
  createDemoApplication,
  createLocalOperator,
  createLocalQueueController,
  createLocalScheduleController,
  installDemoSchema,
  seedDemoData,
  syncDemoSchedules,
} from "./app.js";
import { createDemoDatabase } from "./database.js";
import { createDashboardDevServer } from "@workhorse/dashboard/dev";
import { resolveDemoDatabaseUrl } from "./environment.js";
import { startDemoMetricsObserver } from "./telemetry.js";

/**
 * The demo's web tier.
 *
 * This process serves the application and mounts the dashboard. It deliberately runs **no**
 * workers: those live in `worker.ts` and are started as a dedicated process. Everything the
 * dashboard shows is therefore read from PostgreSQL on a bounded polling interval, which is the
 * same constraint a real deployment operates under.
 *
 * It serves the dashboard from `@workhorse/dashboard`, exactly as any consumer would. In
 * development it additionally runs that package's Vite middleware, so the same origin serves the
 * live-compiled UI with hot reload while the HTML still goes through the packaged host. There is no
 * second server and no second URL.
 *
 * Set WORKHORSE_DEMO_IN_PROCESS_WORKERS=true to co-host workers here instead, which is the
 * supported small-application topology.
 */
const databaseUrl = resolveDemoDatabaseUrl();
const mode = process.env.WORKHORSE_DEMO_MODE ?? "production";
if (mode !== "development" && mode !== "production") {
  throw new Error("WORKHORSE_DEMO_MODE must be either development or production");
}
const port = Number(process.env.PORT ?? 3000);
const environment = process.env.WORKHORSE_ENV ?? mode;
const inProcessWorkers = process.env.WORKHORSE_DEMO_IN_PROCESS_WORKERS === "true";
const pool = new Pool({ connectionString: databaseUrl, max: 10 });

const database = createDemoDatabase(pool);

await installSchema(pool);
await installDemoSchema(database);
await syncDemoSchedules(pool);
console.log("Synchronized recurring demo schedules for worker-owned execution");
const metricsObserver = startDemoMetricsObserver(pool);

// Development compiles the dashboard from source in this process. Production serves the packaged
// bundle. Both render the page through the same host, so only module delivery differs.
const dashboardDev = mode === "development" ? await createDashboardDevServer() : undefined;

const { app, workhorse } = createDemoApplication(database, {
  dev: dashboardDev,
  environment,
  workers: inProcessWorkers,
  operator: createLocalOperator(database),
  queueController: createLocalQueueController(database),
  scheduleController: createLocalScheduleController(database),
  close: () => pool.end(),
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
  // Vite's module and hot-reload routes run before the application, and fall through to it for
  // everything they do not own.
  ...(dashboardDev ? { nodeMiddleware: dashboardDev.middlewares } : {}),
  onListen: ({ port: listeningPort }) => {
    console.log(
      process.env.PORTLESS_URL
        ? `Workhorse demo available at ${process.env.PORTLESS_URL}`
        : `Workhorse demo listening on http://localhost:${listeningPort}`,
    );
  },
});
console.log(
  inProcessWorkers
    ? "Workers are co-hosted in this process"
    : "Workers run as a separate process; start them with the demo worker entry point",
);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down`);
  metricsObserver?.stop();
  await running.shutdown();
  await dashboardDev?.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
