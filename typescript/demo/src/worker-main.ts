import { assertSchemaCompatible, runWorkerProcess } from "@stablemates/workhorse";
import { Pool } from "pg";
import { resolveDemoDatabaseUrl } from "./environment.js";
import { demoLogger } from "./logger.js";
import { awaitWorkerSchema } from "./schema-preparation.js";
import definition from "./worker.js";

/**
 * Development entry point for the demo's dedicated worker process.
 *
 * The packaged `workhorse worker --config <compiled-module>` CLI is the deployment path and is
 * what `pnpm --filter @stablemates/workhorse-demo start:worker` uses. This module exists so the same
 * definition can run straight from TypeScript sources under `tsx` during development.
 *
 * The launcher starts this process beside the server, which installs the schema of an empty
 * development database. The wait runs before `runWorkerProcess` takes over the termination signals,
 * so a signal still ends a waiting process at once.
 */
const mode = process.env.WORKHORSE_DEMO_MODE ?? "production";
if (mode !== "development" && mode !== "production") {
  throw new Error("WORKHORSE_DEMO_MODE must be either development or production");
}
const schemaPool = new Pool({ connectionString: resolveDemoDatabaseUrl(), max: 1 });
try {
  await awaitWorkerSchema(
    mode,
    () => assertSchemaCompatible(schemaPool),
    () =>
      demoLogger.info(
        "workhorse.demo.worker_schema_wait",
        "Waiting for the demo server to install the Workhorse schema",
      ),
  );
} finally {
  await schemaPool.end();
}
await runWorkerProcess(definition);
