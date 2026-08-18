import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export const databaseTestFiles = [
  "typescript/demo/test/app.integration.test.ts",
  "typescript/*/test/integration.test.ts",
  "typescript/dashboard-server/test/conformance.test.ts",
  "typescript/core/test/benchmark-conventional.test.ts",
  "typescript/core/test/integration-*.test.ts",
  "typescript/core/test/isolation-canary-*.test.ts",
  "typescript/core/test/sql-protocol-conformance.test.ts",
  "typescript/core/test/schema-installation.test.ts",
  "typescript/core/test/schema-migrations.test.ts",
];

export default defineConfig({
  resolve: {
    alias: {
      workhorse: fileURLToPath(new URL("./typescript/core/src/index.ts", import.meta.url)),
    },
  },
  test: {
    // Files run in parallel because no two files share mutable state. Every database-backed suite
    // gets its own database from test/support/db.ts, keyed by file URL and process id; the demo
    // suite is the sole user of the checkout's shared test database; the rest touch no database.
    // The isolation-canary-*.test.ts pair exists to fail this assumption loudly: if two files ever
    // observe each other's rows, restore `fileParallelism: false` and find the leak before
    // re-enabling. Tests within one file still run serially — a file shares one pool and one
    // schema-installed database across its cases.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    sequence: { concurrent: false },
  },
});
