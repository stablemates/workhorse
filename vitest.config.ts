import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);

export const databaseTestFiles = [
  "typescript/demo/test/app.integration.test.ts",
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
        find: "@workhorse-js/core/version",
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
      // Vitest 3 reads worker conditions here with Vite 6 and later, then forwards them to Node.
      // Node 24 cannot use Vite's `module` condition because OpenTelemetry's ESM entry is extensionless.
      conditions: [
        "workhorse-source",
        ...defaultServerConditions.filter((condition) => condition !== "module"),
      ],
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
