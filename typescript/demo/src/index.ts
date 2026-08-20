import { getRequestListener } from "@hono/node-server";
import { assertSchemaCompatible, installSchema } from "@workhorse-js/core";
import { createServer } from "node:http";
import { Pool } from "pg";
import {
  assertDemoSchemaCompatible,
  createDemoApplication,
  createLocalOperator,
  createLocalOperatorControllers,
  createLocalScheduleController,
  installDemoSchema,
  seedDemoData,
  syncDemoConcurrencyPolicies,
  syncDemoRateLimitPolicies,
  syncDemoSchedules,
} from "./app.js";
import { createDemoDatabase } from "./database.js";
import { createDashboardDevServer } from "@workhorse-js/dashboard/dev";
import { resolveDemoDatabaseUrl } from "./environment.js";
import { startDemoMetricsObserver } from "./telemetry.js";
import { demoLogger } from "./logger.js";
import { prepareApplicationSchema } from "./schema-preparation.js";

/**
 * The demo's web tier.
 *
 * This process serves the application and mounts the dashboard. It deliberately runs **no**
 * workers: those live in `worker.ts` and are started as a dedicated process. Everything the
 * dashboard shows is therefore read from PostgreSQL on a bounded polling interval, which is the
 * same constraint a real deployment operates under.
 *
 * It serves the dashboard from `@workhorse-js/dashboard`, exactly as any consumer would. In
 * development it additionally runs that package's Vite middleware, so the same origin serves the
 * live-compiled UI with hot reload while the HTML still goes through the packaged host. There is no
 * second server and no second URL.
 *
 */
const databaseUrl = resolveDemoDatabaseUrl();
const mode = process.env.WORKHORSE_DEMO_MODE ?? "production";
if (mode !== "development" && mode !== "production") {
  throw new Error("WORKHORSE_DEMO_MODE must be either development or production");
}
const port = Number(process.env.PORT ?? 3000);
const environment = process.env.WORKHORSE_DEMO_ENV ?? "development";
const pool = new Pool({ connectionString: databaseUrl, max: 10 });

// A provisioned staging database turns the dashboard into two switchable workspaces: the busy
// worker-driven "production" one, and a quiet seeded "staging" one that no worker ever touches.
// Without the variable the demo keeps its familiar single-workspace URLs.
const stagingDatabaseUrl = process.env.WORKHORSE_DEMO_STAGING_DATABASE_URL;
const stagingPool = stagingDatabaseUrl
  ? new Pool({ connectionString: stagingDatabaseUrl, max: 3 })
  : undefined;
if (stagingPool) {
  demoLogger.info(
    "workhorse.demo.workspaces_enabled",
    "Dashboard serves the busy production workspace and the quiet staging workspace",
    { "workhorse.demo.workspace_names": ["production", "staging"] },
  );
} else {
  demoLogger.info(
    "workhorse.demo.single_workspace_fallback",
    "WORKHORSE_DEMO_STAGING_DATABASE_URL is not set; the dashboard serves a single workspace and renders no workspace switcher",
  );
}

const database = createDemoDatabase(pool);
const stagingDatabase = stagingPool ? createDemoDatabase(stagingPool) : undefined;
const localOperatorControllers = createLocalOperatorControllers(database);

await prepareApplicationSchema(mode, {
  assertCompatible: () => assertSchemaCompatible(pool),
  assertDemoCompatible: () => assertDemoSchemaCompatible(database),
  install: () => installSchema(pool),
  installDemo: () => installDemoSchema(database),
});
if (stagingPool && stagingDatabase) {
  await prepareApplicationSchema(mode, {
    assertCompatible: () => assertSchemaCompatible(stagingPool),
    assertDemoCompatible: () => assertDemoSchemaCompatible(stagingDatabase),
    install: () => installSchema(stagingPool),
    installDemo: () => installDemoSchema(stagingDatabase),
  });
}
await syncDemoSchedules(pool);
await syncDemoConcurrencyPolicies(pool);
await syncDemoRateLimitPolicies(pool);
demoLogger.info(
  "workhorse.demo.schedules_synchronized",
  "Synchronized recurring demo schedules for worker-owned execution",
);
demoLogger.info(
  "workhorse.demo.rate_limit_policies_synchronized",
  "Synchronized demo start-rate policies",
);
demoLogger.info(
  "workhorse.demo.concurrency_policies_synchronized",
  "Synchronized fleet-wide demo concurrency policies",
);

// Development compiles the dashboard from source in this process. Production serves the packaged
// bundle. Both render the page through the same host, so only module delivery differs.
const dashboardDev = mode === "development" ? await createDashboardDevServer() : undefined;

// Optional dashboard authentication. When both credentials are configured, the demo serves the
// packaged single-administrator login instead of its default open access.
const adminUsername = process.env.WORKHORSE_DEMO_ADMIN_USERNAME;
const adminPasswordHash = process.env.WORKHORSE_DEMO_ADMIN_PASSWORD_HASH;
if ((adminUsername === undefined) !== (adminPasswordHash === undefined)) {
  throw new Error(
    "WORKHORSE_DEMO_ADMIN_USERNAME and WORKHORSE_DEMO_ADMIN_PASSWORD_HASH must be set together",
  );
}

const { app } = createDemoApplication(database, {
  dev: dashboardDev,
  environment,
  operator: createLocalOperator(database),
  publicOrigin: process.env.WORKHORSE_DEMO_PUBLIC_ORIGIN,
  queueController: localOperatorControllers.queueController,
  scheduleController: createLocalScheduleController(database),
  ...(adminUsername && adminPasswordHash
    ? { singleAdmin: { username: adminUsername, passwordHash: adminPasswordHash } }
    : {}),
  stagingDatabase,
});
const metricsObserver = startDemoMetricsObserver(pool);
if (process.env.SEED_DEMO_DATA !== "false") {
  const seed = await seedDemoData(database);
  demoLogger.info(
    seed.seeded ? "workhorse.demo.seeded" : "workhorse.demo.seed_reused",
    seed.seeded ? "Seeded demo data" : "Live showcase and historical demo data already exist",
    {
      "workhorse.demo.live_job_count": seed.jobIds.length,
      "workhorse.demo.historical_job_count": seed.historicalJobCount,
    },
  );
  if (stagingDatabase) {
    // Staging gets the same seed but no schedules, policies, or workers, so it stays a readable
    // snapshot instead of a second live system.
    const stagingSeed = await seedDemoData(stagingDatabase);
    demoLogger.info(
      stagingSeed.seeded ? "workhorse.demo.staging_seeded" : "workhorse.demo.staging_seed_reused",
      stagingSeed.seeded
        ? "Seeded staging workspace data"
        : "Staging workspace data already exists",
    );
  }
}
const application = getRequestListener(app.fetch);
const server = createServer((request, response) => {
  const next = (error?: unknown) => {
    if (error) {
      response.statusCode = 500;
      response.end("Internal Server Error");
      return;
    }
    application(request, response);
  };
  if (dashboardDev) dashboardDev.middlewares(request, response, next);
  else next();
});
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, () => {
    server.removeListener("error", reject);
    resolve();
  });
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("Demo server did not bind a TCP port");
demoLogger.info("workhorse.demo.listening", "Workhorse demo server listening", {
  "server.address": process.env.PORTLESS_URL ?? `http://localhost:${address.port}`,
  "server.port": address.port,
});
demoLogger.info("workhorse.demo.worker_topology", "Workers run as a separate process", {
  "workhorse.demo.worker_topology": "dedicated_process",
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  demoLogger.info("workhorse.demo.shutdown_started", "Demo shutdown started", {
    "process.signal": signal,
  });
  metricsObserver?.stop();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await Promise.all([pool.end(), stagingPool?.end(), dashboardDev?.close()]);
  demoLogger.info("workhorse.demo.shutdown_completed", "Demo shutdown completed");
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
