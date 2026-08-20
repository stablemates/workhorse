import { runWorkerProcess } from "@workhorse-js/core";
import definition from "./worker.js";

/**
 * Development entry point for the demo's dedicated worker process.
 *
 * The packaged `workhorse worker --config <compiled-module>` CLI is the deployment path and is
 * what `pnpm --filter @workhorse-js/demo start:worker` uses. This module exists so the same
 * definition can run straight from TypeScript sources under `tsx` during development.
 */
await runWorkerProcess(definition);
