import { createRequire } from "node:module";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);

/**
 * Workers to run test files in, floored so the count never collapses to one.
 *
 * Vitest sizes its pool at `availableParallelism() - 1`. On a two-core runner that is a single
 * worker, and the suite then runs every file in sequence no matter what this file says about
 * parallelism. The floor holds the count up when the core count is small; a developer machine
 * keeps its own larger count.
 *
 * The floor stays below the lane's core count on purpose. These files wait on PostgreSQL round
 * trips rather than on the CPU, so extra workers do shorten the run, but they also spawn the
 * admin CLI and the Go and Python conformance fixtures as child processes, and they drive a
 * PostgreSQL that wants a core of its own. Starving those turns this suite's timing assertions
 * into flakes rather than failures.
 */
const workerFloor = 3;
const maxWorkers = Math.max(availableParallelism() - 1, workerFloor);

export const databaseTestFiles = [
  "scripts/*-integration.test.ts",
  "typescript/demo/test/*.integration.test.ts",
  "typescript/*/test/*-integration.test.ts",
  "typescript/*/test/*conformance.test.ts",
  "typescript/*/test/integration.test.ts",
  "typescript/core/test/benchmark-conventional.test.ts",
  "typescript/core/test/integration-*.test.ts",
  "typescript/core/test/isolation-canary-*.test.ts",
  "typescript/core/test/schema-installation.test.ts",
  "typescript/core/test/schema-migrations.test.ts",
];

export default defineConfig({
  resolve: {
    conditions: ["workhorse-source", ...defaultServerConditions],
    alias: [
      {
        find: "@stablemates/workhorse/version",
        replacement: fileURLToPath(new URL("./typescript/core/src/version.ts", import.meta.url)),
      },
      {
        find: "workhorse",
        replacement: fileURLToPath(new URL("./typescript/core/src/index.ts", import.meta.url)),
      },
      // The repository's `typescript/` source directory shadows the TypeScript package when the
      // `vitest related` import crawl falls back to root-relative resolution for the bare import
      // in typescript/dashboard-server/spec/response-schemas.ts, so pin the installed package.
      { find: /^typescript$/, replacement: require.resolve("typescript") },
    ],
  },
  ssr: {
    resolve: {
      // Vitest reads worker conditions here with Vite 6 and later, then forwards them to Node.
      // Node 24 cannot use Vite's `module` condition because OpenTelemetry's ESM entry is extensionless.
      conditions: [
        "workhorse-source",
        ...defaultServerConditions.filter((condition) => condition !== "module"),
      ],
    },
  },
  test: {
    // Files run in parallel because no two files share mutable state. Every database-backed suite
    // gets its own database from test/support/db.ts, keyed by file URL and process id, including
    // each piece of the demo suite; the rest touch no database.
    // The isolation-canary-*.test.ts pair exists to fail this assumption loudly: if two files ever
    // observe each other's rows, restore `fileParallelism: false` and find the leak before
    // re-enabling. Tests within one file still run serially — a file shares one pool and one
    // schema-installed database across its cases.
    // Vitest 4 no longer excludes dist by default; compiled output must not be collected twice.
    exclude: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
    // Stated rather than inferred: the default derives from the core count, so a two-core runner
    // silently serializes the whole suite while the note above still claims parallelism. SM-835.
    maxWorkers,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    sequence: { concurrent: false },
  },
});
