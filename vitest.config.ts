import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      ironshift: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
    },
  },
  test: {
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    sequence: { concurrent: false },
  },
});
